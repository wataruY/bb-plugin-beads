// Unit check for filter.ts: node --experimental-strip-types scripts/filter-check.ts
// Exits non-zero on the first failed assertion.
import assert from "node:assert/strict";
import type { BdIssueNode, ListView } from "../contract.ts";
import {
  DEFAULT_VIEW_PREFS,
  buildIndex,
  countByStatus,
  effectiveStatus,
  filterIssues,
  matchRanges,
  matchesQuery,
  queryActive,
  parseViewPrefs,
  rowKeyAction,
  shortId,
  statusRows,
  treeRows,
  type ListRow,
} from "../filter.ts";

function issue(id: string, title: string, fields: Partial<BdIssueNode> = {}): BdIssueNode {
  return {
    id,
    title,
    status: "open",
    priority: 2,
    type: "task",
    parent: null,
    owner: null,
    updatedAt: null,
    labels: ["shared"],
    dueAt: null,
    estimatedMinutes: null,
    blockedBy: [],
    commentCount: 0,
    dependencyCount: 0,
    dependentCount: 0,
    ...fields,
  };
}

const index = buildIndex(
  [
    issue("proj-e", "Beads side panel", { type: "epic", labels: ["shared", "panel"] }),
    issue("proj-e.1", "Issue tree view", { parent: "proj-e", labels: ["shared", "ui"] }),
    issue("proj-e.1.1", "Tree not refreshed", { parent: "proj-e.1", status: "in_progress" }),
    issue("proj-b", "Waits on the tree view", { blockedBy: ["proj-e.1"] }),
    issue("proj-c", "Old epic", { type: "epic", status: "closed" }),
    issue("proj-c.1", "Leftover", { parent: "proj-c" }),
    issue("proj-d", "Someday", { status: "deferred", labels: ["shared", "uix"] }),
    issue("proj-g", "Write guidance", { labels: ["shared", "docs"] }),
    issue("custom-9", "Custom id"),
  ],
  "proj",
);
const sorted = (ids: Set<string>): string[] => [...ids].sort();
type Hidden = Parameters<typeof filterIssues>[2];
const ids = (query: string, hidden: Hidden = [], view: ListView = "tree"): string[] =>
  sorted(filterIssues(index, query, hidden, view).matches);
const get = (id: string): BdIssueNode => index.byId.get(id)!;

// An open issue waiting on an open blocker is Blocked, and the Blocked chip hides it.
assert.equal(get("proj-b").status, "open");
assert.equal(effectiveStatus(get("proj-b"), index), "blocked");
const noBlocked = filterIssues(index, "", ["blocked"], "tree");
assert.ok(!noBlocked.matches.has("proj-b"));
assert.equal(noBlocked.hiddenByStatus.blocked, 1);
assert.ok(filterIssues(index, "", [], "tree").matches.has("proj-b"));

// '#ui' matches labels only (substring); plain 'ui' also matches titles.
assert.deepEqual(ids("#ui"), ["proj-d", "proj-e.1"]);
assert.ok(!matchesQuery(get("proj-g"), "#ui", "proj"));
assert.ok(matchesQuery(get("proj-g"), "ui", "proj"));

// A label on every issue (hidden in rows) is still searchable.
assert.ok(index.sharedLabels.has("shared"));
assert.equal(ids("shared").length, index.byId.size);
assert.equal(ids("#shared").length, index.byId.size);

// Tokens AND together, case-insensitively.
assert.deepEqual(ids("TREE view"), ["proj-b", "proj-e.1"]);
assert.deepEqual(ids("tree refreshed"), ["proj-e.1.1"]);

// Ancestors of a match land in context, not in matches.
const refreshed = filterIssues(index, "refreshed", [], "tree");
assert.deepEqual(sorted(refreshed.matches), ["proj-e.1.1"]);
assert.deepEqual(sorted(refreshed.context), ["proj-e", "proj-e.1"]);

// With closed hidden and no query, a closed epic with an open child is context.
const defaults = filterIssues(index, "", DEFAULT_VIEW_PREFS.hiddenStatuses, "tree");
assert.ok(defaults.matches.has("proj-c.1"));
assert.ok(defaults.context.has("proj-c"));
assert.ok(!defaults.matches.has("proj-c"));

// hiddenByStatus counts query matches hidden by status.
assert.deepEqual(defaults.hiddenByStatus, { open: 0, in_progress: 0, blocked: 0, deferred: 1, closed: 1 });
const oldEpic = filterIssues(index, "old", ["closed"], "tree");
assert.equal(oldEpic.matches.size, 0);
assert.equal(oldEpic.hiddenByStatus.closed, 1);

// Ids: the full id and the short id match by substring. A token wholly inside
// the shared 'proj-' does not match ids.
assert.deepEqual(ids("e.1.1"), ["proj-e.1.1"]);
assert.deepEqual(ids("proj-e.1.1"), ["proj-e.1.1"]);
assert.deepEqual(ids("proj"), []);
assert.deepEqual(ids("j-"), []);
assert.deepEqual(ids("j-e.1"), ["proj-e.1", "proj-e.1.1"]);
assert.equal(shortId("proj-e.1.1", "proj"), "e.1.1");
assert.equal(shortId("custom-9", "proj"), "custom-9");
assert.equal(shortId("proj-e", null), "proj-e");
assert.deepEqual(ids("custom-9"), ["custom-9"]);

// The prefix guard on a repo-shaped index: 'beads' and 'plugin' sit inside
// 'bb-plugin-beads-', so they match titles, labels and custom ids only.
const repo = buildIndex(
  [
    issue("bb-plugin-beads-fvn", "Beads side panel", { type: "epic" }),
    issue("bb-plugin-beads-fvn.1", "Issue tree view", { parent: "bb-plugin-beads-fvn" }),
    issue("bb-plugin-beads-fvn.1.3", "Tree not refreshed", { parent: "bb-plugin-beads-fvn.1" }),
    issue("bb-plugin-beads-fvn.10", "Status view counts", { parent: "bb-plugin-beads-fvn" }),
    issue("bb-plugin-beads-x2", "Settings page", { labels: ["plugin"] }),
    issue("beads-roadmap", "Custom id"),
  ],
  "bb-plugin-beads",
);
const repoIds = (query: string): string[] => sorted(filterIssues(repo, query, [], "tree").matches);
assert.deepEqual(repoIds("beads"), ["bb-plugin-beads-fvn", "beads-roadmap"]);
assert.deepEqual(repoIds("plugin"), ["bb-plugin-beads-x2"]);
assert.deepEqual(repoIds("bb-plugin-beads-"), []);
assert.deepEqual(repoIds("bb-plugin-beads-fvn.1"), [
  "bb-plugin-beads-fvn.1",
  "bb-plugin-beads-fvn.1.3",
  "bb-plugin-beads-fvn.10",
]);
assert.deepEqual(repoIds("fvn.1.3"), ["bb-plugin-beads-fvn.1.3"]);
assert.deepEqual(repoIds("s-fvn.10"), ["bb-plugin-beads-fvn.10"]);
assert.deepEqual(repoIds("roadmap"), ["beads-roadmap"]);
assert.ok(matchesQuery(repo.byId.get("beads-roadmap")!, "beads", "bb-plugin-beads"));
assert.ok(!matchesQuery(repo.byId.get("bb-plugin-beads-fvn.1")!, "beads", "bb-plugin-beads"));
assert.ok(matchesQuery(repo.byId.get("bb-plugin-beads-fvn.1")!, "beads", null));

// The status view does not render epics, so its counts leave them out; the
// tree view counts them.
assert.deepEqual(ids("panel"), ["proj-e"]);
assert.deepEqual(ids("panel", [], "status"), []);
assert.equal(filterIssues(index, "old", ["closed"], "tree").hiddenByStatus.closed, 1);
assert.equal(filterIssues(index, "old", ["closed"], "status").hiddenByStatus.closed, 0);
assert.equal(ids("", [], "status").length, index.byId.size - 2);
assert.ok(!ids("", [], "status").some((id) => get(id).type === "epic"));

// Chip counts cover the whole index by effective status.
assert.deepEqual(countByStatus(index), { open: 5, in_progress: 1, blocked: 1, deferred: 1, closed: 1 });

// Highlight ranges: title tokens only, case-insensitive, merged.
assert.deepEqual(matchRanges("Tree not refreshed, tree", "TREE"), [[0, 4], [20, 24]]);
assert.deepEqual(matchRanges("Issue tree view", "#tree"), []);
assert.deepEqual(matchRanges("Issue tree view", "tree ree e v"), [[4, 5], [6, 10], [11, 12], [13, 14]]);
assert.deepEqual(matchRanges("ab", "a b"), [[0, 2]]);
assert.ok(!queryActive("   "));
assert.ok(queryActive(" #ui "));

// View preferences: defaults on missing or corrupt data, field by field otherwise.
assert.deepEqual(DEFAULT_VIEW_PREFS, { hiddenStatuses: ["deferred", "closed"], showIds: false });
for (const raw of [null, "", "{", "null", '"x"', "[1]", "42"]) {
  assert.deepEqual(parseViewPrefs(raw), DEFAULT_VIEW_PREFS, `raw ${String(raw)}`);
}
assert.deepEqual(parseViewPrefs('{"hiddenStatuses":["closed","bogus"],"showIds":true}'), {
  hiddenStatuses: ["deferred", "closed"],
  showIds: true,
});
assert.deepEqual(parseViewPrefs('{"hiddenStatuses":["closed","open"],"showIds":"yes"}'), {
  hiddenStatuses: ["open", "closed"],
  showIds: false,
});
assert.deepEqual(parseViewPrefs('{"hiddenStatuses":[],"showIds":false}'), {
  hiddenStatuses: [],
  showIds: false,
});

// List rows: the tree view flattens in display order with levels and parents;
// a collapsed branch hides its rows.
const keys = (rows: ListRow[]): string[] => rows.map((row) => `${row.level}:${row.key}`);
const all = filterIssues(index, "", [], "tree");
const open = treeRows(index, all, () => true);
assert.deepEqual(keys(open).slice(0, 3), ["1:proj-e", "2:proj-e.1", "3:proj-e.1.1"]);
assert.equal(open.find((row) => row.key === "proj-e.1.1")?.parent, "proj-e.1");
assert.equal(open.find((row) => row.key === "proj-g")?.expanded, null);
const shut = treeRows(index, all, (id) => id !== "proj-e");
assert.equal(shut.find((row) => row.key === "proj-e")?.expanded, false);
assert.ok(!shut.some((row) => row.parent === "proj-e"));
assert.equal(open.length, index.byId.size);

// The status view: a group row, then its issues one level down.
const grouped = statusRows(index, filterIssues(index, "", [], "status"), new Set(["open"]));
assert.deepEqual(keys(grouped).slice(0, 4), ["1:group:in_progress", "2:proj-e.1.1", "1:group:blocked", "2:proj-b"]);
assert.ok(grouped.some((row) => row.key === "group:open" && row.kind === "group" && !row.expanded && row.count === 4));
assert.ok(!grouped.some((row) => row.parent === "group:open"));

// Keys, per the WAI-ARIA tree pattern.
const at = (key: string): number => open.findIndex((row) => row.key === key);
assert.deepEqual(rowKeyAction(open, 0, "ArrowDown", false), { kind: "focus", at: 1 });
assert.deepEqual(rowKeyAction(open, 0, "ArrowUp", false), { kind: "focus", at: 0 });
assert.deepEqual(rowKeyAction(open, 2, "Home", false), { kind: "focus", at: 0 });
assert.deepEqual(rowKeyAction(open, 0, "End", false), { kind: "focus", at: open.length - 1 });
assert.deepEqual(rowKeyAction(open, at("proj-e"), "ArrowRight", false), { kind: "focus", at: at("proj-e.1") });
assert.deepEqual(rowKeyAction(open, at("proj-e"), "ArrowLeft", false), { kind: "toggle", at: at("proj-e"), open: false });
assert.deepEqual(rowKeyAction(open, at("proj-e"), "ArrowLeft", true), null);
assert.deepEqual(rowKeyAction(open, at("proj-e.1.1"), "ArrowLeft", false), { kind: "focus", at: at("proj-e.1") });
assert.deepEqual(rowKeyAction(open, at("proj-e.1"), "ArrowLeft", true), { kind: "focus", at: at("proj-e") });
assert.equal(rowKeyAction(open, at("proj-g"), "ArrowRight", false), null);
assert.deepEqual(rowKeyAction(shut, shut.findIndex((row) => row.key === "proj-e"), "ArrowRight", false), {
  kind: "toggle",
  at: shut.findIndex((row) => row.key === "proj-e"),
  open: true,
});
assert.deepEqual(rowKeyAction(open, 0, "Enter", false), { kind: "activate", at: 0 });
assert.deepEqual(rowKeyAction(grouped, 0, "Enter", false), { kind: "toggle", at: 0, open: false });
assert.deepEqual(rowKeyAction(grouped, 1, "ArrowLeft", false), { kind: "focus", at: 0 });
assert.equal(rowKeyAction(open, 0, "a", false), null);

console.log("filter-check: ok");
