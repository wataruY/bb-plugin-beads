// Unit check for filter.ts: node --experimental-strip-types scripts/filter-check.ts
// Exits non-zero on the first failed assertion.
import assert from "node:assert/strict";
import type { BdIssueNode } from "../contract.ts";
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
  shortId,
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
const ids = (query: string, hidden: Parameters<typeof filterIssues>[2] = []): string[] =>
  sorted(filterIssues(index, query, hidden).matches);
const get = (id: string): BdIssueNode => index.byId.get(id)!;

// An open issue waiting on an open blocker is Blocked, and the Blocked chip hides it.
assert.equal(get("proj-b").status, "open");
assert.equal(effectiveStatus(get("proj-b"), index), "blocked");
const noBlocked = filterIssues(index, "", ["blocked"]);
assert.ok(!noBlocked.matches.has("proj-b"));
assert.equal(noBlocked.hiddenByStatus.blocked, 1);
assert.ok(filterIssues(index, "", []).matches.has("proj-b"));

// '#ui' matches labels only (substring); plain 'ui' also matches titles.
assert.deepEqual(ids("#ui"), ["proj-d", "proj-e.1"]);
assert.ok(!matchesQuery(get("proj-g"), "#ui"));
assert.ok(matchesQuery(get("proj-g"), "ui"));

// A label on every issue (hidden in rows) is still searchable.
assert.ok(index.sharedLabels.has("shared"));
assert.equal(ids("shared").length, index.byId.size);
assert.equal(ids("#shared").length, index.byId.size);

// Tokens AND together, case-insensitively.
assert.deepEqual(ids("TREE view"), ["proj-b", "proj-e.1"]);
assert.deepEqual(ids("tree refreshed"), ["proj-e.1.1"]);

// Ancestors of a match land in context, not in matches.
const refreshed = filterIssues(index, "refreshed", []);
assert.deepEqual(sorted(refreshed.matches), ["proj-e.1.1"]);
assert.deepEqual(sorted(refreshed.context), ["proj-e", "proj-e.1"]);

// With closed hidden and no query, a closed epic with an open child is context.
const defaults = filterIssues(index, "", DEFAULT_VIEW_PREFS.hiddenStatuses);
assert.ok(defaults.matches.has("proj-c.1"));
assert.ok(defaults.context.has("proj-c"));
assert.ok(!defaults.matches.has("proj-c"));

// hiddenByStatus counts query matches hidden by status.
assert.deepEqual(defaults.hiddenByStatus, { open: 0, in_progress: 0, blocked: 0, deferred: 1, closed: 1 });
const oldEpic = filterIssues(index, "old", ["closed"]);
assert.equal(oldEpic.matches.size, 0);
assert.equal(oldEpic.hiddenByStatus.closed, 1);

// Ids: the full id and the short id match by substring.
assert.deepEqual(ids("e.1.1"), ["proj-e.1.1"]);
assert.deepEqual(ids("proj-e.1.1"), ["proj-e.1.1"]);
assert.deepEqual(ids("proj").length, index.byId.size - 1);
assert.ok(!ids("proj").includes("custom-9"));
assert.equal(shortId("proj-e.1.1", "proj"), "e.1.1");
assert.equal(shortId("custom-9", "proj"), "custom-9");
assert.equal(shortId("proj-e", null), "proj-e");
assert.deepEqual(ids("custom-9"), ["custom-9"]);

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

console.log("filter-check: ok");
