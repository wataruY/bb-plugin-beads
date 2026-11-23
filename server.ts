// bb-plugin-beads — integrate the beads issue tracker (https://beads.gascity.com)
// into BB.
//
// Headless plugin with three surfaces:
//  1. The `beads` agent tool: runs `bd` commands in the thread's environment
//     checkout through the plugin's bb.host worker.
//  2. The `bb beads` CLI: same passthrough from a shell.
//  3. skills/beads/SKILL.md: standing instructions for agents.
import { PLUGIN_CLI_OUTPUT_MAX_BYTES, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  hostSignals,
  PANEL_LAYOUTS,
  rpcContract,
  type BdIssueNode,
  type IssueDraft,
} from "./contract.js";

const BD_TIMEOUT_MS = 5 * 60_000;
const TOOL_OUTPUT_MAX = 20_000;

interface ThreadEnv {
  cwd: string;
  hostId: string;
  // Null for the CLI fallback, which runs in a bare shell directory.
  environmentId: string | null;
}

// `--flag=value` keeps a value starting with `-` from parsing as a flag.
function createArgs(draft: IssueDraft): string[] {
  const deps = [
    ...draft.blockedBy.map((id) => `blocked-by:${id}`),
    ...draft.blocks.map((id) => `blocks:${id}`),
  ];
  return [
    "create",
    `--title=${draft.title}`,
    `--type=${draft.type}`,
    `--priority=${draft.priority}`,
    `--status=${draft.status}`,
    // The form already shows the parent's labels; save exactly what it shows.
    "--no-inherit-labels",
    ...(draft.description !== "" ? [`--description=${draft.description}`] : []),
    ...(draft.parent !== null ? [`--parent=${draft.parent}`] : []),
    ...(draft.labels.length > 0 ? [`--labels=${draft.labels.join(",")}`] : []),
    ...(deps.length > 0 ? [`--deps=${deps.join(",")}`] : []),
    ...(draft.acceptance !== "" ? [`--acceptance=${draft.acceptance}`] : []),
    ...(draft.design !== "" ? [`--design=${draft.design}`] : []),
    ...(draft.notes !== "" ? [`--notes=${draft.notes}`] : []),
    "--silent",
  ];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// One `bd` run per step, in order: field updates, then each dependency edge.
// Overwriting notes needs --force, which must not also force a status change,
// so it runs on its own. Only the first update carries the revision guard:
// every update bumps the revision.
function updatePlan(
  id: string,
  revision: string | null,
  before: IssueDraft,
  after: IssueDraft,
): string[][] {
  const fields: string[] = [];
  for (const key of ["title", "description", "acceptance", "design"] as const) {
    if (before[key] !== after[key]) fields.push(`--${key}=${after[key]}`);
  }
  if (before.type !== after.type) fields.push(`--type=${after.type}`);
  if (before.status !== after.status) fields.push(`--status=${after.status}`);
  if (before.priority !== after.priority) fields.push(`--priority=${after.priority}`);
  if (before.parent !== after.parent) fields.push(`--parent=${after.parent ?? ""}`);
  if (!sameList([...before.labels].sort(), [...after.labels].sort())) {
    fields.push(`--set-labels=${after.labels.join(",")}`);
  }
  const updates = [fields];
  if (before.notes !== after.notes) {
    if (after.notes === "") fields.push("--clear-notes");
    else if (before.notes === "") fields.push(`--notes=${after.notes}`);
    else updates.push([`--notes=${after.notes}`, "--force"]);
  }
  const plan = updates
    .filter((flags) => flags.length > 0)
    .map((flags, i) => [
      "update",
      id,
      ...(i === 0 && revision !== null ? [`--if-revision=${revision}`] : []),
      ...flags,
    ]);
  const diff = (from: readonly string[], to: readonly string[]) => ({
    added: to.filter((x) => !from.includes(x)),
    removed: from.filter((x) => !to.includes(x)),
  });
  const waits = diff(before.blockedBy, after.blockedBy);
  for (const dep of waits.removed) plan.push(["dep", "remove", id, dep]);
  for (const dep of waits.added) plan.push(["dep", "add", id, dep]);
  const holds = diff(before.blocks, after.blocks);
  for (const dep of holds.removed) plan.push(["dep", "remove", dep, id]);
  for (const dep of holds.added) plan.push(["dep", "add", dep, id]);
  return plan;
}

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n... [output truncated at ${max} characters]`
    : text;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    bdPath: {
      type: "string",
      label: "Path to the `bd` beads CLI",
      default: "bd",
    },
    layout: {
      type: "select",
      label: "Issues panel layout",
      description: "How the Beads issues side panel arranges the issue list and the issue detail.",
      options: [...PANEL_LAYOUTS],
      experimental_optionLabels: {
        split: "Tree + detail (split)",
        grouped: "Grouped by state + detail (split)",
        drill: "Tree, detail opens full height",
      },
      default: "split",
    },
  });
  const { bdPath } = await settings.get();

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  // Environment path + host per thread, captured at turn start by
  // bb.agents.configure so tool executions (which only carry threadId) can
  // run bd in the right checkout on the right machine.
  const threadEnvs = new Map<string, ThreadEnv>();
  bb.onDispose(() => threadEnvs.clear());

  async function resolveEnv(
    threadId: string | null,
    fallbackCwd?: string,
  ): Promise<ThreadEnv | null> {
    if (threadId !== null) {
      const env = threadEnvs.get(threadId);
      if (env !== undefined) return env;
    }
    // CLI without thread context: run in the invoking shell's directory on
    // the first known host (the local machine). Never fall back to a bare
    // cwd — `bd init` would mutate whatever directory the host worker sits in.
    if (fallbackCwd != null && fallbackCwd !== "") {
      try {
        const hosts = await bb.sdk.hosts.list();
        const first = hosts[0];
        if (first != null) return { cwd: fallbackCwd, hostId: first.id, environmentId: null };
      } catch {
        // ignore
      }
    }
    return null;
  }

  // Resolve a thread's environment checkout without requiring a turn to have
  // run on it (the threadEnvs cache only fills at turn start). Used by the
  // side-panel RPC handlers.
  async function resolveThreadEnv(threadId: string): Promise<ThreadEnv | null> {
    const cached = threadEnvs.get(threadId);
    if (cached !== undefined) return cached;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId == null) return null;
      const env = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      if (env.path == null) return null;
      return { cwd: env.path, hostId: env.hostId, environmentId: thread.environmentId };
    } catch {
      return null;
    }
  }

  interface BdRun {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }

  const noCwdError =
    "No working directory to run `bd` in. Run the command from a BB thread " +
    "(uses the thread's environment checkout) or from inside a project " +
    "directory with `bb beads -- <args...>`.";

  const noEnvError = "This thread has no environment checkout to run `bd` in.";

  function bdFailure(command: string, result: BdRun): string {
    const stderr = result.stderr.trim();
    return stderr !== "" ? stderr : `bd ${command} failed (exit ${result.exitCode})`;
  }

  async function runBd(
    args: readonly string[],
    options: {
      threadId: string | null;
      signal?: AbortSignal;
      fallbackCwd?: string;
      env?: ThreadEnv;
    },
  ): Promise<{ result: BdRun | null; error: string | null }> {
    if (args.length === 0) return { result: null, error: "No bd arguments given." };
    const env =
      options.env ?? (await resolveEnv(options.threadId, options.fallbackCwd));
    if (env === null) return { result: null, error: noCwdError };
    let result: BdRun;
    try {
      result = await host.call(
        "bd_run",
        { args: [...args], cwd: env.cwd, bdPath, timeoutMs: BD_TIMEOUT_MS },
        { hostId: env.hostId, signal: options.signal, timeoutMs: BD_TIMEOUT_MS + 30_000 },
      );
    } catch (error) {
      return {
        result: null,
        error: `\`bd\` failed to start: ${error instanceof Error ? error.message : String(error)}
Check the "Path to the \`bd\` beads CLI" setting (currently "${bdPath}") with \`bb plugin config beads\`,
and install beads from https://beads.gascity.com if needed.`,
      };
    }
    // Any successful mutating `bd` run may have changed the issue graph;
    // refresh the side-panel tree in every client once. Reads are excluded
    // so the panel's own refresh does not invalidate itself.
    if (!READ_ONLY_BD_COMMANDS.has(args[0])) {
      bb.rpc.experimental_invalidate(["beads:issues"]);
    }
    return { result, error: null };
  }

  bb.agents.registerTool({
    name: "beads",
    description:
      "Run a `bd` (beads issue tracker, https://beads.gascity.com) command in this thread's environment checkout and return its output. " +
      'Start a session with args=["prime"] for the workflow context, find work with args=["ready"], query with ' +
      'args=["list","--open"] or args=["show","bd-a1b2"], plan with args=["create", ...], and record progress with ' +
      'args=["update","bd-a1b2","--status","in_progress"] / args=["close","bd-a1b2"]. Many commands accept --json for structured output.',
    instructions:
      "Use the `beads` tool to manage the beads issue graph (https://beads.gascity.com) via the `bd` CLI. " +
      "Run `prime` first in a repo for the workflow protocol; pick work with `ready`; create work as children of an epic; " +
      "mark work in_progress with `update <id> --status in_progress` and close it with `close <id>` when done, adding a comment. " +
      "Pass --json when parsing results.",
    parameters: z.object({
      args: z
        .array(z.string().min(1))
        .min(1)
        .max(32)
        .describe('bd CLI arguments, e.g. ["list"]'),
    }),
    async execute({ args }, ctx) {
      const { result, error } = await runBd(args, {
        threadId: ctx.threadId ?? null,
        signal: ctx.signal,
      });
      if (error !== null) {
        return { content: [{ type: "text", text: error }], isError: true };
      }
      const text = [result!.stdout.trim(), result!.stderr.trim()]
        .filter((part) => part !== "")
        .join("\n");
      const suffix = result!.timedOut ? "\n[bd timed out]" : "";
      return {
        content: [{ type: "text", text: `${truncate(text, TOOL_OUTPUT_MAX)}${suffix}` }],
        isError: result!.exitCode !== 0,
      };
    },
  });

  bb.agents.configure((context) => {
    const { path, id } = context.environment;
    if (path != null) {
      threadEnvs.set(context.thread.id, { cwd: path, hostId: context.host.id, environmentId: id });
    } else {
      threadEnvs.delete(context.thread.id);
    }
    return { tools: ["beads"], skills: [] };
  });

  // `bd` subcommands that only read the issue graph. Mutating commands
  // invalidate the side-panel tree; reads must not, or the panel's own
  // refresh would invalidate itself in a loop.
  const READ_ONLY_BD_COMMANDS = new Set([
    "list",
    "show",
    "ready",
    "query",
    "search",
    "count",
    "status",
    "statuses",
    "types",
    "children",
    "graph",
    "history",
    "versions",
    "lint",
    "stale",
    "diff",
    "prime",
    "where",
    "check",
    "help",
    "version",
    "whoami",
  ]);

  // Parse one `bd list --json` row into the slim node the frontend tree
  // consumes. Beads output is freeform at this boundary; keep only the fields
  // the tree needs and drop rows that are not issues.
  function toIssueNode(row: unknown): BdIssueNode | null {
    if (typeof row !== "object" || row === null) return null;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "" || typeof r.title !== "string") {
      return null;
    }
    const num = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const numOrNull = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const str = (value: unknown): string | null =>
      typeof value === "string" && value !== "" ? value : null;
    const labels = Array.isArray(r.labels)
      ? r.labels.filter((label): label is string => typeof label === "string")
      : [];
    const blockedBy: string[] = [];
    if (Array.isArray(r.dependencies)) {
      for (const dep of r.dependencies) {
        if (typeof dep !== "object" || dep === null) continue;
        const d = dep as Record<string, unknown>;
        if (d.type === "blocks" && typeof d.depends_on_id === "string") {
          blockedBy.push(d.depends_on_id);
        }
      }
    }
    return {
      id: r.id,
      title: r.title,
      status: typeof r.status === "string" ? r.status : "open",
      priority: num(r.priority, 2),
      type: typeof r.issue_type === "string" ? r.issue_type : "task",
      parent: str(r.parent),
      owner: str(r.owner),
      updatedAt: str(r.updated_at),
      labels,
      dueAt: str(r.due_at),
      estimatedMinutes: numOrNull(r.estimated_minutes),
      blockedBy,
      commentCount: num(r.comment_count, 0),
      dependencyCount: num(r.dependency_count, 0),
      dependentCount: num(r.dependent_count, 0),
    };
  }

  // Side-panel RPC: the frontend tree reads the thread's issue graph through
  // the same host worker the agent tool and CLI use.
  bb.rpc.register(rpcContract, {
    issues_tree: async ({ threadId }, ctx) => {
      const env = await resolveThreadEnv(threadId);
      if (env === null) {
        return {
          initialized: false,
          issues: [],
          error: noEnvError,
          checkout: null,
        };
      }
      const checkout =
        env.environmentId === null ? null : { environmentId: env.environmentId, rootPath: env.cwd };
      const { result, error } = await runBd(["list", "--all", "--json"], {
        threadId,
        signal: ctx.experimental_signal,
        env,
      });
      if (error !== null) return { initialized: false, issues: [], error, checkout };
      if (result!.exitCode !== 0) {
        const stderr = result!.stderr.trim();
        if (/no beads database found/i.test(stderr)) {
          return {
            initialized: false,
            issues: [],
            error:
              "Beads is not initialized in this checkout. Run `bd init --skip-agents --non-interactive`, or ask the agent to run the beads tool with args [\"init\", \"--skip-agents\", \"--non-interactive\"].",
            checkout,
          };
        }
        return {
          initialized: false,
          issues: [],
          error:
            stderr !== ""
              ? stderr
              : `bd list failed (exit ${result!.exitCode})`,
          checkout,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result!.stdout);
      } catch {
        return {
          initialized: true,
          issues: [],
          error: "Could not parse the `bd list --json` output.",
          checkout,
        };
      }
      if (!Array.isArray(parsed)) {
        return {
          initialized: true,
          issues: [],
          error: "Unexpected `bd list --json` output (expected a JSON array).",
          checkout,
        };
      }
      const issues = parsed
        .map((row) => toIssueNode(row))
        .filter((node): node is BdIssueNode => node !== null);
      return { initialized: true, issues, error: null, checkout };
    },
    issue_show: async ({ threadId, id }, ctx) => {
      const env = await resolveThreadEnv(threadId);
      if (env === null) {
        return {
          json: null,
          error: noEnvError,
        };
      }
      const { result, error } = await runBd(["show", id, "--json"], {
        threadId,
        signal: ctx.experimental_signal,
        env,
      });
      if (error !== null) return { json: null, error };
      if (result!.exitCode !== 0) {
        const stderr = result!.stderr.trim();
        return {
          json: null,
          error:
            stderr !== "" ? stderr : `bd show failed (exit ${result!.exitCode})`,
        };
      }
      return { json: result!.stdout, error: null };
    },
    issue_create: async ({ threadId, draft }, ctx) => {
      const env = await resolveThreadEnv(threadId);
      if (env === null) return { id: null, error: noEnvError };
      const { result, error } = await runBd(createArgs(draft), {
        threadId,
        signal: ctx.experimental_signal,
        env,
      });
      if (error !== null) return { id: null, error };
      if (result!.exitCode !== 0) return { id: null, error: bdFailure("create", result!) };
      return { id: result!.stdout.trim() || null, error: null };
    },
    issue_update: async ({ threadId, id, revision, before, after }, ctx) => {
      const env = await resolveThreadEnv(threadId);
      if (env === null) return { error: noEnvError, partial: false };
      const plan = updatePlan(id, revision, before, after);
      for (const [step, args] of plan.entries()) {
        const { result, error } = await runBd(args, {
          threadId,
          signal: ctx.experimental_signal,
          env,
        });
        const failure =
          error ??
          (result!.exitCode === 13
            ? "This issue changed since you opened it. Reopen the editor to load the latest version."
            : result!.exitCode !== 0
              ? bdFailure(args.slice(0, 2).join(" "), result!)
              : null);
        if (failure !== null) {
          return step === 0
            ? { error: failure, partial: false }
            : {
                error: `Some changes were saved, then this failed:\n${failure}\nReopen the editor to see what was saved.`,
                partial: true,
              };
        }
      }
      return { error: null, partial: false };
    },
  });

  const usage = [
    "Usage:",
    "  bb beads -- <bd-args...>     Run any bd command, e.g. bb beads -- list",
    "  bb beads check               Verify the bd CLI is reachable and print its version",
    "",
    "Full command reference: https://beads.gascity.com/cli-reference/index.md",
  ].join("\n");

  bb.cli.register({
    name: "beads",
    summary: "Run beads (`bd`) issue-tracker commands through the plugin's host worker",
    commands: [
      {
        name: "check",
        summary: "Verify the bd CLI is reachable",
        usage: "bb beads check",
      },
      {
        name: "--",
        summary: "Pass arguments to bd",
        usage: "bb beads -- <bd-args...>",
      },
    ],
    async run(argv, ctx) {
      // Passthrough: every argument after `--` goes to bd verbatim (including
      // bd's own --json flag).
      const positional = [...argv];
      if (positional[0] === "check") {
        const env = await resolveEnv(ctx.threadId ?? null, ctx.cwd);
        if (env === null) return { exitCode: 1, stderr: noCwdError };
        try {
          const result = await host.call(
            "bd_check",
            { bdPath },
            { hostId: env.hostId, timeoutMs: 30_000 },
          );
          const text = result.ok
            ? `bd ${result.version}`
            : `bd not usable (${result.error ?? "unknown error"})`;
          return {
            exitCode: result.ok ? 0 : 1,
            stdout: text,
          };
        } catch (error) {
          return {
            exitCode: 1,
            stderr: `bd check failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      if (positional[0] === "--") positional.shift();
      if (positional.length === 0) return { exitCode: 0, stdout: usage };
      const { result, error } = await runBd(positional, {
        threadId: ctx.threadId ?? null,
        fallbackCwd: ctx.cwd,
      });
      if (error !== null) return { exitCode: 1, stderr: error };
      const out = `${result!.stdout}${result!.stderr}`;
      return {
        exitCode: result!.exitCode,
        stdout:
          out.length > PLUGIN_CLI_OUTPUT_MAX_BYTES
            ? `${out.slice(0, PLUGIN_CLI_OUTPUT_MAX_BYTES)}\n... [truncated]`
            : out,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
