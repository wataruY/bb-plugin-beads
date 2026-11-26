// bb.host entry for bb-plugin-beads: full-trust Node worker that spawns the
// `bd` (beads) CLI on this machine. The server entry reaches it through the
// shared contract in contract.ts.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { spawn } from "node:child_process";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

const SKIP_DIRS = new Set([".git", "node_modules", ".beads", ".dolt", ".next", "dist", "target"]);
const FILE_LIST_MAX = 20_000;
const FILE_LIST_TTL_MS = 3_000;
const fileLists = new Map<string, { at: number; files: string[] }>();

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= FILE_LIST_MAX) return;
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= FILE_LIST_MAX) return;
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

// Tracked + untracked-but-not-ignored files via git; a plain walk otherwise.
async function listFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
  const cached = fileLists.get(cwd);
  if (cached !== undefined && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
  let files: string[] = [];
  try {
    const result = await runCommand(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd,
      10_000,
      signal,
    );
    if (result.exitCode === 0) files = result.stdout.split("\0").filter((f) => f !== "");
    else await walk(cwd, "", files);
  } catch {
    await walk(cwd, "", files);
  }
  fileLists.set(cwd, { at: Date.now(), files });
  return files;
}

function rank(file: string, query: string): number {
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (query === "") return 3;
  if (base.startsWith(query)) return 0;
  if (base.includes(query)) return 1;
  return lower.includes(query) ? 2 : -1;
}

// `dir` is trusted config but `name` is user-derived: keep the write inside it.
async function saveUnique(cwd: string, dir: string, name: string, data: Buffer): Promise<string> {
  const root = path.resolve(cwd);
  const target = path.resolve(root, dir);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("directory escapes the checkout");
  await mkdir(target, { recursive: true });
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_") || "image";
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "image";
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    try {
      const handle = await open(path.join(target, candidate), "wx");
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return path.posix.join(dir.split(path.sep).join("/"), candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not find a free file name");
}

// The checkout's beads database directory. `bd where` follows a worktree's
// redirect to the main checkout and honours BEADS_DIR; ask it once per checkout.
const databaseDirs = new Map<string, string>();
async function databaseDir(cwd: string, bdPath: string, signal: AbortSignal): Promise<string> {
  const cached = databaseDirs.get(cwd);
  if (cached !== undefined) return cached;
  const result = await runCommand(bdPath, ["where", "--json"], cwd, 30_000, signal);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `bd where failed (exit ${result.exitCode})`);
  }
  const where = JSON.parse(result.stdout) as { database_path?: unknown; path?: unknown };
  const dir = [where.database_path, where.path].find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  if (dir === undefined) throw new Error("bd where reported no database path");
  databaseDirs.set(cwd, dir);
  return dir;
}

// Dolt rewrites a database's `manifest` on every access, reads included, but
// its content (the root hash) changes only when a write commits. Comparing
// content keeps the panel's own `bd list` from re-triggering itself.
async function readManifests(dir: string): Promise<string> {
  const names = (await readdir(dir, { recursive: true })).filter(
    (name) => path.basename(name) === "manifest",
  );
  const contents = await Promise.all(
    names.sort().map((name) => readFile(path.join(dir, name), "utf8").catch(() => "")),
  );
  return names.map((name, i) => `${name}\0${contents[i]}`).join("\0");
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
    fs_search: async ({ cwd, query, limit }, context) => {
      const q = query.toLowerCase();
      const files = await listFiles(cwd, context.signal);
      const ranked: { file: string; score: number }[] = [];
      for (const file of files) {
        const score = rank(file, q);
        if (score >= 0) ranked.push({ file, score });
      }
      ranked.sort((a, b) => a.score - b.score || a.file.length - b.file.length || (a.file < b.file ? -1 : 1));
      return { paths: ranked.slice(0, limit).map((r) => r.file) };
    },
    fs_save: async ({ cwd, dir, name, dataBase64 }) => {
      const written = await saveUnique(cwd, dir, name, Buffer.from(dataBase64, "base64"));
      fileLists.delete(cwd);
      return { path: written };
    },
    beads_watch: async ({ cwd, bdPath, renewMs }, context) => {
      let dir: string;
      let seen: string;
      try {
        dir = await databaseDir(cwd, bdPath, context.signal);
        seen = await readManifests(dir);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      const stop = new AbortController();
      let failure: string | null = null;
      let checks = Promise.resolve();
      const check = async (): Promise<void> => {
        const next = await readManifests(dir);
        if (next === seen) return;
        seen = next;
        await context.experimental_emitSignal("beads_changed", { dir });
      };
      const subscription = await context.experimental_watch({ rootPath: dir }, (event) => {
        if (event.kind === "watch-error") {
          failure = event.message;
          stop.abort();
          return;
        }
        if (
          event.kind === "changed" &&
          !event.changes.some((change) => path.basename(change.path) === "manifest")
        ) {
          return;
        }
        checks = checks.then(check).catch(() => {});
      });
      try {
        await sleep(renewMs, undefined, { signal: AbortSignal.any([context.signal, stop.signal]) });
      } catch {
        // Aborted: the panel stopped watching, or the watch failed.
      } finally {
        await subscription.dispose();
      }
      return { error: failure };
    },
    bd_run: async ({ args, cwd, bdPath, timeoutMs }, context) => {
      const result = await runCommand(bdPath, args, cwd, timeoutMs, context.signal);
      return result;
    },
  },
});
