#!/usr/bin/env node
/**
 * Commander CLI over the OpenNode HTTP API. Holds a bearer token in
 * ~/.opennode/credentials.json (dir 0700, file 0600) and prints text output.
 * lib/cliClient resolves the base URL and the Bearer header lazily at request
 * time, so both the JSON and SSE paths share one source of truth.
 *
 *   argv ─▶ program.parseAsync ─▶ subcommand ─▶ apiRequest(path)
 *     │                                            │
 *     │   resolveApiBaseUrl(flag | env | creds.apiUrl) ─▶ base URL
 *     │   buildAuthHeaders(creds) ─▶ Bearer <token>, unexpired only
 *     │                                            │
 *     │                       !res.ok ─▶ throw Error(body.error) ─▶ exit 1
 *     │
 *     login ─▶ write token, 24h TTL      logout ─▶ delete the credentials file
 *     status / preflight / submit / list / show / cancel / retry / peer-status
 *     logs --follow ─▶ authedFetch to the SSE stream, decoding `data:` lines
 */

import { program } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {
  authedFetch,
  resolveApiBaseUrl,
  type CliCredentials,
} from "../src/lib/cliClient";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), ".opennode");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

interface StoredCredentials extends CliCredentials {
  apiUrl: string;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadCredentials(): StoredCredentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const data = readFileSync(CREDENTIALS_FILE, "utf8");
    return JSON.parse(data) as StoredCredentials;
  } catch {
    return null;
  }
}

function saveCredentials(creds: StoredCredentials): void {
  ensureConfigDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    try { require("node:fs").unlinkSync(CREDENTIALS_FILE); } catch {}
  }
}

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const creds = loadCredentials();
  const base = resolveApiBaseUrl({ envUrl: process.env.OPENNODE_API_URL, creds });
  const res = await authedFetch(`${base}${path}`, creds, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

program
  .name("opennode")
  .description("OpenNode CLI - manage runs, peers, and cluster state")
  .version("0.1.0")
  .option("--api-url <url>", "API base URL")
  .hook("preAction", (thisCmd) => {
    const opts = thisCmd.opts();
    if (opts.apiUrl) {
      process.env.OPENNODE_API_URL = opts.apiUrl;
    }
  });

program
  .command("login")
  .description("Authenticate with the OpenNode API")
  .option("--token <token>", "Bearer token (if not provided, will prompt)")
  .action(async (opts) => {
    const token = opts.token ?? process.env.OPENNODE_TOKEN;
    if (!token) {
      console.error("Error: Provide --token or set OPENNODE_TOKEN env var");
      process.exit(1);
    }
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    saveCredentials({
      token,
      expiresAt,
      apiUrl: resolveApiBaseUrl({ envUrl: process.env.OPENNODE_API_URL }),
    });
    console.log("Logged in successfully. Token stored in OS credential store.");
  });

program
  .command("logout")
  .description("Clear stored credentials")
  .action(() => {
    clearCredentials();
    console.log("Logged out. Credentials cleared.");
  });

program
  .command("status")
  .description("Show cluster health and local node status")
  .action(async () => {
    try {
      const health = await apiRequest<{ status: string }>("/api/healthz");
      console.log("API Health:", health.status);
      const summary = await apiRequest<any>("/api/dashboard/summary");
      console.log("Cluster:", summary.cluster?.clusterId);
      console.log("Sync:", summary.cluster?.syncStatus);
      console.log("Consensus:", summary.cluster?.consensusStatus);
      console.log("Peers:", `${summary.cluster?.connectedCount ?? 0}/${summary.cluster?.memberCount ?? 0}`);
      console.log("Runs: queued:", summary.runCounts?.queued ?? 0, "running:", summary.runCounts?.running ?? 0, "succeeded:", summary.runCounts?.succeeded ?? 0);
    } catch (err) {
      console.error("Failed to get status:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("preflight")
  .description("Validate a workload without executing it")
  .requiredOption("--name <name>", "Run name")
  .requiredOption("--mode <mode>", "Workload mode", "diagnostic")
  .option("--image <image>", "Container image (required for container mode)")
  .option("--command <cmd...>", "Command arguments")
  .option("--cpu <milli>", "CPU millicores", "500")
  .option("--memory <mib>", "Memory MiB", "512")
  .option("--disk <mib>", "Disk MiB", "1024")
  .option("--timeout <seconds>", "Timeout seconds", "60")
  .option("--network <policy>", "Network policy", "deny_all")
  .action(async (opts) => {
    try {
      const payload = {
        clientRequestId: `cli-${randomBytes(8).toString("hex")}`,
        name: opts.name,
        mode: opts.mode,
        image: opts.mode === "container" ? (opts.image ?? null) : null,
        command: opts.command ?? [],
        resources: {
          cpuMilli: Number(opts.cpu),
          memoryMiB: Number(opts.memory),
          diskMiB: Number(opts.disk),
          timeoutSeconds: Number(opts.timeout),
        },
        networkPolicy: opts.network,
      };
      const result = await apiRequest<any>("/api/runs/preflight", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      console.log("Preflight result:");
      console.log("  Can submit:", result.canSubmit);
      console.log("  Execution available:", result.executionAvailable);
      console.log("  Execution mode:", result.executionMode);
      console.log("  Checks:");
      for (const check of result.checks) {
        console.log(`    [${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
      }
    } catch (err) {
      console.error("Preflight failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("submit")
  .description("Submit a workload run")
  .requiredOption("--name <name>", "Run name")
  .requiredOption("--mode <mode>", "Workload mode", "diagnostic")
  .option("--image <image>", "Container image (required for container mode)")
  .option("--command <cmd...>", "Command arguments")
  .option("--cpu <milli>", "CPU millicores", "500")
  .option("--memory <mib>", "Memory MiB", "512")
  .option("--disk <mib>", "Disk MiB", "1024")
  .option("--timeout <seconds>", "Timeout seconds", "60")
  .option("--network <policy>", "Network policy", "deny_all")
  .action(async (opts) => {
    try {
      const payload = {
        clientRequestId: `cli-${randomBytes(8).toString("hex")}`,
        name: opts.name,
        mode: opts.mode,
        image: opts.mode === "container" ? (opts.image ?? null) : null,
        command: opts.command ?? [],
        resources: {
          cpuMilli: Number(opts.cpu),
          memoryMiB: Number(opts.memory),
          diskMiB: Number(opts.disk),
          timeoutSeconds: Number(opts.timeout),
        },
        networkPolicy: opts.network,
      };
      const result = await apiRequest<any>("/api/runs", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      console.log("Run submitted:");
      console.log("  Run ID:", result.id);
      console.log("  Name:", result.name);
      console.log("  Status:", result.status);
      console.log("  Execution mode:", result.executionMode);
    } catch (err) {
      console.error("Submit failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List workload runs")
  .option("--limit <n>", "Max results", "25")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--status <status>", "Filter by status")
  .action(async (opts) => {
    try {
      const params = new URLSearchParams();
      params.set("limit", opts.limit);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.status) params.set("status", opts.status);
      const result = await apiRequest<any>(`/api/runs?${params.toString()}`);
      for (const run of result.items) {
        console.log(`${run.id}  ${run.name.padEnd(30)}  ${run.status.padEnd(16)}  ${run.executionMode}  ${new Date(run.createdAt).toISOString()}`);
      }
      if (result.nextCursor) console.log(`\nNext cursor: ${result.nextCursor}`);
    } catch (err) {
      console.error("List failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("show")
  .description("Show detailed run information")
  .argument("<run-id>", "Run ID")
  .action(async (runId) => {
    try {
      const run = await apiRequest<any>(`/api/runs/${runId}`);
      console.log("Run:", run.id);
      console.log("  Name:", run.name);
      console.log("  Mode:", run.mode);
      console.log("  Image:", run.image ?? "N/A");
      console.log("  Image digest:", run.imageDigest ?? "N/A");
      console.log("  Command:", run.command?.join(" ") ?? "N/A");
      console.log("  Status:", run.status);
      console.log("  Execution mode:", run.executionMode);
      console.log("  Worker:", run.workerNodeId ?? "N/A");
      console.log("  Attempts:", run.attemptCount);
      console.log("  Resources:", `${run.resources.cpuMilli}m CPU, ${run.resources.memoryMiB}MiB mem, ${run.resources.diskMiB}MiB disk, ${run.resources.timeoutSeconds}s timeout`);
      console.log("  Network:", run.networkPolicy);
      console.log("  Submitted by:", run.submittedBy);
      console.log("  Via node:", run.submittedViaNodeId);
      console.log("  Created:", run.createdAt);
      console.log("  Updated:", run.updatedAt);
      if (run.failureReason) console.log("  Failure:", run.failureReason);
    } catch (err) {
      console.error("Show failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("logs")
  .description("Fetch or follow run logs")
  .argument("<run-id>", "Run ID")
  .option("--follow", "Follow live logs (Server-Sent Events)")
  .option("--limit <n>", "Max entries", "100")
  .option("--cursor <cursor>", "Resume from cursor")
  .action(async (runId, opts) => {
    try {
      if (opts.follow) {
        console.log(`Following logs for ${runId}... (Ctrl+C to stop)`);
        const creds = loadCredentials();
        const base = resolveApiBaseUrl({ envUrl: process.env.OPENNODE_API_URL, creds });
        const res = await authedFetch(`${base}/api/runs/logs/stream?runId=${encodeURIComponent(runId)}&follow=true&limit=${opts.limit}${opts.cursor ? `&cursor=${opts.cursor}` : ""}`, creds, {
          headers: { Accept: "text/event-stream" },
        });
        for await (const chunk of res.body?.getReader().stream() ?? []) {
          const text = new TextDecoder().decode(chunk);
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                console.log(`[${data.attempt}:${data.sequence}] ${data.stream}: ${data.message}`);
              } catch {}
            }
          }
        }
      } else {
        const params = new URLSearchParams();
        params.set("runId", runId);
        params.set("limit", opts.limit);
        if (opts.cursor) params.set("cursor", opts.cursor);
        const result = await apiRequest<any>(`/api/runs/logs?${params.toString()}`);
        for (const entry of result.items) {
          console.log(`[${entry.attempt}:${entry.sequence}] ${entry.stream}: ${entry.message}`);
        }
        if (result.nextCursor) console.log(`\nNext cursor: ${result.nextCursor}`);
      }
    } catch (err) {
      console.error("Logs failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("cancel")
  .description("Request cancellation of a run")
  .argument("<run-id>", "Run ID")
  .action(async (runId) => {
    try {
      const result = await apiRequest<any>(`/api/runs/${runId}/cancel`, { method: "POST" });
      console.log("Cancellation requested:");
      console.log("  Run ID:", result.id);
      console.log("  Status:", result.status);
    } catch (err) {
      console.error("Cancel failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("retry")
  .description("Retry a failed or cancelled run")
  .argument("<run-id>", "Run ID")
  .action(async (runId) => {
    try {
      const result = await apiRequest<any>(`/api/runs/${runId}/retry`, { method: "POST" });
      console.log("Retry requested:");
      console.log("  Run ID:", result.id);
      console.log("  Status:", result.status);
    } catch (err) {
      console.error("Retry failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("peer-status")
  .description("Show peer network status")
  .action(async () => {
    try {
      const nodes = await apiRequest<any[]>("/api/nodes");
      console.log("Known peers:");
      for (const node of nodes) {
        console.log(`  ${node.id}  ${node.name.padEnd(20)}  ${node.status.padEnd(12)}  ${node.role}  ${node.canExecute ? "EXEC" : "----"}  ${node.lastSeenAt ? new Date(node.lastSeenAt).toISOString() : "never"}`);
      }
    } catch (err) {
      console.error("Peer status failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});