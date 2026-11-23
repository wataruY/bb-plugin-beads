// bb.host entry for bb-plugin-beads: full-trust Node worker that spawns the
// `bd` (beads) CLI on this machine. The server entry reaches it through the
// shared contract in contract.ts.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { spawn } from "node:child_process";
import { hostContract, hostSignals } from "./contract.js";

const MAX_CAPTURE = 2 * 1024 * 1024;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  if (signal.aborted) {
    reject(new Error("aborted before start"));
    return promise;
  }
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      signal,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const append = (
      chunk: string,
      state: { text: string; truncated: boolean },
    ): void => {
      if (state.text.length >= MAX_CAPTURE) {
        state.truncated = true;
        return;
      }
      const room = MAX_CAPTURE - state.text.length;
      if (chunk.length > room) {
        state.text += chunk.slice(0, room);
        state.truncated = true;
      } else {
        state.text += chunk;
      }
    };
    const stdoutState = { text: stdout, truncated: false };
    const stderrState = { text: stderr, truncated: false };
    child.stdout.on("data", (chunk: string) => append(chunk, stdoutState));
    child.stderr.on("data", (chunk: string) => append(chunk, stderrState));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      stdoutTruncated = stdoutState.truncated;
      stderrTruncated = stderrState.truncated;
      const finish = (text: string, truncated: boolean) =>
        truncated ? `${text}\n... [truncated]` : text;
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: finish(stdoutState.text, stdoutTruncated),
        stderr: timedOut
          ? `${finish(stderrState.text, stderrTruncated)}\n... [timed out after ${timeoutMs}ms]`
          : finish(stderrState.text, stderrTruncated),
        timedOut,
      });
    });
  return promise;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    bd_check: async ({ bdPath }, context) => {
      try {
        const result = await runCommand(
          bdPath,
          ["--version"],
          ".",
          10_000,
          context.signal,
        );
        const version = result.stdout.trim() || result.stderr.trim();
        return { ok: result.exitCode === 0, version, error: result.exitCode === 0 ? null : version };
      } catch (error) {
        return {
          ok: false,
          version: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    bd_run: async ({ args, cwd, bdPath, timeoutMs }, context) => {
      const result = await runCommand(bdPath, args, cwd, timeoutMs, context.signal);
      return result;
    },
  },
});
