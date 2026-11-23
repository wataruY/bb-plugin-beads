// bb-plugin-beads frontend: a "Beads issues" tab in the thread side panel
// showing the issue tree of the thread's environment checkout.
import {
  definePluginApp,
  experimental_useRpcQuery,
  experimental_useTabVisible,
  Markdown,
} from "@get-bb/plugin-sdk/app";
import { Ban, CalendarClock, Timer } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { rpcContract, type BdIssueNode } from "./contract.js";

type IssueShow = {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  owner?: string;
  description?: string;
  acceptance_criteria?: string;
  design?: string;
  notes?: string;
  labels?: string[];
  due_at?: string;
  estimated_minutes?: number;
  created_at?: string;
  updated_at?: string;
  parent?: string;
  comment_count?: number;
  dependencies?: {
    id: string;
    title: string;
    status: string;
    dependency_type: string;
  }[];
};

const STATUS_DOT: Record<string, string> = {
  open: "bg-primary",
  in_progress: "bg-primary animate-pulse",
  blocked: "bg-destructive",
  deferred: "bg-muted-foreground",
  closed: "bg-border",
};

// Static class strings (Tailwind needs literal class names to emit them).
const PRIORITY_BADGE: Record<number, string> = {
  0: "bg-red-500/20 text-red-700 dark:text-red-300",
  1: "bg-orange-500/20 text-orange-700 dark:text-orange-300",
  2: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  3: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  4: "bg-zinc-500/20 text-zinc-600 dark:text-zinc-400",
};

function priorityBadge(priority: number): string {
  return PRIORITY_BADGE[priority] ?? PRIORITY_BADGE[2];
}

function statusDot(status: string): string {
  return STATUS_DOT[status] ?? "bg-muted-foreground";
}

function formatTime(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatDue(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString();
}

type TreeLevel = { roots: BdIssueNode[]; children: Map<string, BdIssueNode[]> };

function buildTree(issues: BdIssueNode[]): TreeLevel {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const roots: BdIssueNode[] = [];
  const children = new Map<string, BdIssueNode[]>();
  for (const issue of issues) {
    if (issue.parent !== null && byId.has(issue.parent)) {
      const siblings = children.get(issue.parent) ?? [];
      siblings.push(issue);
      children.set(issue.parent, siblings);
    } else {
      roots.push(issue);
    }
  }
  const sort = (list: BdIssueNode[]): void => {
    list.sort(
      (a, b) => a.priority - b.priority || a.title.localeCompare(b.title),
    );
  };
  sort(roots);
  for (const list of children.values()) sort(list);
  return { roots, children };
}

function IssueRow({
  issue,
  depth,
  tree,
  selectedId,
  onSelect,
}: {
  issue: BdIssueNode;
  depth: number;
  tree: TreeLevel;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const kids = tree.children.get(issue.id) ?? [];
  const isClosed = issue.status === "closed";
  return (
    <div>
      <div
        className={
          "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-sm hover:bg-accent " +
          (selectedId === issue.id ? "bg-accent" : "")
        }
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => onSelect(issue.id)}
      >
        {kids.length > 0 ? (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center text-xs text-muted-foreground"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDot(issue.status)}`}
          aria-label={issue.status}
        />
        <span
          className={
            "min-w-0 flex-1 truncate " +
            (isClosed ? "text-muted-foreground line-through" : "")
          }
        >
          {issue.title}
        </span>
        {issue.hasBlockingDeps && (
          <Ban
            className="h-3 w-3 shrink-0 text-destructive"
            aria-label="Blocked by an open dependency"
          />
        )}
        {issue.dueAt !== null && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
            title={`Due ${formatDue(issue.dueAt)}`}
          >
            <CalendarClock className="h-3 w-3" />
            {formatDue(issue.dueAt)}
          </span>
        )}
        {issue.estimatedMinutes !== null && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
            title="Time estimate"
          >
            <Timer className="h-3 w-3" />
            {issue.estimatedMinutes}m
          </span>
        )}
        {issue.labels.slice(0, 2).map((label) => (
          <span
            key={label}
            className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
          >
            {label}
          </span>
        ))}
        {issue.labels.length > 2 && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            +{issue.labels.length - 2}
          </span>
        )}
        <span
          className={`shrink-0 rounded px-1 text-[10px] font-medium ${priorityBadge(issue.priority)}`}
        >
          P{issue.priority}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {issue.type}
        </span>
      </div>
      {expanded &&
        kids.map((kid) => (
          <IssueRow
            key={kid.id}
            issue={kid}
            depth={depth + 1}
            tree={tree}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function IssueDetail({
  threadId,
  issueId,
}: {
  threadId: string;
  issueId: string;
}) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "issue_show",
    input: { threadId, id: issueId },
  });
  const issue = useMemo<IssueShow | null>(() => {
    if (query.data?.json == null) return null;
    try {
      const parsed: unknown = JSON.parse(query.data.json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed[0] as IssueShow;
      }
      return null;
    } catch {
      return null;
    }
  }, [query.data?.json]);

  if (query.isLoading && issue === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (issue === null) {
    return (
      <p className="text-sm text-destructive">
        {query.data?.error ?? query.error?.message ?? "Could not load this issue."}
      </p>
    );
  }
  const deps = (issue.dependencies ?? []).filter(
    (dep) => dep.dependency_type !== "parent-child",
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${statusDot(issue.status)}`} />
        <span className="font-medium">{issue.status}</span>
        <span className="text-muted-foreground">{issue.issue_type}</span>
        <span
          className={`rounded px-1 text-[10px] font-medium ${priorityBadge(issue.priority)}`}
        >
          P{issue.priority}
        </span>
        {(issue.labels ?? []).map((label) => (
          <span
            key={label}
            className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
          >
            {label}
          </span>
        ))}
      </div>
      {issue.description != null && issue.description !== "" ? (
        <Markdown content={issue.description} className="text-sm" />
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
      {issue.acceptance_criteria != null && issue.acceptance_criteria !== "" && (
        <DetailSection title="Acceptance">
          <Markdown content={issue.acceptance_criteria} className="text-sm" />
        </DetailSection>
      )}
      {issue.design != null && issue.design !== "" && (
        <DetailSection title="Design">
          <Markdown content={issue.design} className="text-sm" />
        </DetailSection>
      )}
      {issue.notes != null && issue.notes !== "" && (
        <DetailSection title="Notes">
          <p className="whitespace-pre-wrap text-sm">{issue.notes}</p>
        </DetailSection>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <dt>ID</dt>
        <dd className="truncate">{issue.id}</dd>
        {issue.parent != null && (
          <>
            <dt>Parent</dt>
            <dd className="truncate">{issue.parent}</dd>
          </>
        )}
        {issue.owner != null && (
          <>
            <dt>Owner</dt>
            <dd className="truncate">{issue.owner}</dd>
          </>
        )}
        {issue.created_at != null && (
          <>
            <dt>Created</dt>
            <dd>{formatTime(issue.created_at)}</dd>
          </>
        )}
        {issue.updated_at != null && (
          <>
            <dt>Updated</dt>
            <dd>{formatTime(issue.updated_at)}</dd>
          </>
        )}
        {issue.due_at != null && (
          <>
            <dt>Due</dt>
            <dd>{formatDue(issue.due_at)}</dd>
          </>
        )}
        {issue.estimated_minutes != null && (
          <>
            <dt>Estimate</dt>
            <dd>{issue.estimated_minutes}m</dd>
          </>
        )}
      </dl>
      {deps.length > 0 && (
        <DetailSection title="Dependencies">
          <ul className="space-y-1">
            {deps.map((dep) => (
              <li
                key={`${dep.dependency_type}-${dep.id}`}
                className="flex items-center gap-1.5 text-sm"
              >
                <span className="shrink-0 text-xs text-muted-foreground">
                  {dep.dependency_type}
                </span>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${statusDot(dep.status)}`}
                  aria-label={dep.status}
                />
                <span className="min-w-0 truncate">{dep.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {dep.id}
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
    </div>
  );
}

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

function clampSplit(value: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

function BeadsPanel({ threadId }: { threadId: string }) {
  const visible = experimental_useTabVisible();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Fraction of the panel height taken by the tree pane; the detail pane
  // gets the rest below the drag handle.
  const [split, setSplit] = useState(0.55);
  const splitRef = useRef<HTMLDivElement>(null);
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "issues_tree",
    input: { threadId },
    enabled: visible,
  });
  const tree = useMemo(
    () => buildTree(query.data?.issues ?? []),
    [query.data?.issues],
  );
  const issues = query.data?.issues ?? [];
  const openCount = issues.filter((issue) => issue.status !== "closed").length;

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const container = splitRef.current?.parentElement;
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

  const onDividerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSplit((current) => clampSplit(current - 0.05));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSplit((current) => clampSplit(current + 0.05));
    }
  };

  const showSplit =
    query.data !== undefined &&
    query.data.error == null &&
    issues.length > 0;

  const treePane = (
    <div
      className="min-h-0 overflow-y-auto"
      style={showSplit ? { flex: `${split} 1 0%` } : { flex: "1 1 0%" }}
    >
      {query.isLoading && query.data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading issues…</p>
      ) : query.data?.error != null ? (
        <p className="whitespace-pre-wrap text-sm text-destructive">
          {query.data.error}
        </p>
      ) : tree.roots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No issues found.</p>
      ) : (
        tree.roots.map((root) => (
          <IssueRow
            key={root.id}
            issue={root}
            depth={0}
            tree={tree}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ))
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Beads issues
          {query.data !== undefined && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {openCount} open
            </span>
          )}
        </h2>
        <button
          className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void query.refetch()}
        >
          Refresh
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {treePane}
        {showSplit && (
          <>
            <div
              ref={splitRef}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize tree and detail panes"
              tabIndex={0}
              className="my-1 flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center rounded outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
              onPointerDown={startDrag}
              onKeyDown={onDividerKeyDown}
            >
              <div className="h-1 w-8 rounded bg-muted-foreground/40" />
            </div>
            <div
              className="min-h-0 overflow-y-auto rounded border border-border bg-card p-3"
              style={{ flex: `${1 - split} 1 0%` }}
            >
              {selectedId !== null ? (
                <IssueDetail threadId={threadId} issueId={selectedId} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select an issue to see its details.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
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
