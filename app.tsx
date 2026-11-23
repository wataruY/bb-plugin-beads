// bb-plugin-beads frontend: a "Beads issues" tab in the thread side panel
// showing the issue graph of the thread's environment checkout.
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_DetailRow as DetailRow,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useTabVisible,
  experimental_VoiceInputTextarea as VoiceInputTextarea,
  Markdown,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import {
  Bug,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownRight,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Timer,
  User,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_ATTACHMENT_BYTES,
  PANEL_LAYOUTS,
  rpcContract,
  type BdIssueNode,
  type IssueDraft,
  type IssuesCheckout,
  type PanelLayout,
} from "./contract.js";

type IssueShow = {
  id: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  design?: string;
  notes?: string;
  created_at?: string;
  created_by?: string;
  // int64 as a decimal string; guards edits against concurrent writes.
  revision?: string;
};

// ---------------------------------------------------------------------------
// Domain model: one index over the `issues_tree` rows, shared by every layout
// and by the detail pane's relation lists.

type Status = "open" | "in_progress" | "blocked" | "deferred" | "closed";

type IssueIndex = {
  byId: Map<string, BdIssueNode>;
  roots: BdIssueNode[];
  children: Map<string, BdIssueNode[]>;
  // Reverse of `blockedBy`: issue id -> the issues waiting on it.
  blocks: Map<string, BdIssueNode[]>;
  // Labels every issue carries say nothing in a row; show them only in detail.
  sharedLabels: Set<string>;
};

function compareIssues(a: BdIssueNode, b: BdIssueNode): number {
  return (
    Number(a.status === "closed") - Number(b.status === "closed") ||
    a.priority - b.priority ||
    a.title.localeCompare(b.title)
  );
}

function buildIndex(issues: BdIssueNode[]): IssueIndex {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const roots: BdIssueNode[] = [];
  const children = new Map<string, BdIssueNode[]>();
  const blocks = new Map<string, BdIssueNode[]>();
  const push = (map: Map<string, BdIssueNode[]>, key: string, issue: BdIssueNode): void => {
    const list = map.get(key);
    if (list) list.push(issue);
    else map.set(key, [issue]);
  };
  for (const issue of issues) {
    if (issue.parent !== null && byId.has(issue.parent)) push(children, issue.parent, issue);
    else roots.push(issue);
    for (const target of issue.blockedBy) push(blocks, target, issue);
  }
  roots.sort(compareIssues);
  for (const list of children.values()) list.sort(compareIssues);
  for (const list of blocks.values()) list.sort(compareIssues);
  const sharedLabels = new Set(issues[0]?.labels ?? []);
  for (const issue of issues) {
    for (const label of sharedLabels) {
      if (!issue.labels.includes(label)) sharedLabels.delete(label);
    }
  }
  if (issues.length < 2) sharedLabels.clear();
  return { byId, roots, children, blocks, sharedLabels };
}

function effectiveStatus(issue: BdIssueNode, index: IssueIndex): Status {
  if (issue.status === "closed") return "closed";
  const waiting = issue.blockedBy.some(
    (id) => (index.byId.get(id)?.status ?? "open") !== "closed",
  );
  if (waiting || issue.status === "blocked") return "blocked";
  if (issue.status === "in_progress" || issue.status === "deferred") return issue.status;
  return "open";
}

function descendantProgress(id: string, index: IssueIndex): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const walk = (parentId: string): void => {
    for (const kid of index.children.get(parentId) ?? []) {
      total += 1;
      if (kid.status === "closed") done += 1;
      walk(kid.id);
    }
  };
  walk(id);
  return { done, total };
}

function parseLayout(value: unknown): PanelLayout {
  return PANEL_LAYOUTS.find((layout) => layout === value) ?? "split";
}

// ---------------------------------------------------------------------------
// Formatting

const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  deferred: "Deferred",
  closed: "Closed",
};

const PRIORITY_LABEL = ["Critical", "High", "Medium", "Low", "Backlog"];

// Theme variables instead of Tailwind palette classes: they follow bb's theme
// and light/dark mode, and need no generated utility class.
const PRIORITY_COLOR = [
  "var(--destructive-text)",
  "var(--warning)",
  "var(--muted-foreground)",
  "var(--subtle-foreground)",
  "var(--subtle-foreground)",
];

function priorityColor(priority: number): string {
  return PRIORITY_COLOR[priority] ?? "var(--muted-foreground)";
}

function formatRelative(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const seconds = (Date.now() - time) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDay(iso: string | null | undefined, withYear = false): string {
  if (iso == null || iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

function formatMinutes(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function checklistProgress(markdown: string): { done: number; total: number } {
  const boxes = markdown.match(/^\s*[-*]\s*\[[ xX]\]/gm) ?? [];
  const done = boxes.filter((box) => /\[[xX]\]/.test(box)).length;
  return { done, total: boxes.length };
}

// ---------------------------------------------------------------------------
// Glyphs

// Shape carries the status and colour reinforces it, so it reads without
// colour vision too.
function StatusGlyph({ status, size = 14 }: { status: Status; size?: number }) {
  const color = {
    open: "var(--muted-foreground)",
    in_progress: "var(--timeline-accent)",
    blocked: "var(--destructive-text)",
    deferred: "var(--subtle-foreground)",
    closed: "var(--success)",
  }[status];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className="shrink-0"
      role="img"
      aria-label={STATUS_LABEL[status]}
    >
      {status === "closed" ? (
        <>
          <circle cx="8" cy="8" r="7" fill={color} />
          <path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--background)" strokeWidth="1.6" />
        </>
      ) : (
        <>
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray={status === "deferred" ? "2.2 2" : undefined}
          />
          {status === "in_progress" && <path d="M8 4a4 4 0 0 1 0 8z" fill={color} />}
          {status === "blocked" && <path d="M4 12 12 4" stroke={color} strokeWidth="1.5" />}
        </>
      )}
    </svg>
  );
}

function TypeGlyph({ type }: { type: string }) {
  if (type === "epic") {
    return (
      <Layers
        className="h-3 w-3 shrink-0"
        style={{ color: "var(--pr-merged)" }}
        aria-label="Epic"
      />
    );
  }
  if (type === "bug") {
    return (
      <Bug
        className="h-3 w-3 shrink-0"
        style={{ color: "var(--destructive-text)" }}
        aria-label="Bug"
      />
    );
  }
  return null;
}

function CountPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-surface-recessed px-1.5 text-xs leading-4 text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// List rows

// Touch sizing: `pointer-coarse:` follows the input device, not the viewport, so a
// phone gets 44px targets and a mouse keeps the dense desktop rhythm.
const ROW_BASE =
  "mx-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:mx-2 pointer-coarse:h-11 pointer-coarse:gap-2 pointer-coarse:pr-3 pointer-coarse:text-[13px]";

// Safe-area aware bottom padding for scroll content on notched phones.
const SCROLL_END = "pb-[max(1.5rem,env(safe-area-inset-bottom))]";

function IssueRowContent({
  issue,
  index,
  showParent,
}: {
  issue: BdIssueNode;
  index: IssueIndex;
  showParent: boolean;
}) {
  const status = effectiveStatus(issue, index);
  const progress = descendantProgress(issue.id, index);
  const extraLabel = issue.labels.find((label) => !index.sharedLabels.has(label));
  const parentTitle =
    showParent && issue.parent !== null ? index.byId.get(issue.parent)?.title : undefined;
  return (
    <>
      <StatusGlyph status={status} />
      <TypeGlyph type={issue.type} />
      <span
        className={
          "min-w-0 flex-1 truncate " +
          (status === "closed" ? "text-subtle-foreground" : "text-foreground") +
          (progress.total > 0 ? " font-medium" : "")
        }
        title={issue.title}
      >
        {issue.title}
      </span>
      {parentTitle !== undefined && (
        <span className="min-w-0 max-w-[40%] shrink truncate text-xs text-subtle-foreground">
          {parentTitle}
        </span>
      )}
      {extraLabel !== undefined && (
        <span className="shrink-0 rounded bg-surface-recessed px-1.5 text-xs leading-4 text-muted-foreground">
          {extraLabel}
        </span>
      )}
      {issue.dueAt !== null && (
        <span className="shrink-0 text-xs text-subtle-foreground tabular-nums" title="Due">
          {formatDay(issue.dueAt)}
        </span>
      )}
      {progress.total > 0 && (
        <span className="shrink-0 text-xs text-subtle-foreground tabular-nums" title="Sub-issues closed">
          {progress.done}/{progress.total}
        </span>
      )}
      {issue.priority <= 1 && (
        <span
          className="shrink-0 text-xs font-semibold tabular-nums"
          style={{ color: priorityColor(issue.priority) }}
        >
          P{issue.priority}
        </span>
      )}
    </>
  );
}

function TreeRow({
  issue,
  depth,
  index,
  selectedId,
  onSelect,
}: {
  issue: BdIssueNode;
  depth: number;
  index: IssueIndex;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const kids = index.children.get(issue.id) ?? [];
  const selected = selectedId === issue.id;
  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={kids.length > 0 ? expanded : undefined}
        tabIndex={0}
        className={ROW_BASE + (selected ? " bg-surface-selected" : " hover:bg-surface-recessed")}
        style={{ paddingLeft: `calc(${depth} * var(--beads-indent, 16px) + 2px)` }}
        onClick={() => onSelect(issue.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSelect(issue.id);
          else if (event.key === "ArrowRight" && kids.length > 0) setExpanded(true);
          else if (event.key === "ArrowLeft" && kids.length > 0) setExpanded(false);
        }}
      >
        {kids.length > 0 ? (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground hover:text-foreground pointer-coarse:-my-2 pointer-coarse:h-11 pointer-coarse:w-9 pointer-coarse:-ml-1.5"
            aria-label={expanded ? "Collapse" : "Expand"}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-4 shrink-0 pointer-coarse:w-7" />
        )}
        <IssueRowContent issue={issue} index={index} showParent={false} />
      </div>
      {expanded &&
        kids.map((kid) => (
          <TreeRow
            key={kid.id}
            issue={kid}
            depth={depth + 1}
            index={index}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

function IssueTree(props: {
  index: IssueIndex;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="tree" aria-label="Issues" className="py-1 [--beads-indent:16px] pointer-coarse:[--beads-indent:14px]">
      {props.index.roots.map((root) => (
        <TreeRow key={root.id} issue={root} depth={0} {...props} />
      ))}
    </div>
  );
}

// Workflow-state groups: what is moving, what is stuck, what can be picked up.
const GROUPS: { status: Status; label: string; collapsedByDefault: boolean }[] = [
  { status: "in_progress", label: "In progress", collapsedByDefault: false },
  { status: "blocked", label: "Blocked", collapsedByDefault: false },
  { status: "open", label: "Ready", collapsedByDefault: false },
  { status: "deferred", label: "Deferred", collapsedByDefault: true },
  { status: "closed", label: "Closed", collapsedByDefault: true },
];

function GroupedList({
  index,
  selectedId,
  onSelect,
}: {
  index: IssueIndex;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [toggled, setToggled] = useState<Set<Status>>(new Set());
  // Epics are containers, not work items; their children carry them as a crumb.
  const items = [...index.byId.values()].filter((issue) => issue.type !== "epic");
  return (
    <div className="py-1">
      {GROUPS.map((group) => {
        const members = items
          .filter((issue) => effectiveStatus(issue, index) === group.status)
          .sort(compareIssues);
        if (members.length === 0) return null;
        const collapsed = group.collapsedByDefault !== toggled.has(group.status);
        return (
          <section key={group.status}>
            <button
              className="flex w-full items-center gap-1.5 px-3 pb-1 pt-2.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:py-0"
              aria-expanded={!collapsed}
              onClick={() => {
                const next = new Set(toggled);
                if (next.has(group.status)) next.delete(group.status);
                else next.add(group.status);
                setToggled(next);
              }}
            >
              {group.label}
              <CountPill>{members.length}</CountPill>
              {collapsed ? <ChevronRight className="h-3 w-3" /> : null}
            </button>
            {!collapsed &&
              members.map((issue) => (
                <div
                  key={issue.id}
                  role="button"
                  tabIndex={0}
                  className={
                    ROW_BASE +
                    " pl-1.5" +
                    (selectedId === issue.id ? " bg-surface-selected" : " hover:bg-surface-recessed")
                  }
                  onClick={() => onSelect(issue.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onSelect(issue.id);
                  }}
                >
                  <IssueRowContent issue={issue} index={index} showParent />
                </div>
              ))}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail

function Chip({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <span
      className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border bg-surface-raised px-2 text-xs text-foreground pointer-coarse:h-8 pointer-coarse:px-3"
      style={style}
    >
      {children}
    </span>
  );
}

function RelationList({
  issues,
  index,
  onSelect,
}: {
  issues: BdIssueNode[];
  index: IssueIndex;
  onSelect: (id: string) => void;
}) {
  return (
    <InfoList
      items={issues}
      getKey={(issue) => issue.id}
      renderItem={(issue) => (
        <InfoListRow
          leading={<StatusGlyph status={effectiveStatus(issue, index)} size={12} />}
          leadingLabel={STATUS_LABEL[effectiveStatus(issue, index)]}
          name={issue.title}
          title={`${issue.title} (${issue.id})`}
          trailing={
            issue.priority <= 1 ? (
              <span
                className="text-xs font-semibold tabular-nums"
                style={{ color: priorityColor(issue.priority) }}
              >
                P{issue.priority}
              </span>
            ) : undefined
          }
          onSelect={() => onSelect(issue.id)}
        />
      )}
    />
  );
}

function useIssueShow(threadId: string, id: string) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "issue_show",
    input: { threadId, id },
  });
  const show = useMemo<IssueShow | null>(() => {
    if (query.data?.json == null) return null;
    try {
      const parsed: unknown = JSON.parse(query.data.json);
      return Array.isArray(parsed) && parsed.length > 0 ? (parsed[0] as IssueShow) : null;
    } catch {
      return null;
    }
  }, [query.data?.json]);
  return { show, query };
}

function useMarkdownDocument(threadId: string, checkout: IssuesCheckout | null) {
  return useMemo(
    () =>
      checkout === null
        ? undefined
        : {
            threadId,
            rootPath: checkout.rootPath,
            target: {
              kind: "workspace" as const,
              environmentId: checkout.environmentId,
              path: "ISSUE.md",
            },
          },
    [threadId, checkout?.environmentId, checkout?.rootPath],
  );
}

// Prose fields render images as thumbnails rather than at full size.
const PROSE_CLASS =
  "text-[13px] leading-relaxed [&_img]:max-h-40 [&_img]:max-w-full [&_img]:rounded";

function IssueDetail({
  threadId,
  checkout,
  issue,
  index,
  onSelect,
  onForm,
}: {
  threadId: string;
  checkout: IssuesCheckout | null;
  issue: BdIssueNode;
  index: IssueIndex;
  onSelect: (id: string) => void;
  onForm: (target: FormTarget) => void;
}) {
  const { show, query } = useIssueShow(threadId, issue.id);
  const [copied, setCopied] = useState(false);
  // A virtual document at the checkout root, so bb resolves relative image
  // sources and file links (`assets/x.png`, `docs/spec.md`) against the project.
  const markdownDocument = useMarkdownDocument(threadId, checkout);

  const status = effectiveStatus(issue, index);
  const parent = issue.parent !== null ? index.byId.get(issue.parent) : undefined;
  const blockedBy = issue.blockedBy
    .map((id) => index.byId.get(id))
    .filter((dep): dep is BdIssueNode => dep !== undefined);
  const waitingOn = blockedBy.filter((dep) => dep.status !== "closed").length;
  const blocks = index.blocks.get(issue.id) ?? [];
  const kids = index.children.get(issue.id) ?? [];
  const progress = descendantProgress(issue.id, index);
  const acceptance = show?.acceptance_criteria ?? "";
  const checklist = checklistProgress(acceptance);

  const copyId = (): void => {
    void experimental_copyToClipboard({ text: issue.id }).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={"space-y-4 px-3.5 pt-3 pointer-coarse:px-4 pointer-coarse:pt-2 " + SCROLL_END}>
      <header>
        <div className="group flex flex-wrap items-center gap-x-1.5 gap-y-0 font-mono text-xs text-subtle-foreground">
          <TypeGlyph type={issue.type} />
          <span className="min-w-0 truncate">{issue.id}</span>
          <button
            className="flex h-4 w-4 items-center justify-center rounded opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100"
            aria-label="Copy issue ID"
            onClick={copyId}
          >
            <Copy className="h-3 w-3 pointer-coarse:h-4 pointer-coarse:w-4" />
          </button>
          {copied && <span className="font-sans">Copied</span>}
          <span className="flex-1" />
          <span className="flex items-center gap-0.5 font-sans">
            {issue.type === "epic" && (
              <button
                className={GHOST_BUTTON}
                onClick={() => onForm({ kind: "create", parent: issue.id })}
              >
                <Plus className="h-3 w-3" />
                Sub-issue
              </button>
            )}
            <button className={GHOST_BUTTON} onClick={() => onForm({ kind: "edit", id: issue.id })}>
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          </span>
        </div>
        <h2 className="mt-0.5 w-full text-[15px] font-semibold leading-snug text-foreground [text-wrap:pretty]">
          {issue.title}
        </h2>
        <div className="mt-2 flex flex-wrap gap-1 pointer-coarse:gap-2">
          <Chip>
            <StatusGlyph status={status} size={12} />
            {STATUS_LABEL[status]}
          </Chip>
          <Chip>
            <span className="font-semibold" style={{ color: priorityColor(issue.priority) }}>
              P{issue.priority}
            </span>
            {PRIORITY_LABEL[issue.priority] ?? ""}
          </Chip>
          <Chip style={{ color: "var(--muted-foreground)" }}>{issue.type}</Chip>
        </div>
        {waitingOn > 0 && (
          <p
            className="mt-3 rounded-md px-2.5 py-1.5 text-xs"
            style={{
              color: "var(--destructive-text)",
              background: "color-mix(in oklab, var(--destructive-text) 12%, transparent)",
            }}
          >
            Waiting on {waitingOn} open issue{waitingOn === 1 ? "" : "s"}
          </p>
        )}
      </header>

      <div>
        {parent !== undefined && (
          <DetailRow label="Parent" icon="beads/parent">
            <button
              className="min-w-0 truncate text-left text-foreground underline decoration-border underline-offset-[3px] hover:decoration-foreground pointer-coarse:min-h-11"
              onClick={() => onSelect(parent.id)}
            >
              {parent.title}
            </button>
          </DetailRow>
        )}
        {issue.owner !== null && (
          <DetailRow label="Owner" icon="beads/owner">
            <span className="truncate" title={issue.owner}>
              {issue.owner.split("@")[0]}
            </span>
          </DetailRow>
        )}
        {issue.labels.length > 0 && (
          <DetailRow label="Labels" icon="beads/labels">
            <span className="flex min-w-0 flex-wrap gap-1">
              {issue.labels.map((label) => (
                <span
                  key={label}
                  className="rounded bg-surface-recessed px-1.5 text-xs leading-4 text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </span>
          </DetailRow>
        )}
        {issue.dueAt !== null && (
          <DetailRow label="Due" icon="beads/due">
            {formatDay(issue.dueAt, true)}
          </DetailRow>
        )}
        {issue.estimatedMinutes !== null && (
          <DetailRow label="Estimate" icon="beads/estimate">
            {formatMinutes(issue.estimatedMinutes)}
          </DetailRow>
        )}
        {issue.updatedAt !== null && (
          <DetailRow label="Updated" icon="Clock">
            <span title={new Date(issue.updatedAt).toLocaleString()}>
              {formatRelative(issue.updatedAt)}
            </span>
          </DetailRow>
        )}
      </div>

      {show === null ? (
        <p
          className={
            "text-xs " +
            (query.isLoading ? "text-subtle-foreground" : "text-destructive-text")
          }
        >
          {query.isLoading
            ? "Loading…"
            : (query.data?.error ?? query.error?.message ?? "Could not load this issue.")}
        </p>
      ) : (
        <>
          <InfoSection label="Description">
            {show.description ? (
              <Markdown
                content={show.description}
                className={PROSE_CLASS}
                experimental_document={markdownDocument}
              />
            ) : (
              <p className="text-xs italic text-subtle-foreground">No description</p>
            )}
          </InfoSection>
          {acceptance !== "" && (
            <InfoSection
              label="Acceptance"
              trailing={
                checklist.total > 0 ? (
                  <CountPill>
                    {checklist.done}/{checklist.total}
                  </CountPill>
                ) : undefined
              }
            >
              <Markdown
                content={acceptance}
                experimental_document={markdownDocument}
                className={PROSE_CLASS + " [&_li:has(>input[type=checkbox])]:list-none [&_ul:has(>li>input[type=checkbox])]:pl-0"}
              />
            </InfoSection>
          )}
          {show.design ? (
            <InfoSection label="Design">
              <Markdown
                content={show.design}
                className={PROSE_CLASS}
                experimental_document={markdownDocument}
              />
            </InfoSection>
          ) : null}
          {show.notes ? (
            <InfoSection label="Notes">
              <Markdown
                content={show.notes}
                className={PROSE_CLASS}
                experimental_document={markdownDocument}
              />
            </InfoSection>
          ) : null}
        </>
      )}

      {kids.length > 0 && (
        <InfoSection
          label="Sub-issues"
          trailing={
            <span className="flex items-center gap-1.5">
              <span className="h-1 w-12 overflow-hidden rounded-full bg-surface-recessed">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${(progress.done / progress.total) * 100}%`,
                    background: "var(--success)",
                  }}
                />
              </span>
              <CountPill>
                {progress.done}/{progress.total}
              </CountPill>
            </span>
          }
        >
          <RelationList issues={kids} index={index} onSelect={onSelect} />
        </InfoSection>
      )}
      {blockedBy.length > 0 && (
        <InfoSection label="Blocked by" count={blockedBy.length}>
          <RelationList issues={blockedBy} index={index} onSelect={onSelect} />
        </InfoSection>
      )}
      {blocks.length > 0 && (
        <InfoSection label="Blocks" count={blocks.length}>
          <RelationList issues={blocks} index={index} onSelect={onSelect} />
        </InfoSection>
      )}

      {show?.created_at != null && (
        <p className="text-xs text-subtle-foreground">
          Created {formatRelative(show.created_at)}
          {show.created_by ? ` by ${show.created_by}` : ""}
          {issue.commentCount > 0 ? ` · ${issue.commentCount} comments` : ""}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue form: one form, two variants. Create starts from an empty draft
// (optionally under a parent); edit starts from the issue as loaded once.

type FormTarget = { kind: "create"; parent: string | null } | { kind: "edit"; id: string };

const STATUS_OPTIONS = ["open", "in_progress", "blocked", "deferred", "closed"];
const TYPE_OPTIONS = ["task", "bug", "feature", "epic", "chore", "story", "spike", "decision", "milestone"];

function withCurrent(options: string[], current: string): string[] {
  return options.includes(current) ? options : [...options, current];
}

function emptyDraft(parent: BdIssueNode | undefined): IssueDraft {
  return {
    title: "",
    description: "",
    type: "task",
    status: "open",
    priority: 2,
    parent: parent?.id ?? null,
    // bd would inherit these; showing them lets the user drop one.
    labels: parent?.labels ?? [],
    blockedBy: [],
    blocks: [],
    acceptance: "",
    design: "",
    notes: "",
  };
}

function draftFromIssue(issue: BdIssueNode, show: IssueShow, index: IssueIndex): IssueDraft {
  return {
    title: issue.title,
    description: show.description ?? "",
    type: issue.type,
    status: issue.status,
    priority: issue.priority,
    parent: issue.parent,
    labels: issue.labels,
    blockedBy: issue.blockedBy,
    blocks: (index.blocks.get(issue.id) ?? []).map((dep) => dep.id),
    acceptance: show.acceptance_criteria ?? "",
    design: show.design ?? "",
    notes: show.notes ?? "",
  };
}

function sameDraft(a: IssueDraft, b: IssueDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function subtreeIds(id: string, index: IssueIndex): Set<string> {
  const ids = new Set([id]);
  const walk = (parentId: string): void => {
    for (const kid of index.children.get(parentId) ?? []) {
      ids.add(kid.id);
      walk(kid.id);
    }
  };
  walk(id);
  return ids;
}

const FIELD_CLASS =
  "w-full resize-none rounded-md border border-border bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-foreground outline-none [field-sizing:content] placeholder:text-subtle-foreground focus:border-ring pointer-coarse:px-3 pointer-coarse:py-2.5 pointer-coarse:text-base";

const GHOST_BUTTON =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-subtle-foreground outline-none hover:bg-surface-recessed hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:gap-1.5 pointer-coarse:px-3 pointer-coarse:text-[13px]";

// A property chip that is also a native select: the detail header's chip
// visuals with the platform's picker and keyboard behaviour.
function ChipSelect({
  label,
  value,
  options,
  optionLabel,
  onChange,
  children,
}: {
  label: string;
  value: string;
  options: string[];
  optionLabel: (option: string) => string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className="relative inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-full border border-border bg-surface-raised pl-2 pr-1.5 text-xs text-foreground hover:bg-surface-recessed focus-within:ring-1 focus-within:ring-ring pointer-coarse:h-11 pointer-coarse:pl-3 pointer-coarse:pr-2.5"
      title={label}
    >
      {children}
      <ChevronDown className="h-3 w-3 text-subtle-foreground" />
      <select
        aria-label={label}
        className="absolute inset-0 cursor-pointer text-base opacity-0"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function IssuePicker({
  index,
  exclude,
  epicsFirst = false,
  placeholder,
  onPick,
  onClose,
}: {
  index: IssueIndex;
  exclude: ReadonlySet<string>;
  epicsFirst?: boolean;
  placeholder: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const needle = query.trim().toLowerCase();
  const matches = [...index.byId.values()]
    .filter(
      (issue) =>
        !exclude.has(issue.id) &&
        (needle === "" ||
          issue.title.toLowerCase().includes(needle) ||
          issue.id.toLowerCase().includes(needle)),
    )
    .sort(
      (a, b) =>
        (epicsFirst ? Number(b.type === "epic") - Number(a.type === "epic") : 0) ||
        compareIssues(a, b),
    )
    .slice(0, 50);
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const pick = (id: string): void => {
    onPick(id);
    onClose();
  };
  return (
    <div className="mt-1 overflow-hidden rounded-md border border-border bg-surface-raised shadow-[0_4px_12px_-4px_rgb(0_0_0/0.18)]">
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls="beads-issue-picker"
        aria-activedescendant={matches[current] ? `beads-pick-${matches[current].id}` : undefined}
        className="h-8 w-full border-b border-border bg-transparent px-2.5 text-xs text-foreground outline-none placeholder:text-subtle-foreground pointer-coarse:h-11 pointer-coarse:px-3 pointer-coarse:text-base"
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onBlur={onClose}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current + step + matches.length) % Math.max(1, matches.length));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const match = matches[current];
            if (match) pick(match.id);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <div id="beads-issue-picker" role="listbox" className="max-h-52 overflow-y-auto py-1 pointer-coarse:max-h-[50dvh]">
        {matches.length === 0 ? (
          <p className="px-2.5 py-1.5 text-xs text-subtle-foreground">No matching issues</p>
        ) : (
          matches.map((issue, i) => (
            <div
              key={issue.id}
              id={`beads-pick-${issue.id}`}
              role="option"
              aria-selected={i === current}
              className={
                "mx-1 flex h-7 cursor-pointer items-center gap-1.5 rounded px-1.5 text-xs pointer-coarse:h-11 pointer-coarse:px-2.5" +
                (i === current ? " bg-surface-selected" : "")
              }
              // Keep focus in the input so its blur does not close the list first.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(issue.id)}
            >
              <StatusGlyph status={effectiveStatus(issue, index)} size={12} />
              <TypeGlyph type={issue.type} />
              <span className="min-w-0 flex-1 truncate text-foreground">{issue.title}</span>
              <span className="shrink-0 font-mono text-xs text-subtle-foreground">{issue.id}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function IssueRef({
  id,
  index,
  onRemove,
}: {
  id: string;
  index: IssueIndex;
  onRemove: () => void;
}) {
  const issue = index.byId.get(id);
  return (
    <div className="group flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-surface-recessed pointer-coarse:h-11">
      {issue !== undefined ? (
        <>
          <StatusGlyph status={effectiveStatus(issue, index)} size={12} />
          <TypeGlyph type={issue.type} />
          <span className="min-w-0 flex-1 truncate text-foreground" title={`${issue.title} (${id})`}>
            {issue.title}
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{id}</span>
      )}
      <button
        type="button"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-subtle-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100"
        aria-label={`Remove ${issue?.title ?? id}`}
        onClick={onRemove}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function RelationField({
  label,
  ids,
  index,
  exclude,
  addLabel,
  onChange,
}: {
  label: string;
  ids: string[];
  index: IssueIndex;
  exclude: ReadonlySet<string>;
  addLabel: string;
  onChange: (ids: string[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <InfoSection
      label={label}
      count={ids.length > 0 ? ids.length : undefined}
      trailing={
        <button type="button" className={GHOST_BUTTON} onClick={() => setPicking(true)}>
          <Plus className="h-3 w-3" />
          Add
        </button>
      }
    >
      {ids.length === 0 && !picking ? (
        <p className="text-xs text-subtle-foreground">None</p>
      ) : (
        ids.map((id) => (
          <IssueRef
            key={id}
            id={id}
            index={index}
            onRemove={() => onChange(ids.filter((other) => other !== id))}
          />
        ))
      )}
      {picking && (
        <IssuePicker
          index={index}
          exclude={new Set([...exclude, ...ids])}
          placeholder={addLabel}
          onPick={(id) => onChange([...ids, id])}
          onClose={() => setPicking(false)}
        />
      )}
    </InfoSection>
  );
}

function LabelsField({
  labels,
  known,
  onChange,
}: {
  labels: string[];
  known: string[];
  onChange: (labels: string[]) => void;
}) {
  const [text, setText] = useState("");
  const add = (raw: string): void => {
    const label = raw.trim().replace(/,/g, "");
    if (label !== "" && !labels.includes(label)) onChange([...labels, label]);
    setText("");
  };
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {labels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-0.5 rounded bg-surface-recessed pl-1.5 pr-0.5 text-xs leading-4 text-muted-foreground pointer-coarse:pl-2.5"
        >
          {label}
          <button
            type="button"
            className="flex h-4 w-4 items-center justify-center rounded outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-11"
            aria-label={`Remove label ${label}`}
            onClick={() => onChange(labels.filter((other) => other !== label))}
          >
            <X className="h-2.5 w-2.5 pointer-coarse:h-3.5 pointer-coarse:w-3.5" />
          </button>
        </span>
      ))}
      <input
        className="h-5 min-w-[6rem] flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground pointer-coarse:h-11 pointer-coarse:text-base"
        placeholder={labels.length === 0 ? "Add labels" : "Add"}
        aria-label="Add label"
        list="beads-known-labels"
        value={text}
        onChange={(event) => {
          if (event.target.value.endsWith(",")) add(event.target.value);
          else setText(event.target.value);
        }}
        onBlur={() => add(text)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && text.trim() !== "") {
            event.preventDefault();
            add(text);
          } else if (event.key === "Backspace" && text === "" && labels.length > 0) {
            onChange(labels.slice(0, -1));
          }
        }}
      />
      <datalist id="beads-known-labels">
        {known
          .filter((label) => !labels.includes(label))
          .map((label) => (
            <option key={label} value={label} />
          ))}
      </datalist>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Attachments: `@` completes project files into Markdown links, and pasting an
// image saves it under the checkout's assets/ folder and links it. Images preview under the
// field through the same Markdown renderer the detail pane uses.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const IMAGE_LINK = /!\[[^\]]*\]\((?:<[^>\n]+>|[^)\s]+)\)/g;

// Angle brackets keep paths with spaces or parentheses a valid link target.
function markdownLink(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const target = /[\s()]/.test(file) ? `<${file}>` : file;
  return `${IMAGE_EXT.test(file) ? "!" : ""}[${name}](${target})`;
}

// The `@query` word ending at the caret, if any. `@` must start a word so an
// email address does not open the picker.
function atTrigger(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match === null ? null : { start: caret - match[2].length - 1, query: match[2] };
}

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function AttachmentTextarea({
  threadId,
  checkout,
  value,
  onValueChange,
  onAttachError,
  ...rest
}: {
  threadId: string;
  checkout: IssuesCheckout | null;
  value: string;
  onValueChange: (value: string) => void;
  onAttachError: (message: string) => void;
} & Omit<React.ComponentProps<typeof VoiceInputTextarea>, "value" | "onValueChange">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [uploads, setUploads] = useState(0);
  const save = experimental_useRpcMutation({ contract: rpcContract, method: "attachment_save" });
  const found = experimental_useRpcQuery({
    contract: rpcContract,
    method: "files_search",
    input: { threadId, query: trigger?.query ?? "" },
    enabled: trigger !== null,
  });
  const document = useMarkdownDocument(threadId, checkout);
  const paths = trigger === null ? [] : (found.data?.paths ?? []);
  const images = useMemo(() => (value.match(IMAGE_LINK) ?? []).join("\n\n"), [value]);

  // Replace [from, to) with `text` and put the caret after it.
  const splice = (from: number, to: number, text: string): void => {
    const el = ref.current;
    const current = el?.value ?? value;
    onValueChange(current.slice(0, from) + text + current.slice(to));
    setTrigger(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + text.length, from + text.length);
    });
  };

  const pick = (file: string): void => {
    if (trigger === null) return;
    const caret = ref.current?.selectionStart ?? trigger.start + trigger.query.length + 1;
    splice(trigger.start, caret, markdownLink(file) + " ");
  };

  const pasteImage = async (file: File, at: number): Promise<void> => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      onAttachError(`Image is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setUploads((n) => n + 1);
    try {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*/, "") || "png";
      const name = file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}.${ext}`;
      const result = await save.mutate({ threadId, name, dataBase64: await readBase64(file) });
      if (result.path === null) {
        onAttachError(result.error ?? "Could not save the image.");
        return;
      }
      splice(at, at, markdownLink(result.path) + "\n");
    } catch (caught) {
      onAttachError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUploads((n) => n - 1);
    }
  };

  return (
    <div className="relative space-y-1.5">
      <VoiceInputTextarea
        {...rest}
        ref={ref}
        value={value}
        onValueChange={(next) => {
          onValueChange(next);
          setActive(0);
          setTrigger(atTrigger(next, ref.current?.selectionStart ?? next.length));
        }}
        onPaste={(event) => {
          const image = Array.from(event.clipboardData.files).find((f) => f.type.startsWith("image/"));
          if (image === undefined) return;
          event.preventDefault();
          void pasteImage(image, ref.current?.selectionStart ?? value.length);
        }}
        onKeyDown={(event) => {
          rest.onKeyDown?.(event);
          if (trigger === null || paths.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => (i + (event.key === "ArrowDown" ? 1 : paths.length - 1)) % paths.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            pick(paths[Math.min(active, paths.length - 1)]);
          } else if (event.key === "Escape") {
            // Close the picker without also discarding the form.
            event.preventDefault();
            setTrigger(null);
          }
        }}
        onBlur={(event) => {
          rest.onBlur?.(event);
          setTrigger(null);
        }}
      />
      {uploads > 0 && <p className="text-xs text-subtle-foreground">Saving image…</p>}
      {paths.length > 0 && (
        <ul
          role="listbox"
          aria-label="Project files"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
        >
          {paths.map((file, i) => (
            <li
              key={file}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: the textarea would blur and close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(file);
              }}
              onMouseEnter={() => setActive(i)}
              className={
                "flex cursor-pointer items-baseline gap-2 rounded px-2 py-1 pointer-coarse:min-h-11 pointer-coarse:items-center " +
                (i === active ? "bg-surface-recessed" : "")
              }
            >
              <span className="shrink-0 text-xs text-foreground">{file.slice(file.lastIndexOf("/") + 1)}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-subtle-foreground">{file}</span>
            </li>
          ))}
        </ul>
      )}
      {images !== "" && <Markdown content={images} className={PROSE_CLASS} experimental_document={document} />}
    </div>
  );
}

function IssueForm({
  threadId,
  checkout,
  index,
  target,
  initial,
  revision,
  onDone,
  onCancel,
}: {
  threadId: string;
  checkout: IssuesCheckout | null;
  index: IssueIndex;
  target: FormTarget;
  initial: IssueDraft;
  revision: string | null;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  // Captured once: the issue_show query refetches whenever anything in the
  // graph changes, and must not overwrite what the user is typing.
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [pickingParent, setPickingParent] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // A partial save moved the issue past this form's starting point.
  const [stale, setStale] = useState(false);
  const hasMore = initial.acceptance !== "" || initial.design !== "" || initial.notes !== "";
  const [showMore, setShowMore] = useState(hasMore);
  const create = experimental_useRpcMutation({ contract: rpcContract, method: "issue_create" });
  const update = experimental_useRpcMutation({ contract: rpcContract, method: "issue_update" });

  const editing = target.kind === "edit" ? target.id : null;
  const set = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setConfirmDiscard(false);
  };
  const dirty = !sameDraft(draft, initial);
  const pending = create.isPending || update.isPending;
  const canSubmit =
    draft.title.trim() !== "" && !pending && !voiceActive && !stale && (editing === null || dirty);

  // An issue cannot sit under itself or its own descendants.
  const parentExclude = editing !== null ? subtreeIds(editing, index) : new Set<string>();
  const selfExclude = new Set(editing !== null ? [editing] : []);
  const parent = draft.parent !== null ? index.byId.get(draft.parent) : undefined;
  const knownLabels = useMemo(
    () => [...new Set([...index.byId.values()].flatMap((issue) => issue.labels))].sort(),
    [index],
  );

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setError(null);
    try {
      if (editing === null) {
        const result = await create.mutate({ threadId, draft });
        if (result.error !== null || result.id === null) {
          setError(result.error ?? "bd did not report the new issue's ID.");
          return;
        }
        onDone(result.id);
      } else {
        const result = await update.mutate({ threadId, id: editing, revision, before: initial, after: draft });
        if (result.error !== null) {
          setError(result.error);
          setStale(result.partial);
          return;
        }
        onDone(editing);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const verb = editing === null ? "Create issue" : "Save changes";
  return (
    <form
      className="flex h-full flex-col"
      aria-label={editing === null ? "New issue" : `Edit ${editing}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) {
          event.preventDefault();
          void submit();
        } else if (event.key === "Escape" && !event.defaultPrevented) {
          if (!dirty || confirmDiscard) onCancel();
          else setConfirmDiscard(true);
        }
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 pl-1.5 pr-3 pointer-coarse:h-12 pointer-coarse:pl-2 pointer-coarse:pr-3">
        <button type="button" className={GHOST_BUTTON} onClick={onCancel}>
          <ChevronLeft className="h-3.5 w-3.5" />
          Cancel
        </button>
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground pointer-coarse:text-[13px]">
          {editing === null ? "New issue" : "Edit issue"}
        </span>
        {editing !== null && (
          <span className="hidden truncate font-mono text-xs text-subtle-foreground min-[360px]:inline">{editing}</span>
        )}
        <span className="flex-1" />
        <button
          type="submit"
          disabled={!canSubmit}
          title={`${verb} (${navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"}+Enter)`}
          className="inline-flex h-6 shrink-0 items-center rounded-md bg-primary px-2.5 text-xs font-medium pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:text-[13px] text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-40"
        >
          {pending ? (editing === null ? "Creating…" : "Saving…") : verb}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={"space-y-4 px-3.5 pt-2 pointer-coarse:px-4 " + SCROLL_END}>
          {(error !== null || confirmDiscard) && (
            <p
              role={error !== null ? "alert" : "status"}
              className="whitespace-pre-wrap rounded-md px-2.5 py-1.5 text-xs"
              style={
                error !== null
                  ? {
                      color: "var(--destructive-text)",
                      background: "color-mix(in oklab, var(--destructive-text) 12%, transparent)",
                    }
                  : { color: "var(--muted-foreground)", background: "var(--surface-recessed)" }
              }
            >
              {error ?? "Unsaved changes. Press Esc again to discard them."}
            </p>
          )}

          <div className="space-y-2">
            <input
              autoFocus
              aria-label="Title"
              className="w-full bg-transparent text-[15px] font-semibold leading-snug text-foreground outline-none placeholder:font-normal placeholder:text-subtle-foreground pointer-coarse:py-2 pointer-coarse:text-base"
              placeholder="Issue title"
              value={draft.title}
              onChange={(event) => set("title", event.target.value)}
            />
            <AttachmentTextarea
              threadId={threadId}
              checkout={checkout}
              onAttachError={setError}
              aria-label="Description"
              className={FIELD_CLASS + " min-h-[6.5rem]"}
              placeholder="Add a description. Markdown works."
              value={draft.description}
              onValueChange={(value) => set("description", value)}
              onVoiceInputActiveChange={setVoiceActive}
            />
          </div>

          <div className="flex flex-wrap gap-1">
            <ChipSelect
              label="Status"
              value={draft.status}
              options={withCurrent(STATUS_OPTIONS, draft.status)}
              optionLabel={(option) => STATUS_LABEL[option as Status] ?? option}
              onChange={(value) => set("status", value)}
            >
              <StatusGlyph
                status={(STATUS_OPTIONS.includes(draft.status) ? draft.status : "open") as Status}
                size={12}
              />
              {STATUS_LABEL[draft.status as Status] ?? draft.status}
            </ChipSelect>
            <ChipSelect
              label="Priority"
              value={String(draft.priority)}
              options={["0", "1", "2", "3", "4"]}
              optionLabel={(option) => `P${option} ${PRIORITY_LABEL[Number(option)]}`}
              onChange={(value) => set("priority", Number(value))}
            >
              <span className="font-semibold" style={{ color: priorityColor(draft.priority) }}>
                P{draft.priority}
              </span>
              {PRIORITY_LABEL[draft.priority]}
            </ChipSelect>
            <ChipSelect
              label="Type"
              value={draft.type}
              options={withCurrent(TYPE_OPTIONS, draft.type)}
              optionLabel={(option) => option}
              onChange={(value) => set("type", value)}
            >
              <TypeGlyph type={draft.type} />
              {draft.type}
            </ChipSelect>
          </div>

          <div>
            <DetailRow label="Parent" icon="beads/parent">
              {parent !== undefined || draft.parent !== null ? (
                <span className="group flex min-w-0 items-center gap-1">
                  {parent !== undefined && <TypeGlyph type={parent.type} />}
                  <button
                    type="button"
                    className="min-w-0 truncate text-left text-foreground underline decoration-border underline-offset-[3px] hover:decoration-foreground pointer-coarse:min-h-11"
                    onClick={() => setPickingParent(true)}
                  >
                    {parent?.title ?? draft.parent}
                  </button>
                  <button
                    type="button"
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-11"
                    aria-label="Remove parent"
                    onClick={() => set("parent", null)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="text-subtle-foreground hover:text-foreground pointer-coarse:min-h-11"
                  onClick={() => setPickingParent(true)}
                >
                  Add to an epic or parent…
                </button>
              )}
            </DetailRow>
            {pickingParent && (
              <IssuePicker
                index={index}
                exclude={new Set([...parentExclude, ...(draft.parent !== null ? [draft.parent] : [])])}
                epicsFirst
                placeholder="Search epics and issues"
                onPick={(id) => {
                  set("parent", id);
                  // Mirror bd's label inheritance in a new issue.
                  const picked = index.byId.get(id);
                  if (editing === null && picked !== undefined) {
                    setDraft((current) => ({
                      ...current,
                      labels: [...new Set([...current.labels, ...picked.labels])],
                    }));
                  }
                }}
                onClose={() => setPickingParent(false)}
              />
            )}
            <DetailRow label="Labels" icon="beads/labels">
              <LabelsField
                labels={draft.labels}
                known={knownLabels}
                onChange={(labels) => set("labels", labels)}
              />
            </DetailRow>
          </div>

          <RelationField
            label="Blocked by"
            ids={draft.blockedBy}
            index={index}
            exclude={new Set([...selfExclude, ...draft.blocks])}
            addLabel="Search issues this one waits on"
            onChange={(ids) => set("blockedBy", ids)}
          />
          <RelationField
            label="Blocks"
            ids={draft.blocks}
            index={index}
            exclude={new Set([...selfExclude, ...draft.blockedBy])}
            addLabel="Search issues waiting on this one"
            onChange={(ids) => set("blocks", ids)}
          />

          {showMore ? (
            <>
              <InfoSection label="Acceptance">
                <AttachmentTextarea
              threadId={threadId}
              checkout={checkout}
              onAttachError={setError}
                  // Revealed on request: move straight into the first field.
                  autoFocus={!hasMore}
                  aria-label="Acceptance criteria"
                  className={FIELD_CLASS + " min-h-[4.5rem]"}
                  placeholder="- [ ] What must be true when this is done"
                  value={draft.acceptance}
                  onValueChange={(value) => set("acceptance", value)}
                  onVoiceInputActiveChange={setVoiceActive}
                />
              </InfoSection>
              <InfoSection label="Design">
                <AttachmentTextarea
              threadId={threadId}
              checkout={checkout}
              onAttachError={setError}
                  aria-label="Design"
                  className={FIELD_CLASS + " min-h-[4.5rem]"}
                  placeholder="Decisions and approach"
                  value={draft.design}
                  onValueChange={(value) => set("design", value)}
                  onVoiceInputActiveChange={setVoiceActive}
                />
              </InfoSection>
              <InfoSection label="Notes">
                <AttachmentTextarea
              threadId={threadId}
              checkout={checkout}
              onAttachError={setError}
                  aria-label="Notes"
                  className={FIELD_CLASS + " min-h-[4.5rem]"}
                  placeholder="Context for whoever picks this up"
                  value={draft.notes}
                  onValueChange={(value) => set("notes", value)}
                  onVoiceInputActiveChange={setVoiceActive}
                />
              </InfoSection>
            </>
          ) : (
            <button type="button" className={GHOST_BUTTON + " -ml-1.5"} onClick={() => setShowMore(true)}>
              <Plus className="h-3 w-3" />
              Acceptance, design and notes
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function EditIssueForm({
  threadId,
  checkout,
  issue,
  index,
  onDone,
  onCancel,
}: {
  threadId: string;
  checkout: IssuesCheckout | null;
  issue: BdIssueNode;
  index: IssueIndex;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const { show, query } = useIssueShow(threadId, issue.id);
  // Freeze the starting point at first load; later refetches leave the form alone.
  const [start, setStart] = useState<{ draft: IssueDraft; revision: string | null } | null>(null);
  if (start === null && show !== null) {
    setStart({ draft: draftFromIssue(issue, show, index), revision: show.revision ?? null });
  }
  if (start === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center pl-1.5 pointer-coarse:h-12 pointer-coarse:pl-2">
          <button type="button" className={GHOST_BUTTON} onClick={onCancel}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>
        <p
          className={
            "px-3.5 text-xs " + (query.isLoading ? "text-subtle-foreground" : "text-destructive-text")
          }
        >
          {query.isLoading
            ? "Loading…"
            : (query.data?.error ?? query.error?.message ?? "Could not load this issue.")}
        </p>
      </div>
    );
  }
  return (
    <IssueForm
      threadId={threadId}
      checkout={checkout}
      index={index}
      target={{ kind: "edit", id: issue.id }}
      initial={start.draft}
      revision={start.revision}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

// ---------------------------------------------------------------------------
// Panel

const TOOLBAR_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded-md text-subtle-foreground outline-none hover:bg-surface-recessed hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-11";

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

function clampSplit(value: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

function SplitPanes({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) {
  // Fraction of the height taken by the list; the detail gets the rest.
  const [split, setSplit] = useState(0.45);
  const containerRef = useRef<HTMLDivElement>(null);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (move: PointerEvent): void => {
      setSplit(clampSplit((move.clientY - rect.top) / rect.height));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 overflow-y-auto" style={{ flex: `${split} 1 0%` }}>
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize list and detail panes"
        tabIndex={0}
        className="group flex h-2.5 shrink-0 cursor-row-resize touch-none items-center outline-none pointer-coarse:h-6"
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setSplit((current) => clampSplit(current + (event.key === "ArrowUp" ? -0.05 : 0.05)));
          }
        }}
      >
        <div className="h-px flex-1 bg-border group-hover:bg-ring group-focus-visible:bg-ring pointer-coarse:h-0.5" />
      </div>
      <div className="min-h-0 overflow-y-auto" style={{ flex: `${1 - split} 1 0%` }}>
        {bottom}
      </div>
    </div>
  );
}

// True on touch-first devices. A phone has no room for a list and a detail pane
// side by side, so it always drills in, whatever the layout setting says.
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const onChange = (): void => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

function BeadsPanel({ threadId }: { threadId: string }) {
  const visible = experimental_useTabVisible();
  const coarse = useCoarsePointer();
  const configured = parseLayout(useSettings().values?.layout);
  const layout: PanelLayout = coarse ? "drill" : configured;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormTarget | null>(null);
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "issues_tree",
    input: { threadId },
    enabled: visible,
  });
  const index = useMemo(() => buildIndex(query.data?.issues ?? []), [query.data?.issues]);
  // A refetch can drop the selected issue (deleted, or another checkout).
  const selected = selectedId !== null ? (index.byId.get(selectedId) ?? null) : null;
  const openCount = [...index.byId.values()].filter((issue) => issue.status !== "closed").length;

  const message =
    query.isLoading && query.data === undefined
      ? { text: "Loading issues…", error: false }
      : query.data?.error != null
        ? { text: query.data.error, error: true }
        : index.byId.size === 0
          ? { text: "No issues yet. Create one with +.", error: false }
          : null;

  const toolbar = (
    <div className="flex h-9 shrink-0 items-center gap-1.5 px-3 pointer-coarse:h-12 pointer-coarse:px-4">
      <span className="text-xs font-medium text-muted-foreground pointer-coarse:text-[13px]">Issues</span>
      {query.data !== undefined && <CountPill>{openCount} open</CountPill>}
      <span className="flex-1" />
      {query.data?.initialized === true && (
        <button
          className={TOOLBAR_BUTTON}
          aria-label="New issue"
          title="New issue"
          onClick={() => setForm({ kind: "create", parent: null })}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        className={TOOLBAR_BUTTON}
        aria-label="Refresh"
        title="Refresh"
        onClick={() => void query.refetch()}
      >
        <RefreshCw className={"h-3.5 w-3.5" + (query.isFetching ? " animate-spin" : "")} />
      </button>
    </div>
  );

  // The form takes the whole panel in every layout: a side panel is too narrow
  // to edit beside the list.
  const editing = form?.kind === "edit" ? index.byId.get(form.id) : undefined;
  if (form !== null && query.data?.initialized === true && (form.kind === "create" || editing)) {
    const close = (id: string | null): void => {
      setForm(null);
      if (id !== null) setSelectedId(id);
    };
    return form.kind === "create" ? (
      <IssueForm
        key={`create:${form.parent ?? ""}`}
        threadId={threadId}
        checkout={query.data?.checkout ?? null}
        index={index}
        target={form}
        initial={emptyDraft(form.parent !== null ? index.byId.get(form.parent) : undefined)}
        revision={null}
        onDone={close}
        onCancel={() => close(null)}
      />
    ) : (
      <EditIssueForm
        key={`edit:${form.id}`}
        threadId={threadId}
        checkout={query.data?.checkout ?? null}
        issue={editing!}
        index={index}
        onDone={close}
        onCancel={() => close(null)}
      />
    );
  }

  if (message !== null) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <p
          className={
            "whitespace-pre-wrap px-3 text-xs pointer-coarse:px-4 pointer-coarse:text-[13px] " +
            (message.error ? "text-destructive-text" : "text-subtle-foreground")
          }
        >
          {message.text}
        </p>
      </div>
    );
  }

  const detail =
    selected !== null ? (
      <IssueDetail
        key={selected.id}
        threadId={threadId}
        checkout={query.data?.checkout ?? null}
        issue={selected}
        index={index}
        onSelect={setSelectedId}
        onForm={setForm}
      />
    ) : (
      <p className="px-3.5 pt-3 text-xs text-subtle-foreground">Select an issue to see its details.</p>
    );

  if (layout === "drill") {
    return (
      <div className="flex h-full flex-col">
        {selected !== null ? (
          <>
            <button
              className="flex h-9 shrink-0 items-center gap-1 px-3 text-xs text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-12 pointer-coarse:px-3 pointer-coarse:text-[13px]"
              onClick={() => setSelectedId(null)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Issues
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
          </>
        ) : (
          <>
            {toolbar}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {configured === "grouped" ? (
                <GroupedList index={index} selectedId={null} onSelect={setSelectedId} />
              ) : (
                <IssueTree index={index} selectedId={null} onSelect={setSelectedId} />
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  const list =
    layout === "grouped" ? (
      <GroupedList index={index} selectedId={selectedId} onSelect={setSelectedId} />
    ) : (
      <IssueTree index={index} selectedId={selectedId} onSelect={setSelectedId} />
    );
  return (
    <div className="flex h-full flex-col">
      {toolbar}
      <SplitPanes top={list} bottom={detail} />
    </div>
  );
}

// Detail-row icons: bb resolves DetailRow icons by name, so register the
// lucide glyphs it has no built-in for.
const DETAIL_ICONS = {
  "beads/parent": CornerDownRight,
  "beads/owner": User,
  "beads/labels": Tag,
  "beads/due": CalendarClock,
  "beads/estimate": Timer,
};

export default definePluginApp((app) => {
  for (const [name, Glyph] of Object.entries(DETAIL_ICONS)) {
    // lucide icons are forwardRef objects; the registry wants a plain function.
    app.experimental_icons.register({
      name,
      component: ({ className }) => <Glyph className={className} />,
    });
  }
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "issues",
    title: "Beads issues",
    icon: "ListTree",
    component: BeadsPanel,
    run: ({ threadId, experimental_panel }) => {
      experimental_panel.openTab({
        tab: {
          id: "issues",
          context: { kind: "thread" },
          availability: "action",
        },
        params: { threadId },
        title: "Beads issues",
      });
    },
  });

  app.slots.experimental_threadAction({
    id: "beads",
    title: "Beads issues",
    icon: "ListTree",
    group: "beads",
    item: ({ experimental_panel }) => ({
      label: "Beads issues",
      icon: "ListTree",
      run: () => {
        experimental_panel.openTab({
          tab: {
            id: "issues",
            context: { kind: "thread" },
            availability: "action",
          },
          title: "Beads issues",
        });
      },
    }),
  });
});
