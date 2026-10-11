import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESUME_STALE_MS,
  runCli,
  singletonLockTarget,
} from "./opencode-session-resume";

interface TodoSpec {
  readonly content: string;
  readonly status: string;
}

interface SessionSpec {
  readonly id: string;
  readonly title: string;
  readonly directory: string;
  readonly parentId?: string;
  readonly timeArchived?: number;
  readonly todos: readonly TodoSpec[];
}

interface FixtureEnv {
  readonly dbPath: string;
  readonly stateDir: string;
  readonly binDir: string;
  readonly argvFile: string;
  readonly timingFile: string;
  readonly stubDb: string;
}

const STUB_TEMPLATE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const argv = process.argv.slice(2);
const sessionIndex = argv.indexOf("--session");
const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : null;

if (process.env.STUB_ARGV_FILE) {
  appendFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(argv) + "\\n");
}

function finish() {
  if (process.env.STUB_TIMING_FILE && sessionId) {
    appendFileSync(process.env.STUB_TIMING_FILE, "end " + sessionId + " " + Date.now() + "\\n");
  }
  process.exit(Number(process.env.STUB_EXIT ?? "0"));
}

if (process.env.STUB_COMPLETE === "1" && process.env.STUB_DB && sessionId) {
  const db = new DatabaseSync(process.env.STUB_DB);
  db.prepare(
    "UPDATE todo SET status = 'completed', time_updated = ? WHERE session_id = ?"
  ).run(Date.now(), sessionId);
  db.close();
}

const sleepMs = Number(process.env.STUB_SLEEP_MS ?? "0");
if (process.env.STUB_TIMING_FILE && sessionId) {
  appendFileSync(process.env.STUB_TIMING_FILE, "start " + sessionId + " " + Date.now() + "\\n");
}

function countStarts() {
  try {
    return require("node:fs")
      .readFileSync(process.env.STUB_TIMING_FILE, "utf8")
      .split("\\n")
      .filter((line) => line.startsWith("start ")).length;
  } catch {
    return 0;
  }
}

function waitForBarrier() {
  const need = Number(process.env.STUB_BARRIER_COUNT ?? "0");
  if (!need || countStarts() >= need) {
    setTimeout(finish, sleepMs);
    return;
  }
  setTimeout(waitForBarrier, 10);
}

waitForBarrier();
`;

async function buildFixture(
  sessions: readonly SessionSpec[],
): Promise<FixtureEnv> {
  const dir = await mkdtemp(join(tmpdir(), "resume-fixture-"));
  const dbPath = join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE todo (
      session_id TEXT,
      content TEXT,
      status TEXT NOT NULL,
      priority INTEGER,
      position INTEGER,
      time_created INTEGER,
      time_updated INTEGER
    )
  `);
  for (const session of sessions) {
    db.prepare(
      `INSERT INTO session
         (id, parent_id, directory, title, time_created, time_updated, time_archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.parentId ?? null,
      session.directory,
      session.title,
      1,
      1,
      session.timeArchived ?? null,
    );
    for (const todo of session.todos) {
      db.prepare(
        `INSERT INTO todo
           (session_id, content, status, priority, position, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(session.id, todo.content, todo.status, 0, 0, 1, 1);
    }
  }
  db.close();

  const stateDir = join(dir, "state", "opencode", "resume-supervisor");
  const binDir = join(dir, "bin");
  const argvFile = join(dir, "opencode-argv.jsonl");
  const timingFile = join(dir, "opencode-timing.jsonl");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "opencode"), STUB_TEMPLATE);
  await chmod(join(binDir, "opencode"), 0o755);
  return { dbPath, stateDir, binDir, argvFile, timingFile, stubDb: dbPath };
}

function envFor(fixture: FixtureEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCODE_DB: fixture.dbPath,
    XDG_STATE_HOME: join(fixture.stateDir, "..", ".."),
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    STUB_ARGV_FILE: fixture.argvFile,
    STUB_TIMING_FILE: fixture.timingFile,
    STUB_DB: fixture.stubDb,
  };
}

interface Wire {
  readonly stdout: string[];
  readonly stderr: string[];
}

function wire() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      writeOut: (line: string) => stdout.push(line),
      writeErr: (line: string) => stderr.push(line),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readArgvLines(path: string): Promise<string[][]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

interface AttemptState {
  attempts: number;
  lastAttemptAt: number;
}

interface Timing {
  readonly start: number;
  readonly end: number;
}

function overlaps(a: Timing, b: Timing): boolean {
  return a.start < b.end && b.start < a.end;
}

async function readTimings(path: string): Promise<Map<string, Timing>> {
  const raw = await readFile(path, "utf8").catch(() => "");
  const timings = new Map<string, Timing>();
  for (const line of raw.split("\n").filter((l) => l.length > 0)) {
    const [event, id, ts] = line.split(" ");
    const entry = timings.get(id) ?? { start: NaN, end: NaN };
    if (event === "start") entry.start = Number(ts);
    if (event === "end") entry.end = Number(ts);
    timings.set(id, entry);
  }
  return timings;
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("opencode-session-resume", () => {
  let envBackup: NodeJS.ProcessEnv;
  let fixtures: FixtureEnv[] = [];

  beforeEach(() => {
    envBackup = { ...process.env };
    fixtures = [];
  });

  afterEach(() => {
    process.env = envBackup;
    for (const fixture of fixtures) {
      void fixture;
    }
  });

  async function fixture(sessions: readonly SessionSpec[]): Promise<FixtureEnv> {
    const f = await buildFixture(sessions);
    fixtures.push(f);
    return f;
  }

  const pending = (status = "pending"): TodoSpec => ({
    content: "finish the thing",
    status,
  });

  const ROOT: readonly SessionSpec[] = [
    {
      id: "s-a",
      title: "session a",
      directory: "/work/dir-a",
      todos: [pending()],
    },
    {
      id: "s-b",
      title: "session b",
      directory: "/work/dir-a",
      todos: [{ content: "done", status: "completed" }],
    },
    {
      id: "s-c",
      title: "session c",
      directory: "/work/dir-a",
      timeArchived: 123,
      todos: [pending()],
    },
    {
      id: "s-d",
      title: "session d",
      directory: "/work/dir-a",
      parentId: "s-a",
      todos: [pending()],
    },
    {
      id: "s-e",
      title: "session e",
      directory: "/work/dir-b",
      todos: [pending()],
    },
  ];

  it("status lists only eligible sessions and respects --dir", async () => {
    const f = await fixture(ROOT);
    const env = envFor(f);
    const out = wire();

    const code = await runCli(["status"], { env, ...out.deps });
    expect(code).toBe(0);
    const stdout = out.stdout.join("\n");
    expect(stdout).toContain("s-a");
    expect(stdout).toContain("s-e");
    expect(stdout).not.toContain("s-b");
    expect(stdout).not.toContain("s-c");
    expect(stdout).not.toContain("s-d");

    const filtered = wire();
    const codeFiltered = await runCli(
      ["status", "--dir", "/work/dir-a"],
      { env, ...filtered.deps },
    );
    expect(codeFiltered).toBe(0);
    const filteredOut = filtered.stdout.join("\n");
    expect(filteredOut).toContain("s-a");
    expect(filteredOut).not.toContain("s-e");
  });

  it("once --dry-run prints the plan and spawns nothing", async () => {
    const f = await fixture([
      { id: "s-x", title: "x", directory: "/work/dir-x", todos: [pending()] },
    ]);
    const env = envFor(f);
    const out = wire();

    const code = await runCli(["once", "--dry-run", "--dir", "/work/dir-x"], {
      env,
      ...out.deps,
    });

    expect(code).toBe(0);
    const stdout = out.stdout.join("\n");
    expect(stdout).toContain("s-x");
    expect(stdout).toContain("resume");
    await expect(readFile(f.argvFile, "utf8")).rejects.toThrow();
    await expect(readFile(join(f.stateDir, "attempts.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(f.stateDir, "heartbeat"), "utf8")).rejects.toThrow();
  });

  it("once spawns the stub with --session/--dir for eligible sessions and writes state", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = envFor(f);
    const out = wire();

    const code = await runCli(["once"], { env, ...out.deps });

    expect(code).toBe(0);
    const argv = await readArgvLines(f.argvFile);
    expect(argv.length).toBe(1);
    expect(argv[0][0]).toBe("run");
    expect(argv[0]).toContain("--session");
    expect(argv[0]).toContain("s-a");
    expect(argv[0]).toContain("--dir");
    expect(argv[0]).toContain("/work/dir-a");

    const attempts = await readJson<Record<string, AttemptState>>(
      join(f.stateDir, "attempts.json"),
    );
    expect(attempts["s-a"]).toBeDefined();
    expect(attempts["s-a"].attempts).toBe(1);
    expect(attempts["s-a"].lastAttemptAt).toBeGreaterThan(0);

    const heartbeat = await readFile(join(f.stateDir, "heartbeat"), "utf8");
    expect(new Date(heartbeat).getTime()).toBeGreaterThan(0);

    const lines = await readJsonl(join(f.stateDir, "resume-supervisor.jsonl"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.timestamp).toBeTypeOf("number");
      expect(typeof line.message).toBe("string");
    }
  });

  it("exits 3 when another supervisor holds the singleton lock", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = envFor(f);
    await mkdir(f.stateDir, { recursive: true });
    const release = await lockfile.lock(singletonLockTarget(f.stateDir), {
      realpath: false,
      retries: 0,
      stale: RESUME_STALE_MS,
    });
    const out = wire();

    const code = await runCli(["once"], { env, ...out.deps });

    expect(code).toBe(3);
    expect(out.stderr.join("\n")).toMatch(/another supervisor/i);
    await release();

    await expect(readFile(f.argvFile, "utf8")).rejects.toThrow();
  });

  it("serializes sessions in the same directory but allows different directories to overlap", async () => {
    const f = await fixture([
      {
        id: "s1",
        title: "same dir 1",
        directory: "/work/dir-1",
        todos: [pending()],
      },
      {
        id: "s2",
        title: "same dir 2",
        directory: "/work/dir-1",
        todos: [pending()],
      },
      {
        id: "s3",
        title: "other dir 1",
        directory: "/work/dir-2",
        todos: [pending()],
      },
      {
        id: "s4",
        title: "other dir 2",
        directory: "/work/dir-2",
        todos: [pending()],
      },
    ]);
    const env = {
      ...envFor(f),
      STUB_SLEEP_MS: "150",
      STUB_BARRIER_COUNT: "2",
    };
    const out = wire();

    const code = await runCli(["once", "--max-parallel", "2"], {
      env,
      ...out.deps,
    });

    expect(code).toBe(0);
    const timings = await readTimings(f.timingFile);
    expect(timings.get("s1")).toBeDefined();
    expect(timings.get("s2")).toBeDefined();
    expect(timings.get("s3")).toBeDefined();
    expect(timings.get("s4")).toBeDefined();
    expect(overlaps(timings.get("s1")!, timings.get("s2")!)).toBe(false);
    expect(overlaps(timings.get("s3")!, timings.get("s4")!)).toBe(false);
    expect(overlaps(timings.get("s1")!, timings.get("s3")!)).toBe(true);
  });

  it("gives up on a session whose attempts are exhausted and exits 2", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = { ...envFor(f), STUB_EXIT: "1" };
    const out = wire();

    const code = await runCli(["once", "--max-attempts", "1"], {
      env,
      ...out.deps,
    });

    expect(code).toBe(2);
    const argv = await readArgvLines(f.argvFile);
    expect(argv.length).toBe(1);
    const attempts = await readJson<Record<string, AttemptState>>(
      join(f.stateDir, "attempts.json"),
    );
    expect(attempts["s-a"].attempts).toBe(1);
  });

  it("skips a session on cooldown after a recent attempt", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = envFor(f);
    const first = wire();

    const code1 = await runCli(["once"], { env, ...first.deps });
    expect(code1).toBe(0);

    const second = wire();
    const code2 = await runCli(["once", "--cooldown", "300"], {
      env,
      ...second.deps,
    });
    expect(code2).toBe(0);

    const argv = await readArgvLines(f.argvFile);
    expect(argv.length).toBe(1);
  });

  it("watch exits 0 once the stub completes all todos", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = { ...envFor(f), STUB_COMPLETE: "1" };
    const out = wire();

    const code = await runCli(["watch", "--interval", "0.05"], {
      env,
      ...out.deps,
    });

    expect(code).toBe(0);
    const argv = await readArgvLines(f.argvFile);
    expect(argv.length).toBe(1);
  });

  it("watch exits 2 when attempts are exhausted", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = { ...envFor(f), STUB_EXIT: "1" };
    const out = wire();

    const code = await runCli(
      ["watch", "--interval", "0.05", "--max-attempts", "1", "--cooldown", "0"],
      { env, ...out.deps },
    );

    expect(code).toBe(2);
  });

  it("honors OPENCODE_DB and lets --db override it", async () => {
    const dbA = await fixture([
      {
        id: "from-a",
        title: "only in a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const dbB = await fixture([
      {
        id: "from-b",
        title: "only in b",
        directory: "/work/dir-b",
        todos: [pending()],
      },
    ]);

    const envA = envFor(dbA);
    const outA = wire();
    const codeA = await runCli(["status"], { env: envA, ...outA.deps });
    expect(codeA).toBe(0);
    expect(outA.stdout.join("\n")).toContain("from-a");
    expect(outA.stdout.join("\n")).not.toContain("from-b");

    const envB = envFor(dbB);
    const explicit = wire();
    const codeB = await runCli(["status", "--db", dbA.dbPath], {
      env: envB,
      ...explicit.deps,
    });
    expect(codeB).toBe(0);
    const stdoutB = explicit.stdout.join("\n");
    expect(stdoutB).toContain("from-a");
    expect(stdoutB).not.toContain("from-b");
  });

  it("accepts a leading -- separator (pnpm forwards it)", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = envFor(f);
    const out = wire();

    const code = await runCli(["--", "status"], { env, ...out.deps });

    expect(code).toBe(0);
    expect(out.stdout.join("\n")).toContain("s-a");
  });

  it("resume --auto is passed through to the stub", async () => {
    const f = await fixture([
      {
        id: "s-a",
        title: "session a",
        directory: "/work/dir-a",
        todos: [pending()],
      },
    ]);
    const env = envFor(f);
    const out = wire();

    const code = await runCli(["once", "--auto"], { env, ...out.deps });
    expect(code).toBe(0);

    const argv = await readArgvLines(f.argvFile);
    expect(argv[0]).toContain("--auto");
    expect(argv[0]).toContain("run");
  });
});