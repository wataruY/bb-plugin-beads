---
name: beads
description: "Manage the beads issue tracker (bd CLI) from BB threads and the shell."
---

# Beads

Beads (https://beads.gascity.com) is a dependency-aware issue tracker for AI
agents, stored in a Dolt database under `.beads/` in the repo. IDs are
collision-resistant hashes (`epic bd-a3f8` → `task bd-a3f8.1`), so multiple
agents/branches never clash. The `bd` CLI manages it.

## From agent threads

Call the `beads` tool with `bd` arguments. It runs in the thread's
environment checkout:

- `beads({ args: ["prime"] })` — AI-optimized workflow context; run this
  first in a session to get the protocol
- `beads({ args: ["list"] })` / `["show", "bd-a1b2"]` / `["ready"]`
- `beads({ args: ["create", "Summary", "-t", "task", "-p", "2"] })`
  (note: `--parent <id>` sets the parent — `-p` is priority)
- `beads({ args: ["update", "bd-a1b2", "--status", "in_progress"] })` before
  starting, `["close", "bd-a1b2"]` when done

Many commands accept `--json` when you need to parse the result.

## From the shell

- `bb beads -- list` — run any `bd` command
- `bb beads check` — verify the `bd` binary is reachable
- `bb plugin config beads` — set the `bd` binary path if it is not on PATH
  (setting "Path to the `bd` beads CLI", default `bd`)

Gotchas: `bd delete` only prints a preview without `--force`; set an issue's
status with `bd update <id> --status <status>` (there is no
`bd status <id> <status>` command).

## Side panel

A **Beads issues** tab in the thread side panel (thread menu → "Beads issues")
shows the issue tree of the thread's checkout: status dots, priorities,
types, and a detail pane (description, dependencies, timestamps). It refreshes
automatically after any mutating `bd` command (agent tool or CLI) succeeds.
Users can also create issues (+ in the toolbar) and edit them (Edit in the
detail header) from the panel; those writes refresh the tree the same way.

## Setup

`bd` must be installed on the BB host machine. In a repo without beads yet,
run `beads({ args: ["init", "--skip-agents", "--non-interactive"] })` once
(plain `init` also installs Claude/Codex/Cursor editor integrations).
