# Agent Instructions

A [BB](https://getbb.app) plugin that integrates
[beads](https://beads.gascity.com) — the dependency-aware, Dolt-backed issue
tracker for AI coding agents (`bd` CLI) — into BB threads and the shell.

## Surfaces

- **`beads` agent tool** (`server.ts`) — runs any `bd` command in the
  thread's environment checkout through the plugin's full-trust `bb.host`
  worker.
- **Beads issues side panel** (`app.tsx`) — thread side-panel tab. The
  `listView` setting picks `tree` (default) or `status` (issues grouped by In
  progress / Blocked / Ready / ...); `detailMode` picks `split` (default: the
  list over a draggable detail pane) or `drill` (the detail opens full height
  with a back link; always on coarse pointers). The panel writes both through
  the `settings_set` RPC. Status glyphs and priority use bb theme variables
  (`var(--timeline-accent)` etc.), not Tailwind palette classes. The detail
  pane uses bb's host components (`experimental_DetailRow`,
  `experimental_InfoSection`, `experimental_InfoList`); sub-issues, Blocked by
  and Blocks come from the `issues_tree` data, prose fields from `bd show`.
- **`bb beads` CLI** (`server.ts`) — `bb beads -- <bd-args...>` passthrough
  (arguments go to `bd` verbatim) and `bb beads check`.
- **`beads` skill** (`skills/beads/SKILL.md`) — standing instructions for
  agents.

## File map

- `server.ts` — backend entry: agent tool, CLI, settings, RPC handlers
  (`issues_tree`, `issue_show`, `issue_create`, `issue_update`).
- `app.tsx` — frontend entry: the side-panel tab (React, bundled by bb).
- `panel.css` — text colours derived from bb's tokens (`--beads-faint`,
  `--beads-caution`) that keep 4.5:1 contrast, and the faint context-row
  rule (`.beads-context`); bundled into `dist/app.css`.
- `contract.ts` — zod contracts: host (`bd_run`, `bd_check`, `beads_watch`
  and its `beads_changed` signal), frontend RPC,
  CLI. Keep the RPC node shapes in sync with `bd`'s JSON output.
- `host.ts` — `bb.host` worker that spawns `bd` (bounded output, timeouts).
- `skills/beads/SKILL.md` — agent instructions.

## Data flow

`app.tsx` → plugin RPC (`issues_tree`/`issue_show`, writes via
`issue_create`/`issue_update`) → `server.ts` →
`bb.hosts` worker (`host.ts`) → `bd` in the thread's environment checkout.
Successful **mutating** `bd` runs invalidate the `beads:issues` RPC tag so
every open panel refetches; read-only commands (see `READ_ONLY_BD_COMMANDS`
in `server.ts`) must stay excluded, or the panel's own refresh invalidates
itself in a loop.

Writes from outside the plugin (`bd` in a shell or an agent's terminal)
arrive through a watch. While a client watches a thread's `issues_tree`
(`bb.rpc.experimental_whileWatched`; a tab hidden for 5 s stops counting),
the server holds a `beads_watch` host call. The host resolves the database
directory with `bd where --json` (once per checkout) and watches it natively.
It emits `beads_changed` only when a Dolt `manifest` file's content changes.
Every access, reads included, rewrites the manifest, but only a committed
write changes its content, so the panel's own `bd list` cannot loop. No panel
watching means no watch and no `bd` process.

## Build & verify

```bash
npx tsc --noEmit        # typecheck (must be clean)
bb plugin build         # build dist/{app,server,host} bundles
bb plugin reload beads  # reload the installed plugin (path install)
bb beads check          # verify the bd binary is reachable
# end-to-end RPC test (write {"threadId":"thr_..."} to a file first):
bb plugin rpc call beads issues_tree --input-file /tmp/rpc-in.json
```

## Project constraints (learned the hard way)

- `bb plugin build` **manages `tsconfig.json`** — hand edits are regenerated;
  don't fight it. The SDK's bundled types reference host-side packages, so
  keep type-only devDependencies for them (`@types/better-sqlite3`, `hono`).
  `bb plugin types` repins the SDK entry (the SDK lives in `dependencies`).
- React and the SDK are **runtime-shimmed** by bb — never bundle them, import
  freely. `zod` and `lucide-react` bundle from your `node_modules` (keep them
  in `dependencies`).
- `bd` JSON output is snake_case (`issue_type`, `updated_at`, `labels`,
  `due_at`, `estimated_minutes`, `acceptance_criteria`, ...); the tree node
  contract maps it to camelCase. Dependency entries differ between commands:
  `bd list` uses `issue_id`/`depends_on_id`/`type`, `bd show` uses
  `id`/`title`/`status`/`dependency_type`. The tree node's `blockedBy` keeps
  only `type: "blocks"` targets; an issue counts as blocked while one of them
  is not closed.
- `experimental_DetailRow` icons resolve by name; lucide components must be
  registered via `app.experimental_icons.register` wrapped in a plain function
  (forwardRef objects are rejected and the whole app registration fails).
- `bd delete` only prints a preview without `--force`; set an issue's status
  with `bd update <id> --status <s>` (there is no `bd status <id> <s>`).
- The side panel writes only through `issue_create`/`issue_update`: the
  frontend sends an `IssueDraft` (or before/after drafts), and `server.ts`
  builds the `bd` argv (`createArgs`, `updatePlan`). Never accept raw argv
  from the frontend. Pass values as `--flag=value` so text starting with `-`
  is not read as a flag. Edits pass `--if-revision` (exit 13 = stale);
  `--notes` over existing notes needs `--force` in its own run, and clearing
  uses `--clear-notes`.
<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6ffdf896 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for durable project facts — not per-tool memory files, which fragment across accounts; keep per-operator preferences in your harness's own memory

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep durable project facts in Beads via `bd remember` rather than in per-tool memory files, which fragment across accounts; per-operator preferences belong in your harness's own memory.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->

## UI debugging

Use the `bb-ui-debug` skill (`skills/bb-ui-debug/`, deployed by `apm install`
from `apm.yml`): drives the BB UI through `bb browser` + raw CDP. Playwright
`connectOverCDP` crashes on bb's tab target, so don't use it.
