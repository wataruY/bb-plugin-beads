// bb-plugin-beads frontend: a "Beads issues" tab in the thread side panel
// showing the issue graph of the thread's environment checkout.
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_DetailRow as DetailRow,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_useRpcQuery,
  experimental_useTabVisible,
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
  RefreshCw,
  Tag,
  Timer,
  User,
} from "lucide-react";
import { type CSSProperties, useMemo, useRef, useState } from "react";
import {
  PANEL_LAYOUTS,
  rpcContract,
  type BdIssueNode,
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
    <span className="shrink-0 rounded-full bg-surface-recessed px-1.5 text-2xs leading-4 text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// List rows

const ROW_BASE =
  "mx-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

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
        <span className="min-w-0 max-w-[40%] shrink truncate text-2xs text-subtle-foreground">
          {parentTitle}
        </span>
      )}
      {extraLabel !== undefined && (
        <span className="shrink-0 rounded bg-surface-recessed px-1.5 text-2xs leading-4 text-muted-foreground">
          {extraLabel}
        </span>
      )}
      {issue.dueAt !== null && (
        <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums" title="Due">
          {formatDay(issue.dueAt)}
        </span>
      )}
      {progress.total > 0 && (
        <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums" title="Sub-issues closed">
          {progress.done}/{progress.total}
        </span>
      )}
      {issue.priority <= 1 && (
        <span
          className="shrink-0 text-2xs font-semibold tabular-nums"
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
        style={{ paddingLeft: `${depth * 16 + 2}px` }}
        onClick={() => onSelect(issue.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSelect(issue.id);
          else if (event.key === "ArrowRight" && kids.length > 0) setExpanded(true);
          else if (event.key === "ArrowLeft" && kids.length > 0) setExpanded(false);
        }}
      >
        {kids.length > 0 ? (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground hover:text-foreground"
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
          <span className="w-4 shrink-0" />
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
    <div role="tree" aria-label="Issues" className="py-1">
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
              className="flex w-full items-center gap-1.5 px-3 pb-1 pt-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
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
      className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border bg-surface-raised px-2 text-2xs text-foreground"
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
                className="text-2xs font-semibold tabular-nums"
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

// Prose fields render images as thumbnails rather than at full size.
const PROSE_CLASS =
  "text-[13px] leading-relaxed [&_img]:max-h-40 [&_img]:max-w-full [&_img]:rounded";

function IssueDetail({
  threadId,
  checkout,
  issue,
  index,
  onSelect,
}: {
  threadId: string;
  checkout: IssuesCheckout | null;
  issue: BdIssueNode;
  index: IssueIndex;
  onSelect: (id: string) => void;
}) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "issue_show",
    input: { threadId, id: issue.id },
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
  const [copied, setCopied] = useState(false);
  // A virtual document at the checkout root, so bb resolves relative image
  // sources and file links (`assets/x.png`, `docs/spec.md`) against the project.
  const markdownDocument = useMemo(
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
    <div className="space-y-4 px-3.5 pb-6 pt-3">
      <header>
        <div className="group flex items-center gap-1.5 font-mono text-2xs text-subtle-foreground">
          <TypeGlyph type={issue.type} />
          <span className="truncate">{issue.id}</span>
          <button
            className="flex h-4 w-4 items-center justify-center rounded opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            aria-label="Copy issue ID"
            onClick={copyId}
          >
            <Copy className="h-3 w-3" />
          </button>
          {copied && <span className="font-sans">Copied</span>}
        </div>
        <h2 className="mt-0.5 text-[15px] font-semibold leading-snug text-foreground [text-wrap:pretty]">
          {issue.title}
        </h2>
        <div className="mt-2 flex flex-wrap gap-1">
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
              className="min-w-0 truncate text-left text-foreground underline decoration-border underline-offset-[3px] hover:decoration-foreground"
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
                  className="rounded bg-surface-recessed px-1.5 text-2xs leading-4 text-muted-foreground"
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
        <p className="text-2xs text-subtle-foreground">
          Created {formatRelative(show.created_at)}
          {show.created_by ? ` by ${show.created_by}` : ""}
          {issue.commentCount > 0 ? ` · ${issue.commentCount} comments` : ""}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel

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
        className="group flex h-2.5 shrink-0 cursor-row-resize touch-none items-center outline-none"
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setSplit((current) => clampSplit(current + (event.key === "ArrowUp" ? -0.05 : 0.05)));
          }
        }}
      >
        <div className="h-px flex-1 bg-border group-hover:bg-ring group-focus-visible:bg-ring" />
      </div>
      <div className="min-h-0 overflow-y-auto" style={{ flex: `${1 - split} 1 0%` }}>
        {bottom}
      </div>
    </div>
  );
}

function BeadsPanel({ threadId }: { threadId: string }) {
  const visible = experimental_useTabVisible();
  const layout = parseLayout(useSettings().values?.layout);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
          ? { text: "No issues found.", error: false }
          : null;

  const toolbar = (
    <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
      <span className="text-xs font-medium text-muted-foreground">Issues</span>
      {query.data !== undefined && <CountPill>{openCount} open</CountPill>}
      <span className="flex-1" />
      <button
        className="flex h-6 w-6 items-center justify-center rounded-md text-subtle-foreground hover:bg-surface-recessed hover:text-foreground"
        aria-label="Refresh"
        title="Refresh"
        onClick={() => void query.refetch()}
      >
        <RefreshCw className={"h-3.5 w-3.5" + (query.isFetching ? " animate-spin" : "")} />
      </button>
    </div>
  );

  if (message !== null) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <p
          className={
            "whitespace-pre-wrap px-3 text-xs " +
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
              className="flex h-9 shrink-0 items-center gap-1 px-3 text-xs text-subtle-foreground hover:text-foreground"
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
              <IssueTree index={index} selectedId={null} onSelect={setSelectedId} />
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
