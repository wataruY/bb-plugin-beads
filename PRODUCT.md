# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is one developer who runs coding agents in bb (getbb.app) and
supervises their work. Agents file, update, and close beads issues as they
work. The user reviews that issue graph, tidies it, and files issues of their
own: new work, bugs found while reviewing, or epics that split a larger goal.

The design targets the user on a phone, reaching their bb remotely through
getbb.app away from the desk. They check what agents are doing, what is
blocked, and what is ready. Then they file or adjust an issue by touch before
handing work back to an agent. On desktop the same panel sits in bb's narrow
thread side panel.

## Product Purpose

bb-plugin-beads brings the beads issue tracker (`bd`, a dependency-aware,
Dolt-backed tracker built for AI coding agents) into bb. It has these
surfaces:

- the `beads` agent tool, which agents use to run `bd` commands;
- the `bb beads` CLI passthrough;
- standing agent instructions in a skill;
- the Beads issues side panel, the user's own view of the graph.

The panel succeeds when the user, at a glance and on a small screen, knows:

- the state of the work;
- what is blocked and by what;
- what an epic still needs.

It also succeeds when filing or editing an issue takes seconds and never goes
through a chat message to an agent.

## Positioning

beads is the agents' own tracker: agents write to it directly, and issues
carry real dependency edges (`blocks`, parent/child) that decide what is
ready. The panel is the human's window into that shared graph, inside the
same bb thread where the agents run. It is not a separate tracker with a
sync step. Status, blocking, and readiness come from `bd` itself, so the
human and the agents always see the same truth.

## Operating Context

- **Where it runs:** a bb plugin, shown as a thread side-panel tab. It reads
  and writes the `bd` database of the thread's environment checkout through
  the plugin's host worker.
- **Clients:** bb desktop (a narrow side panel next to the chat) and bb on a
  phone over getbb.app remote access, where the panel fills the screen width
  and the user works by touch.
- **Concurrent writers:** agents write to the same graph while the panel is
  open. Every write to the graph refreshes the open panel within a second,
  whether it came through the plugin or from `bd` in a shell. Edits from
  the panel are guarded by the issue's revision, so a concurrent change is
  refused rather than overwritten.
- **Vocabulary from beads:**
  - statuses: open, in_progress, blocked, deferred, closed;
  - priorities: P0 Critical to P4 Backlog;
  - types: task, bug, feature, epic, chore, story, spike, decision,
    milestone;
  - parent/child (epics and sub-issues);
  - "blocked by" / "blocks" dependencies, and "ready" (open with no open
    blockers);
  - labels, acceptance criteria, design, notes.

## Capabilities and Constraints

The panel can:

- arrange the list with two view settings, set in plugin settings or from
  the panel header:
  - list view: Tree (epics and sub-issues) or Status (grouped by workflow
    state);
  - detail mode, desktop only: Split (list over detail) or Full height. On a
    phone the detail always opens full height;
- search the list by id, title, or label, where `#label` matches labels
  only;
- filter by status with chips that show each status's count. Deferred and
  closed are hidden by default, and the choice is kept per device;
- overlay short issue IDs on rows on demand, so an issue can be named
  without opening it;
- show issue detail: status, priority, type, parent, owner, labels, due date,
  estimate, Markdown description, acceptance, design and notes, sub-issue
  progress, "blocked by", and "blocks";
- create and edit issues in one shared form with create and edit variants:
  title, description, status, priority, type (including epic), parent,
  labels, blocked by, blocks, acceptance, design, and notes.

Constraints:

- The UI is built from bb's host components and theme variables (React and
  the plugin SDK are provided by bb at runtime). It follows bb's light/dark
  theme and must not introduce its own palette or fonts.
- The frontend never sends raw `bd` arguments. The server builds them from a
  typed draft.
- Owner/assignee, due date, and estimate are not editable from the panel yet.
  This is undecided, not refused.

## Product Principles

1. **Legibility before style.** Each state (status, blocked, priority,
   progress) has to read at a glance on a phone in daylight. Expression
   never costs legibility.
2. **Touch is a first-class input.** Every action works with one thumb on a
   phone. Desktop density is a refinement on top, never the baseline.
3. **Familiar issue-tracker conventions.** Use the patterns users know from
   GitHub, Linear, and Jira: title-first forms, property chips, sub-issues,
   and blocked-by relations. Being familiar beats being novel.
4. **One truth with the agents.** The panel shows what `bd` says and writes
   through `bd`. It never invents state, and it never silently overwrites an
   agent's concurrent change.
5. **Feels like part of bb.** Use bb's components, theme, and tone. The panel
   is a tab in bb, not a separate app.

## Accessibility & Inclusion

- State is never carried by colour alone. Status glyph shapes differ
  (ring, half fill, slash, dashed ring, check).
- Touch targets fit phone use, and text stays readable at phone size.
- Everything works in bb's light and dark themes.
