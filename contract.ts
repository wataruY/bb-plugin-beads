import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The server entry and the bb.host entry share this contract.
// Pasted images travel as base64 through two RPC hops; cap them at ~8 MB.
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BASE64 = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4;
// Where pasted images land, relative to the checkout root.
export const ATTACHMENT_DIR = "assets";

export const hostContract = defineRpcContract({
  // Project-relative paths matching `query`, for `@` completion. Respects
  // .gitignore when the checkout is a git repository.
  fs_search: {
    input: z
      .object({ cwd: z.string().min(1), query: z.string().max(200), limit: z.number().int().min(1).max(50) })
      .strict(),
    output: z.object({ paths: z.array(z.string()) }).strict(),
  },
  // Writes one new file under `dir` (relative to `cwd`); never overwrites.
  fs_save: {
    input: z
      .object({
        cwd: z.string().min(1),
        dir: z.string().min(1),
        name: z.string().min(1).max(120),
        dataBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64),
      })
      .strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  bd_check: {
    input: z.object({ bdPath: z.string().min(1) }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        version: z.string(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  bd_run: {
    input: z
      .object({
        args: z.array(z.string()).min(1).max(32),
        cwd: z.string().min(1),
        bdPath: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(1_800_000),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
      })
      .strict(),
  },
});

export const hostSignals = {} satisfies ExperimentalHostSignals;

// Frontend <-> backend RPC contract (app.tsx -> server.ts), separate from the
// host contract above. The frontend reads the issue tree of a thread's
// environment checkout; the backend runs `bd` through the host worker.
const bdIssueNode = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    status: z.string(),
    priority: z.number().int(),
    type: z.string(),
    parent: z.string().nullable(),
    owner: z.string().nullable(),
    updatedAt: z.string().nullable(),
    labels: z.array(z.string()),
    dueAt: z.string().nullable(),
    estimatedMinutes: z.number().int().nullable(),
    // Ids of the issues this one waits on (`blocks` dependencies only).
    blockedBy: z.array(z.string()),
    commentCount: z.number().int(),
    dependencyCount: z.number().int(),
    dependentCount: z.number().int(),
  })
  .strict();

export type BdIssueNode = z.infer<typeof bdIssueNode>;

// The thread's checkout, so the panel can resolve project-relative Markdown
// links and images.
const issuesCheckout = z
  .object({ environmentId: z.string().min(1), rootPath: z.string().min(1) })
  .strict();

export type IssuesCheckout = z.infer<typeof issuesCheckout>;

// Side-panel view settings, kept in the plugin settings so the settings page
// and the panel agree. The list arranges issues as a parent/child tree or in
// workflow-state groups; on a fine pointer the detail opens below the list
// (split) or replaces it (drill).
export const LIST_VIEWS = ["tree", "status"] as const;
export type ListView = (typeof LIST_VIEWS)[number];
export const DETAIL_MODES = ["split", "drill"] as const;
export type DetailMode = (typeof DETAIL_MODES)[number];

// The editable fields of an issue, shared by the create and edit forms. The
// server turns a draft (or a draft diff) into `bd` argv; the frontend never
// sends raw arguments.
const issueDraft = z
  .object({
    title: z.string().trim().min(1),
    description: z.string(),
    type: z.string().min(1),
    status: z.string().min(1),
    priority: z.number().int().min(0).max(4),
    parent: z.string().min(1).nullable(),
    labels: z.array(z.string().min(1)),
    // Issues this one waits on, and issues waiting on this one.
    blockedBy: z.array(z.string().min(1)),
    blocks: z.array(z.string().min(1)),
    acceptance: z.string(),
    design: z.string(),
    notes: z.string(),
  })
  .strict();

export type IssueDraft = z.infer<typeof issueDraft>;

export const rpcContract = defineRpcContract({
  settings_set: {
    input: z
      .object({ listView: z.enum(LIST_VIEWS).optional(), detailMode: z.enum(DETAIL_MODES).optional() })
      .strict(),
    output: z.object({ error: z.string().nullable() }).strict(),
  },
  files_search: {
    input: z
      .object({ threadId: z.string().min(1), query: z.string().max(200) })
      .strict(),
    output: z.object({ paths: z.array(z.string()) }).strict(),
  },
  attachment_save: {
    input: z
      .object({
        threadId: z.string().min(1),
        name: z.string().min(1).max(120),
        dataBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64),
      })
      .strict(),
    output: z.object({ path: z.string().nullable(), error: z.string().nullable() }).strict(),
  },
  issues_tree: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        initialized: z.boolean(),
        issues: z.array(bdIssueNode),
        error: z.string().nullable(),
        // Null when the thread has no environment.
        checkout: issuesCheckout.nullable(),
        // `bd config get issue_prefix`; null when unset or unreadable.
        issuePrefix: z.string().nullable(),
      })
      .strict(),
    tags: () => ["beads:issues"],
  },
  issue_show: {
    input: z.object({ threadId: z.string().min(1), id: z.string().min(1) }).strict(),
    output: z
      .object({
        // Raw `bd show <id> --json` output (a one-element JSON array) so the
        // panel is resilient to bd's evolving field set.
        json: z.string().nullable(),
        error: z.string().nullable(),
      })
      .strict(),
    tags: () => ["beads:issues"],
  },
  issue_create: {
    input: z.object({ threadId: z.string().min(1), draft: issueDraft }).strict(),
    output: z.object({ id: z.string().nullable(), error: z.string().nullable() }).strict(),
  },
  issue_update: {
    input: z
      .object({
        threadId: z.string().min(1),
        id: z.string().min(1),
        // `bd show --json`'s int64 revision, kept as a string; the update is
        // refused when the issue changed since the form opened.
        revision: z.string().nullable(),
        before: issueDraft,
        after: issueDraft,
      })
      .strict(),
    output: z
      .object({
        error: z.string().nullable(),
        // Earlier steps were written: the form's starting point is stale.
        partial: z.boolean(),
      })
      .strict(),
  },
});

