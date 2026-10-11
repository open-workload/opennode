/**
 * Supervisor that resumes opencode sessions with incomplete todos.
 *
 *   inputs                          path                              outputs
 *   ───────                          ────                              ───────
 *   opencode.db ──(sqlite, RO)──▶ eligible query ──▶ singleton lock ──▶ resumed sessions
 *   state dir ──────────────────▶ heartbeat ──────▶ per-dir lock ────▶ sessions/<id>.log
 *   CLI flags ──────────────────▶ opencode run ───▶ attempts/cooldown ─▶ attempts.json
 *                                                                       └──▶ JSONL log + exit code
 *
 *   watch loops every --interval until no todos remain (0) or every
 *   eligible session has exhausted its attempts (2); a second supervisor
 *   is refused with exit 3 until the singleton lock is free.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import {
  LogCorrelator,
  type StructuredLogEntry,
} from "@workspace/observability";
import type { LogLevel } from "@workspace/observability";

export const DEFAULT_PROMPT =
  "Resume this session and finish its remaining todos. For each todo that is not completed or cancelled: implement it, verify it (run the project's tests and typecheck), and mark it completed only when it genuinely passes. Do not start unrelated work. When every todo is completed or cancelled, stop and report what you did.";

export const RESUME_STALE_MS = 24 * 60 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const heartbeatName = "heartbeat";
const attemptsName = "attempts.json";
const logName = "resume-supervisor.jsonl";
const sessionsDirName = "sessions";
const dirsDirName = "dirs";
const singletonLockName = "supervisor.lock";

export type Command = "status" | "once" | "watch";

export interface ResolvedOptions {
  command: Command;
  db: string;
  stateDir: string;
  interval: number;
  maxParallel: number;
  maxAttempts: number;
  attemptTimeout: number;
  cooldown: number;
  prompt: string;
  auto: boolean;
  dirs: string[];
  dryRun: boolean;
  log: string;
  logLevel: LogLevel;
}

export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly directory: string;
}

export interface AttemptState {
  attempts: number;
  lastAttemptAt: number;
}

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;
}

export function singletonLockTarget(stateDir: string): string {
  return join(stateDir, singletonLockName);
}

const ELIGIBLE_SQL_HEAD = `
  SELECT s.id, s.title, s.directory
  FROM session s
  JOIN todo t ON t.session_id = s.id
  WHERE t.status NOT IN ('completed', 'cancelled')
    AND s.time_archived IS NULL
    AND s.parent_id IS NULL
`;

const ELIGIBLE_SQL_TAIL = `
  GROUP BY s.id
  ORDER BY s.time_updated ASC
`;

export function queryEligibleSessions(dbPath: string, dirs: readonly string[]): SessionRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const dirFilter =
      dirs.length > 0
        ? `AND s.directory IN (${dirs.map(() => "?").join(", ")})`
        : "";
    const rows = db.prepare(ELIGIBLE_SQL_HEAD + dirFilter + ELIGIBLE_SQL_TAIL).all(...dirs) as unknown[];
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        title: String(r.title),
        directory: String(r.directory),
      };
    });
  } finally {
    db.close();
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stateDirs(stateDir: string): {
  attempts: string;
  heartbeat: string;
  log: string;
  sessionsDir: string;
  dirsDir: string;
  singletonLock: string;
} {
  return {
    attempts: join(stateDir, attemptsName),
    heartbeat: join(stateDir, heartbeatName),
    log: join(stateDir, logName),
    sessionsDir: join(stateDir, sessionsDirName),
    dirsDir: join(stateDir, dirsDirName),
    singletonLock: singletonLockTarget(stateDir),
  };
}

async function ensureStateDirs(stateDir: string): Promise<void> {
  const dirs = stateDirs(stateDir);
  await mkdir(stateDir, { recursive: true });
  await mkdir(dirs.sessionsDir, { recursive: true });
  await mkdir(dirs.dirsDir, { recursive: true });
}

async function readAttempts(stateDir: string): Promise<Record<string, AttemptState>> {
  const path = stateDirs(stateDir).attempts;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, AttemptState>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeAttempts(stateDir: string, attempts: Record<string, AttemptState>): Promise<void> {
  const path = stateDirs(stateDir).attempts;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(attempts, null, 2));
  await rename(tmp, path);
}

async function writeHeartbeat(stateDir: string, now: number): Promise<void> {
  await writeFile(stateDirs(stateDir).heartbeat, new Date(now).toISOString());
}

async function readHeartbeat(stateDir: string): Promise<number | null> {
  try {
    const value = await readFile(stateDirs(stateDir).heartbeat, "utf8");
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const LEVEL_ORDER: readonly LogLevel[] = [
  "debug" as LogLevel,
  "info" as LogLevel,
  "warn" as LogLevel,
  "error" as LogLevel,
];

// We reuse LogCorrelator for correlation + handler fan-out, but the console
// formatter is local: `createConsoleLogHandler` lives in
// lib/observability/src/logCorrelation.ts and is not re-exported by the
// package barrel (`@workspace/observability`), which is out of this slice's
// file scope, so the deep import is not reachable.
function formatConsoleLine(entry: StructuredLogEntry, minIndex: number): string | null {
  if (LEVEL_ORDER.indexOf(entry.level) < minIndex) return null;
  const correlation = Object.entries(entry.correlationIds)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const meta = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";
  const err = entry.error ? ` error=${entry.error.name}:${entry.error.message}` : "";
  const dur = entry.durationMs !== undefined ? ` durationMs=${entry.durationMs}` : "";
  const op = entry.operation ? ` op=${entry.operation}` : "";
  const line = `[${new Date(entry.timestamp).toISOString()}] ${entry.level.toUpperCase()} ${entry.subsystem}${op}${dur} ${entry.message}${correlation ? ` [${correlation}]` : ""}${err}${meta}`;
  return line;
}

function setupLogger(opts: ResolvedOptions, deps: CliDeps): LogCorrelator {
  const correlator = new LogCorrelator();
  const minIndex = LEVEL_ORDER.indexOf(opts.logLevel);
  correlator.addHandler((entry) => {
    const line = formatConsoleLine(entry, minIndex);
    if (line !== null) deps.writeOut(line);
  });
  correlator.addHandler((entry) => {
    appendFile(opts.log, JSON.stringify(entry) + "\n").catch(() => {});
  });
  return correlator;
}

function resolveStateDir(stateOpt: string | undefined, env: NodeJS.ProcessEnv): string {
  if (stateOpt) return stateOpt;
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "opencode", "resume-supervisor");
}

function resolveDbPath(env: NodeJS.ProcessEnv, dbOpt: string | undefined): string {
  if (dbOpt) return dbOpt;
  if (env.OPENCODE_DB) return env.OPENCODE_DB;
  const result = spawnSync("opencode", ["db", "path"], { encoding: "utf8" });
  const path = result.status === 0 ? result.stdout.trim() : "";
  if (path) return path;
  throw new Error(
    "cannot resolve the opencode database: pass --db, set OPENCODE_DB, or make `opencode db path` work",
  );
}

const USAGE = `opencode-session-resume <command> [options]

Commands:
  status    Report supervisor liveness (heartbeat age, lock held) and the queue of
            sessions with incomplete todos. Exit 0.
  once      Run a single supervision pass: resume eligible sessions, then report.
            Exit 0 if no incomplete todos remain, 2 if some remain after attempts
            are exhausted, 3 if another supervisor holds the lock.
  watch     Loop passes every --interval seconds until no incomplete todos remain
            (exit 0) or every eligible session has exhausted its attempts (exit 2).

Options:
  --db <path>            opencode sqlite db. Default: $OPENCODE_DB env, else the
                         output of \`opencode db path\`, else error.
  --state <dir>          supervisor state dir. Default:
                         \${XDG_STATE_HOME:-\$HOME/.local/state}/opencode/resume-supervisor
  --interval <secs>      watch loop interval (default 60)
  --max-parallel <n>     max concurrent resumes (default 1)
  --max-attempts <n>     per-session resume attempts before giving up (default 5)
  --attempt-timeout <s>  kill a resume that exceeds this (default 1800)
  --cooldown <s>         min seconds between attempts for the same session (default 300)
  --prompt <text>        resume prompt (default built in)
  --auto                 pass --auto to \`opencode run\` (auto-approve permissions; dangerous)
  --dir <path>           only resume sessions whose directory matches (repeatable)
  --dry-run              print the plan without spawning opencode or taking locks; exit 0
  --log <file>           JSONL log path (default \$STATE/resume-supervisor.jsonl)
  --log-level <level>    debug|info|warn|error (default info)
  -h, --help             usage
`;

const VALUE_OPTIONS = new Map<string, keyof ResolvedOptions>([
  ["--db", "db"],
  ["--state", "stateDir"],
  ["--interval", "interval"],
  ["--max-parallel", "maxParallel"],
  ["--max-attempts", "maxAttempts"],
  ["--attempt-timeout", "attemptTimeout"],
  ["--cooldown", "cooldown"],
  ["--prompt", "prompt"],
  ["--log", "log"],
  ["--log-level", "logLevel"],
]);

type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; raw: RawOptions };

interface RawOptions {
  command: Command;
  db?: string;
  stateDir?: string;
  interval: number;
  maxParallel: number;
  maxAttempts: number;
  attemptTimeout: number;
  cooldown: number;
  prompt: string;
  auto: boolean;
  dirs: string[];
  dryRun: boolean;
  log?: string;
  logLevel: LogLevel;
}

function parseArgs(argv: readonly string[]): ParseResult {
  if (argv.length === 0) {
    return { kind: "error", message: "missing command (status|once|watch)" };
  }
  // pnpm forwards `-- <args>` verbatim, so a leading `--` separator is a
  // normal way to reach us; treat it as transparent.
  if (argv[0] === "--") argv = argv.slice(1);
  if (argv.length === 0) {
    return { kind: "error", message: "missing command (status|once|watch)" };
  }
  const command = argv[0];
  if (command === "-h" || command === "--help") return { kind: "help" };
  if (command !== "status" && command !== "once" && command !== "watch") {
    return { kind: "error", message: `unknown command: ${command}` };
  }

  const raw: RawOptions = {
    command,
    interval: 60,
    maxParallel: 1,
    maxAttempts: 5,
    attemptTimeout: 1800,
    cooldown: 300,
    prompt: DEFAULT_PROMPT,
    auto: false,
    dirs: [],
    dryRun: false,
    logLevel: "info" as LogLevel,
  };

  const num = (flag: string, value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`--${flag} expects a number, got: ${value}`);
    }
    return parsed;
  };

  try {
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "-h" || arg === "--help") return { kind: "help" };
      if (arg === "--") continue; // separator; transparent
      if (arg === "--auto") {
        raw.auto = true;
        continue;
      }
      if (arg === "--dry-run") {
        raw.dryRun = true;
        continue;
      }
      if (arg === "--dir") {
        const value = argv[i + 1];
        if (value === undefined) throw new Error("--dir expects a path");
        raw.dirs.push(value);
        i += 1;
        continue;
      }
      if (VALUE_OPTIONS.has(arg)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`${arg} expects a value`);
        const field = VALUE_OPTIONS.get(arg)!;
        switch (field) {
          case "interval":
            raw.interval = num("interval", value);
            break;
          case "maxParallel":
            raw.maxParallel = num("max-parallel", value);
            break;
          case "maxAttempts":
            raw.maxAttempts = num("max-attempts", value);
            break;
          case "attemptTimeout":
            raw.attemptTimeout = num("attempt-timeout", value);
            break;
          case "cooldown":
            raw.cooldown = num("cooldown", value);
            break;
          case "db":
            raw.db = value;
            break;
          case "stateDir":
            raw.stateDir = value;
            break;
          case "prompt":
            raw.prompt = value;
            break;
          case "log":
            raw.log = value;
            break;
          case "logLevel":
            raw.logLevel = value as LogLevel;
            break;
        }
        i += 1;
        continue;
      }
      throw new Error(`unknown option: ${arg}`);
    }
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  if (raw.maxParallel < 1) return { kind: "error", message: "--max-parallel must be >= 1" };
  if (raw.maxAttempts < 1) return { kind: "error", message: "--max-attempts must be >= 1" };
  if (raw.interval < 0) return { kind: "error", message: "--interval must be >= 0" };
  if (raw.cooldown < 0) return { kind: "error", message: "--cooldown must be >= 0" };
  if (raw.attemptTimeout < 0) return { kind: "error", message: "--attempt-timeout must be >= 0" };
  if (!LEVEL_ORDER.includes(raw.logLevel as LogLevel)) {
    return { kind: "error", message: "--log-level must be debug|info|warn|error" };
  }

  return { kind: "ok", raw };
}

function resolveOptions(raw: RawOptions, env: NodeJS.ProcessEnv): ResolvedOptions {
  const stateDir = resolveStateDir(raw.stateDir, env);
  return {
    command: raw.command,
    db: resolveDbPath(env, raw.db),
    stateDir,
    interval: raw.interval,
    maxParallel: raw.maxParallel,
    maxAttempts: raw.maxAttempts,
    attemptTimeout: raw.attemptTimeout,
    cooldown: raw.cooldown,
    prompt: raw.prompt,
    auto: raw.auto,
    dirs: raw.dirs,
    dryRun: raw.dryRun,
    log: raw.log ?? join(stateDir, logName),
    logLevel: raw.logLevel,
  };
}

async function tryAcquireLock(
  target: string,
  stale: number,
): Promise<(() => Promise<void>) | null> {
  try {
    return await lockfile.lock(target, { realpath: false, retries: 0, stale });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return null;
    throw error;
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code, timedOut });
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code: null, timedOut });
    });
  });
}

interface PassContext {
  deps: CliDeps;
  opts: ResolvedOptions;
  log: LogCorrelator;
  attempts: Record<string, AttemptState>;
  resumed: number;
  skipped: number;
  persistAttempts: () => Promise<void>;
}

async function openSessionLog(sessionId: string, stateDir: string) {
  const dirs = stateDirs(stateDir);
  return open(join(dirs.sessionsDir, `${sessionId}.log`), "a");
}

async function resumeSession(session: SessionRow, ctx: PassContext, dirRelease: () => Promise<void>): Promise<void> {
  ctx.log.info(`resuming ${session.id} in ${session.directory}`, {
    subsystem: "resume-supervisor",
    operation: "resume",
    metadata: { sessionId: session.id, directory: session.directory },
  });

  const args = ["run", "--session", session.id, "--dir", session.directory];
  if (ctx.opts.auto) args.push("--auto");
  args.push(ctx.opts.prompt);

  const child = ctx.deps.spawn("opencode", args, { env: ctx.deps.env });
  ctx.attempts[session.id] = {
    attempts: (ctx.attempts[session.id]?.attempts ?? 0) + 1,
    lastAttemptAt: ctx.deps.now(),
  };
  await ctx.persistAttempts();

  const fd = await openSessionLog(session.id, ctx.opts.stateDir);
  try {
    child.stdout?.on("data", (chunk: Buffer) => {
      fd.write(chunk).catch(() => {});
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      fd.write(chunk).catch(() => {});
    });

    const { code, timedOut } = await waitForExit(child, ctx.opts.attemptTimeout * 1000);
    if (timedOut) {
      ctx.log.error(`resume ${session.id} timed out after ${ctx.opts.attemptTimeout}s`, {
        subsystem: "resume-supervisor",
        operation: "resume",
        metadata: { sessionId: session.id, exitCode: code ?? null, timedOut: true },
      });
    } else if (code === 0) {
      ctx.log.info(`resume ${session.id} exited 0`, {
        subsystem: "resume-supervisor",
        operation: "resume",
        metadata: { sessionId: session.id, exitCode: 0 },
      });
    } else {
      ctx.log.warn(`resume ${session.id} exited ${String(code)}`, {
        subsystem: "resume-supervisor",
        operation: "resume",
        metadata: { sessionId: session.id, exitCode: code ?? null },
      });
    }
  } finally {
    await fd.close();
    await dirRelease();
  }
}

async function processSession(session: SessionRow, ctx: PassContext): Promise<void> {
  const att = ctx.attempts[session.id];
  if (att && att.attempts >= ctx.opts.maxAttempts) {
    ctx.skipped += 1;
    ctx.log.warn(`skipping ${session.id}: attempts exhausted (${att.attempts}/${ctx.opts.maxAttempts})`, {
      subsystem: "resume-supervisor",
      operation: "skip",
      metadata: { sessionId: session.id, reason: "attempts-exhausted" },
    });
    return;
  }
  if (att && att.lastAttemptAt > 0) {
    const elapsed = ctx.deps.now() - att.lastAttemptAt;
    const cooldownMs = ctx.opts.cooldown * 1000;
    if (elapsed < cooldownMs) {
      ctx.skipped += 1;
      ctx.log.info(`skipping ${session.id}: cooldown active (retry in ${Math.ceil((cooldownMs - elapsed) / 1000)}s)`, {
        subsystem: "resume-supervisor",
        operation: "skip",
        metadata: { sessionId: session.id, reason: "cooldown", retryInSeconds: Math.ceil((cooldownMs - elapsed) / 1000) },
      });
      return;
    }
  }

  const dirLock = join(stateDirs(ctx.opts.stateDir).dirsDir, `${sha256Hex(session.directory)}.lock`);
  const dirRelease = await tryAcquireLock(dirLock, RESUME_STALE_MS);
  if (dirRelease === null) {
    ctx.skipped += 1;
    ctx.log.warn(`skipping ${session.id}: directory busy (${session.directory})`, {
      subsystem: "resume-supervisor",
      operation: "skip",
      metadata: { sessionId: session.id, reason: "directory-busy", directory: session.directory },
    });
    return;
  }

  ctx.resumed += 1;
  await resumeSession(session, ctx, dirRelease);
}

async function runPass(sessions: readonly SessionRow[], ctx: PassContext): Promise<void> {
  if (sessions.length === 0) return;
  const byDirectory = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const list = byDirectory.get(session.directory) ?? [];
    list.push(session);
    byDirectory.set(session.directory, list);
  }
  const directories = [...byDirectory.keys()];
  const poolSize = Math.max(1, Math.min(ctx.opts.maxParallel, directories.length));
  const worker = async (): Promise<void> => {
    while (true) {
      const directory = directories.shift();
      if (directory === undefined) return;
      for (const session of byDirectory.get(directory)!) {
        await processSession(session, ctx);
      }
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
}

function serializeAttemptsWrites(
  stateDir: string,
  attempts: Record<string, AttemptState>,
): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return () => {
    const snapshot = { ...attempts };
    chain = chain.then(() => writeAttempts(stateDir, snapshot));
    return chain;
  };
}

function allExhausted(sessions: readonly SessionRow[], attempts: Record<string, AttemptState>, maxAttempts: number): boolean {
  return sessions.every((session) => (attempts[session.id]?.attempts ?? 0) >= maxAttempts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveResult) => setTimeout(resolveResult, ms));
}

function planLine(session: SessionRow, reason: string): string {
  return `  ${reason} ${session.id} (${session.title}) in ${session.directory}`;
}

async function cmdStatus(opts: ResolvedOptions, deps: CliDeps): Promise<number> {
  const log = setupLogger(opts, deps);
  log.info("supervisor status requested", {
    subsystem: "resume-supervisor",
    operation: "status",
    metadata: { db: opts.db, stateDir: opts.stateDir },
  });

  const heartbeat = await readHeartbeat(opts.stateDir);
  if (heartbeat === null) {
    deps.writeOut("Heartbeat: not running\n");
  } else {
    const ageMs = Math.max(0, deps.now() - heartbeat);
    deps.writeOut(`Heartbeat: running (last pass ${Math.round(ageMs / 1000)}s ago)\n`);
  }

  let held = false;
  try {
    held = await lockfile.check(stateDirs(opts.stateDir).singletonLock, {
      realpath: false,
      stale: RESUME_STALE_MS,
    });
  } catch {
    held = false;
  }
  deps.writeOut(`Supervisor lock: ${held ? "held" : "free"}\n`);

  const eligible = queryEligibleSessions(opts.db, opts.dirs);
  deps.writeOut(`Queue: ${eligible.length} session(s) with incomplete todos\n`);
  for (const session of eligible) {
    deps.writeOut(`  - ${session.id}  ${session.title}  ${session.directory}\n`);
  }
  return 0;
}

async function cmdDryRun(opts: ResolvedOptions, deps: CliDeps): Promise<number> {
  const log = setupLogger(opts, deps);
  const eligible = queryEligibleSessions(opts.db, opts.dirs);
  const attempts = await readAttempts(opts.stateDir);
  const now = deps.now();

  deps.writeOut("Plan (dry run):\n");
  for (const session of eligible) {
    const att = attempts[session.id];
    if (att && att.attempts >= opts.maxAttempts) {
      deps.writeOut(planLine(session, `skip (attempts exhausted ${att.attempts}/${opts.maxAttempts})`));
      continue;
    }
    if (att && att.lastAttemptAt > 0 && now - att.lastAttemptAt < opts.cooldown * 1000) {
      deps.writeOut(planLine(session, "skip (cooldown active)"));
      continue;
    }
    deps.writeOut(planLine(session, "resume"));
  }
  log.info(`dry-run computed plan for ${eligible.length} eligible session(s)`, {
    subsystem: "resume-supervisor",
    operation: "plan",
    metadata: { eligible: eligible.length },
  });
  return 0;
}

async function cmdOnce(opts: ResolvedOptions, deps: CliDeps): Promise<number> {
  const log = setupLogger(opts, deps);
  await ensureStateDirs(opts.stateDir);
  const release = await tryAcquireLock(stateDirs(opts.stateDir).singletonLock, RESUME_STALE_MS);
  if (release === null) {
    deps.writeErr("another supervisor is running (singleton lock held); exiting 3\n");
    return 3;
  }
  try {
    await writeHeartbeat(opts.stateDir, deps.now());
    const attempts = await readAttempts(opts.stateDir);
    const ctx: PassContext = {
      deps,
      opts,
      log,
      attempts,
      resumed: 0,
      skipped: 0,
      persistAttempts: serializeAttemptsWrites(opts.stateDir, attempts),
    };
    await runPass(queryEligibleSessions(opts.db, opts.dirs), ctx);
    await ctx.persistAttempts();
    await writeHeartbeat(opts.stateDir, deps.now());

    log.info(`pass finished: ${ctx.resumed} resumed, ${ctx.skipped} skipped`, {
      subsystem: "resume-supervisor",
      operation: "pass",
      metadata: { resumed: ctx.resumed, skipped: ctx.skipped },
    });

    const remaining = queryEligibleSessions(opts.db, opts.dirs);
    if (remaining.length === 0) {
      log.info("no incomplete todos remain", {
        subsystem: "resume-supervisor",
        operation: "pass",
        metadata: { remaining: 0 },
      });
      return 0;
    }
    if (allExhausted(remaining, ctx.attempts, opts.maxAttempts)) {
      log.warn(`${remaining.length} incomplete todo(s) remain after attempts exhausted`, {
        subsystem: "resume-supervisor",
        operation: "pass",
        metadata: { remaining: remaining.length },
      });
      return 2;
    }
    return 0;
  } finally {
    await release();
  }
}

async function cmdWatch(opts: ResolvedOptions, deps: CliDeps): Promise<number> {
  const log = setupLogger(opts, deps);
  await ensureStateDirs(opts.stateDir);
  const release = await tryAcquireLock(stateDirs(opts.stateDir).singletonLock, RESUME_STALE_MS);
  if (release === null) {
    deps.writeErr("another supervisor is running (singleton lock held); exiting 3\n");
    return 3;
  }
  // proper-lockfile refreshes the lock's mtime every `update` ms, so a
  // long-running watch supervisor is never stolen as stale despite the 24h
  // stale window (RESUME_STALE_MS) it opts into.
  try {
    while (true) {
      await writeHeartbeat(opts.stateDir, deps.now());
      const attempts = await readAttempts(opts.stateDir);
      const ctx: PassContext = {
        deps,
        opts,
        log,
        attempts,
        resumed: 0,
        skipped: 0,
        persistAttempts: serializeAttemptsWrites(opts.stateDir, attempts),
      };
      await runPass(queryEligibleSessions(opts.db, opts.dirs), ctx);
      await ctx.persistAttempts();
      await writeHeartbeat(opts.stateDir, deps.now());

      const remaining = queryEligibleSessions(opts.db, opts.dirs);
      if (remaining.length === 0) {
        log.info("no incomplete todos remain; watch done", {
          subsystem: "resume-supervisor",
          operation: "watch",
          metadata: { remaining: 0 },
        });
        return 0;
      }
      if (allExhausted(remaining, ctx.attempts, opts.maxAttempts)) {
        log.warn("attempts exhausted for every remaining session; watch giving up", {
          subsystem: "resume-supervisor",
          operation: "watch",
          metadata: { remaining: remaining.length },
        });
        return 2;
      }
      log.info(`sleeping ${opts.interval}s before the next pass`, {
        subsystem: "resume-supervisor",
        operation: "watch",
        metadata: { intervalSeconds: opts.interval, remaining: remaining.length },
      });
      await sleep(opts.interval * 1000);
    }
  } finally {
    await release();
  }
}

export async function runCli(
  argv: readonly string[],
  depsArg: Partial<CliDeps> = {},
): Promise<number> {
  const deps: CliDeps = {
    env: process.env,
    now: Date.now,
    writeOut: (line) => process.stdout.write(line + "\n"),
    writeErr: (line) => process.stderr.write(line + "\n"),
    spawn,
    ...depsArg,
  };

  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    deps.writeOut(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    deps.writeErr(`${parsed.message}\n\n${USAGE}`);
    return 1;
  }

  try {
    const opts = resolveOptions(parsed.raw, deps.env);
    if (opts.command === "status") return await cmdStatus(opts, deps);
    if (opts.dryRun) return await cmdDryRun(opts, deps);
    if (opts.command === "once") return await cmdOnce(opts, deps);
    return await cmdWatch(opts, deps);
  } catch (error) {
    deps.writeErr(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const moduleEntry = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  resolve(moduleEntry) === resolve(process.argv[1])
) {
  process.exitCode = await runCli(process.argv.slice(2));
}