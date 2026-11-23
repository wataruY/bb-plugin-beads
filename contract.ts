import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The server entry and the bb.host entry share this contract.
export const hostContract = defineRpcContract({
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

// Side-panel layouts, selectable in the plugin settings.
export const PANEL_LAYOUTS = ["split", "grouped", "drill"] as const;
export type PanelLayout = (typeof PANEL_LAYOUTS)[number];

export const rpcContract = defineRpcContract({
  issues_tree: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        initialized: z.boolean(),
        issues: z.array(bdIssueNode),
        error: z.string().nullable(),
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
});

