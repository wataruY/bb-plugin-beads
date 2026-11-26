// The panel's issue model and list filtering: pure functions shared by the
// panel and scripts/filter-check.ts. No React or SDK imports and type-only
// imports from the contract, so it runs under `node --experimental-strip-types`.
import type { BdIssueNode, ListView } from "./contract.js";

// ---------------------------------------------------------------------------
// Domain model: one index over the `issues_tree` rows, shared by every list
// view and by the detail pane's relation lists.

// In chip order.
export const STATUSES = ["open", "in_progress", "blocked", "deferred", "closed"] as const;
export type Status = (typeof STATUSES)[number];

export type IssueIndex = {
  byId: Map<string, BdIssueNode>;
  roots: BdIssueNode[];
  children: Map<string, BdIssueNode[]>;
  // Reverse of `blockedBy`: issue id -> the issues waiting on it.
  blocks: Map<string, BdIssueNode[]>;
  // Labels every issue carries say nothing in a row; show them only in detail.
  sharedLabels: Set<string>;
  // The checkout's issue prefix, stripped for short ids.
  issuePrefix: string | null;
};

// List preferences kept per project on this device (localStorage), as opposed
// to the view settings the settings page shares.
export type ViewPrefs = { hiddenStatuses: Status[]; showIds: boolean };

// What a list view shows for a query and a set of hidden statuses.
export type IssueFilter = {
  // Issues the view renders that match the query and whose status is shown.
  matches: Set<string>;
  // Ancestors of a match that are not matches themselves, whatever their
  // status: the tree shows them dimmed so a match keeps its place.
  context: Set<string>;
  // Issues the view renders that match the query but are hidden by their
  // status.
  hiddenByStatus: Record<Status, number>;
};

export function compareIssues(a: BdIssueNode, b: BdIssueNode): number {
  return (
    Number(a.status === "closed") - Number(b.status === "closed") ||
    a.priority - b.priority ||
    a.title.localeCompare(b.title)
  );
}

export function buildIndex(issues: BdIssueNode[], issuePrefix: string | null): IssueIndex {
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
  return { byId, roots, children, blocks, sharedLabels, issuePrefix };
}

// An open issue waiting on an unclosed blocker counts as blocked.
export function effectiveStatus(issue: BdIssueNode, index: IssueIndex): Status {
  if (issue.status === "closed") return "closed";
  const waiting = issue.blockedBy.some(
    (id) => (index.byId.get(id)?.status ?? "open") !== "closed",
  );
  if (waiting || issue.status === "blocked") return "blocked";
  if (issue.status === "in_progress" || issue.status === "deferred") return issue.status;
  return "open";
}

// `bd` accepts the id without the checkout's issue prefix (`bd show fvn.1.3`),
// so the short form can be pasted straight to an agent. An id that does not
// carry the prefix (created with a custom --id) stays whole.
export function shortId(id: string, prefix: string | null): string {
  return prefix !== null && id.startsWith(`${prefix}-`) ? id.slice(prefix.length + 1) : id;
}

// ---------------------------------------------------------------------------
// Search and status filtering

function zeroCounts(): Record<Status, number> {
  return { open: 0, in_progress: 0, blocked: 0, deferred: 0, closed: 0 };
}

// Every issue in the index by effective status, whatever the query.
export function countByStatus(index: IssueIndex): Record<Status, number> {
  const counts = zeroCounts();
  for (const issue of index.byId.values()) counts[effectiveStatus(issue, index)] += 1;
  return counts;
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((token) => token !== "");
}

// A query of only whitespace filters nothing.
export function queryActive(query: string): boolean {
  return queryTokens(query).length > 0;
}

// Where the query's title tokens (not #label tokens) occur in `text`, as
// sorted, merged [start, end) ranges for highlighting.
export function matchRanges(text: string, query: string): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const token of queryTokens(query)) {
    if (token.startsWith("#")) continue;
    for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + token.length)) {
      ranges.push([at, at + token.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// Every whitespace-separated token must match, case-insensitively, as a
// substring of the id, the title or a label; a `#token` matches labels only.
// Every id carries the checkout's '<prefix>-', so a token wholly inside it
// ('beads', 'plugin') would match every issue: it matches the id only where
// it reaches past the prefix ('fvn.1', 'bb-plugin-beads-fvn.1'). An id
// without the prefix (a custom --id) is matched in full.
export function matchesQuery(issue: BdIssueNode, query: string, prefix: string | null): boolean {
  const id = issue.id.toLowerCase();
  const short = shortId(issue.id, prefix).toLowerCase();
  const head = id.slice(0, id.length - short.length);
  const title = issue.title.toLowerCase();
  const labels = issue.labels.map((label) => label.toLowerCase());
  return queryTokens(query).every((token) => {
    if (token.startsWith("#")) return labels.some((label) => label.includes(token.slice(1)));
    const idHit = short.includes(token) || (!head.includes(token) && id.includes(token));
    return idHit || title.includes(token) || labels.some((label) => label.includes(token));
  });
}

// Whether a list view shows the issue as a row. The status view skips epics:
// they are containers, not work items, and their children carry them as a
// crumb.
function rendersIssue(issue: BdIssueNode, view: ListView): boolean {
  return view === "tree" || issue.type !== "epic";
}

// Counts cover only the rows the view renders, so the list note agrees with
// the list.
export function filterIssues(
  index: IssueIndex,
  query: string,
  hidden: readonly Status[],
  view: ListView,
): IssueFilter {
  const matches = new Set<string>();
  const context = new Set<string>();
  const hiddenByStatus = zeroCounts();
  for (const issue of index.byId.values()) {
    if (!rendersIssue(issue, view) || !matchesQuery(issue, query, index.issuePrefix)) continue;
    const status = effectiveStatus(issue, index);
    if (hidden.includes(status)) hiddenByStatus[status] += 1;
    else matches.add(issue.id);
  }
  for (const id of matches) {
    let parent = index.byId.get(id)?.parent ?? null;
    while (parent !== null && index.byId.has(parent) && !matches.has(parent) && !context.has(parent)) {
      context.add(parent);
      parent = index.byId.get(parent)?.parent ?? null;
    }
  }
  return { matches, context, hiddenByStatus };
}

// ---------------------------------------------------------------------------
// View preferences

export const DEFAULT_VIEW_PREFS: ViewPrefs = { hiddenStatuses: ["deferred", "closed"], showIds: false };

function isStatus(value: unknown): value is Status {
  return STATUSES.some((status) => status === value);
}

// The stored JSON is untrusted: a missing, corrupt or foreign value falls
// back to the defaults field by field.
export function parseViewPrefs(raw: string | null): ViewPrefs {
  let value: unknown = null;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {
    // Corrupt JSON: defaults.
  }
  if (typeof value !== "object" || value === null) return DEFAULT_VIEW_PREFS;
  const { hiddenStatuses, showIds } = value as Record<string, unknown>;
  return {
    hiddenStatuses:
      Array.isArray(hiddenStatuses) && hiddenStatuses.every(isStatus)
        ? STATUSES.filter((status) => hiddenStatuses.includes(status))
        : DEFAULT_VIEW_PREFS.hiddenStatuses,
    showIds: typeof showIds === "boolean" ? showIds : DEFAULT_VIEW_PREFS.showIds,
  };
}
