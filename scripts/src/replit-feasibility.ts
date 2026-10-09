#!/usr/bin/env tsx
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, constants, openSync, closeSync, fsyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  critical: boolean;
}

const results: TestResult[] = [];

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function addResult(name: string, passed: boolean, details: string, critical = true) {
  results.push({ name, passed, details, critical });
  const status = passed ? "✅ PASS" : "❌ FAIL";
  const crit = critical ? " [CRITICAL]" : "";
  log(`${status}${crit} ${name}: ${details}`);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test 1: Persistent volumes with fsync
async function testPersistentVolumes(): Promise<void> {
  log("Testing persistent volumes with fsync...");
  
  const testDir = join(tmpdir(), "replit-feasibility-test");
  const testFile = join(testDir, "persistence-test.dat");
  
  try {
    // Clean up any previous test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    
    // Test 1a: Basic file write and read
    const testData = "test-data-" + Date.now();
    writeFileSync(testFile, testData);
    const readData = readFileSync(testFile, "utf-8");
    addResult("File write/read", readData === testData, `Data integrity: ${readData === testData ? "OK" : "FAILED"}`);
    
    // Test 1b: fsync durability
    const fd = openSync(testFile, "w");
    const syncData = "sync-test-" + Date.now();
    writeFileSync(fd, syncData);
    try {
      fsyncSync(fd);
      addResult("fsync() syscall", true, "fsync() succeeded");
    } catch (e) {
      addResult("fsync() syscall", false, `fsync() failed: ${e}`);
    }
    closeSync(fd);
    
    // Test 1c: Persistence across "restart" (new process)
    const persistFile = join(testDir, "persist-across-restart.dat");
    writeFileSync(persistFile, "persistent-data");
    fsyncSync(openSync(persistFile, "r"));
    
    // Simulate a new process reading the file
    const child = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      const data = fs.readFileSync("${persistFile.replace(/\\/g, "\\\\")}", "utf8");
      console.log(data);
    `]);
    
    const output = await new Promise<string>((resolve) => {
      let out = "";
      child.stdout.on("data", (d) => out += d);
      child.on("close", () => resolve(out.trim()));
    });
    
    addResult("Persistence across process boundary", output === "persistent-data", 
      output === "persistent-data" ? "Data survived process boundary" : `Got: ${output}`);
    
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
    
  } catch (e) {
    addResult("Persistent volumes", false, `Test error: ${e}`);
  }
}

// Test 2: Stable inbound endpoint (autoproxy timeout)
async function testStableInboundEndpoint(): Promise<void> {
  log("Testing stable inbound endpoint...");
  
  // Check if we're running on Replit
  const isReplit = process.env.REPL_ID !== undefined || process.env.REPL_SLUG !== undefined;
  
  if (!isReplit) {
    addResult("Stable inbound endpoint", false, "Not running on Replit - cannot test autoproxy behavior", false);
    return;
  }
  
  // On Replit, check the deployment URL
  const replitDomain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS;
  if (replitDomain) {
    addResult("Replit domain available", true, `Domain: ${replitDomain}`);
  } else {
    addResult("Replit domain available", false, "No REPLIT_DEV_DOMAIN or REPLIT_DOMAINS found");
  }
  
  // Test if we can bind to a port and receive inbound connections
  // This simulates the autoproxy behavior - Replit's autoscale deployments
  // use a proxy that may timeout idle connections
  addResult("Autoproxy timeout check", false, "Requires actual deployment to test - marked as NOT VERIFIED", false);
  
  // Check if REPLIT_DEPLOYMENT_URL is set (indicates autoscale deployment)
  if (process.env.REPLIT_DEPLOYMENT_URL) {
    addResult("Running on autoscale deployment", true, `Deployment URL: ${process.env.REPLIT_DEPLOYMENT_URL}`);
  } else {
    addResult("Running on autoscale deployment", false, "Not on autoscale deployment (REPLIT_DEPLOYMENT_URL not set)");
  }
}

// Test 3: Unprivileged user namespaces / cgroups v2
async function testUserNamespacesAndCgroups(): Promise<void> {
  log("Testing user namespaces and cgroups v2...");
  
  // Test 3a: User namespaces
  try {
    const result = execSync("unshare --user --map-root-user true", { encoding: "utf-8", timeout: 5000 });
    addResult("User namespaces (unshare)", true, "unshare --user works");
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; stderr?: string };
    if (err.status === 1 && err.stderr?.includes("Operation not permitted")) {
      addResult("User namespaces (unshare)", false, "User namespaces not available (Operation not permitted)");
    } else {
      addResult("User namespaces (unshare)", false, `Error: ${err.message ?? err.stderr ?? String(e)}`);
    }
  }
  
  // Test 3b: cgroups v2
  const cgroupVersion = existsSync("/sys/fs/cgroup/cgroup.controllers") ? "v2" : "v1/unknown";
  addResult("cgroups version", cgroupVersion === "v2", `cgroups: ${cgroupVersion}`);
  
  // Test 3c: Check if we can create cgroups (requires root or delegation)
  try {
    const cgroupPath = "/sys/fs/cgroup/test-feasibility";
    execSync(`mkdir -p ${cgroupPath}`, { timeout: 2000 });
    execSync(`echo 100000 > ${cgroupPath}/cpu.max`, { timeout: 2000 });
    execSync(`rmdir ${cgroupPath}`, { timeout: 2000 });
    addResult("cgroup v2 write access", true, "Can create and write to cgroups");
  } catch (e: unknown) {
    const err = e as { message?: string; stderr?: string };
    addResult("cgroup v2 write access", false, `Cannot write cgroups: ${err.message ?? err.stderr ?? String(e)}`);
  }
  
  // Test 3d: Check for cgroup delegation (systemd-run --user)
  try {
    execSync("systemd-run --user --scope --collect true", { timeout: 5000, stdio: "ignore" });
    addResult("systemd user delegation", true, "systemd-run --user works");
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    if (err.status === 1 && err.message?.includes("Failed to connect to bus")) {
      addResult("systemd user delegation", false, "No user systemd bus (expected in containers)");
    } else {
      addResult("systemd user delegation", false, `Error: ${err.message}`);
    }
  }
}

// Test 4: Process lifetime >24h
async function testProcessLifetime(): Promise<void> {
  log("Testing process lifetime...");
  
  const isReplit = process.env.REPL_ID !== undefined || process.env.REPL_SLUG !== undefined;
  
  if (!isReplit) {
    addResult("Process lifetime >24h", false, "Not on Replit - cannot test autoscale sleep behavior", false);
    return;
  }
  
  // Check if we're in an autoscale deployment (which sleeps on idle)
  if (process.env.REPLIT_DEPLOYMENT_URL) {
    addResult("Autoscale deployment (sleeps on idle)", false, "Autoscale deployments sleep after inactivity - process lifetime < 24h without traffic");
  } else {
    addResult("Reserved VM deployment (stays alive)", true, "Not on autoscale - likely reserved VM which stays alive");
  }
  
  // Check for REPLIT_KEEP_ALIVE or similar
  if (process.env.REPLIT_KEEP_ALIVE) {
    addResult("Keep-alive configured", true, "REPLIT_KEEP_ALIVE is set");
  } else {
    addResult("Keep-alive configured", false, "No keep-alive mechanism detected");
  }
}

// Test 5: Deploy minimal libp2p node and test connectivity
async function testLibp2pConnectivity(): Promise<void> {
  log("Testing libp2p connectivity (simulated - requires actual deployment)...");
  
  // This test would require actual deployment to Replit
  // For now, we document what would be tested
  addResult("libp2p node identity persistence", false, "Requires actual Replit deployment to test", false);
  addResult("Outbound connectivity to bootstrap peers", false, "Requires actual Replit deployment to test", false);
  addResult("Inbound connectivity from peers", false, "Requires actual Replit deployment to test", false);
  addResult("Long-lived streams (30+ min)", false, "Requires actual Replit deployment to test", false);
  addResult("TLS/Noise handshake completion", false, "Requires actual Replit deployment to test", false);
  addResult("NAT traversal / relay connectivity", false, "Requires actual Replit deployment to test", false);
}

// Test 6: Worker isolation capabilities
async function testWorkerIsolation(): Promise<void> {
  log("Testing worker isolation capabilities...");
  
  // Test if we can run containers (Docker/podman)
  try {
    execSync("docker version", { timeout: 5000, stdio: "ignore" });
    addResult("Docker available", true, "Docker daemon accessible");
  } catch {
    addResult("Docker available", false, "Docker not available");
  }
  
  try {
    execSync("podman version", { timeout: 5000, stdio: "ignore" });
    addResult("Podman available", true, "Podman accessible");
  } catch {
    addResult("Podman available", false, "Podman not available");
  }
  
  // Test udocker (rootless container execution)
  try {
    execSync("udocker version", { timeout: 5000, stdio: "ignore" });
    addResult("udocker available", true, "udocker accessible");
  } catch {
    addResult("udocker available", false, "udocker not available");
  }
  
  // Test bubblewrap (sandboxing)
  try {
    execSync("bwrap --version", { timeout: 2000, stdio: "ignore" });
    addResult("bubblewrap available", true, "bwrap accessible");
  } catch {
    addResult("bubblewrap available", false, "bubblewrap not available");
  }
}

// Test 7: Storage durability - SQLite with WAL mode
async function testStorageDurability(): Promise<void> {
  log("Testing storage durability (SQLite)...");
  
  const testDir = join(tmpdir(), "replit-sqlite-test");
  const dbFile = join(testDir, "test.db");
  
  try {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    
    // Test SQLite with WAL mode and fsync
    const child = spawn(process.execPath, ["-e", `
      const Database = require("better-sqlite3");
      const db = new Database("${dbFile.replace(/\\/g, "\\\\")}");
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, data TEXT)");
      const stmt = db.prepare("INSERT INTO test (data) VALUES (?)");
      for (let i = 0; i < 100; i++) {
        stmt.run("data-" + i);
      }
      db.close();
      console.log("OK");
    `], { timeout: 10000 });
    
    const output = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d) => out += d);
      child.stderr.on("data", (d) => out += d);
      child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(out)));
    });
    
    addResult("SQLite WAL + FULL synchronous", output.includes("OK"), output.includes("OK") ? "SQLite works with durability settings" : output);
    
    // Test persistence across process
    const child2 = spawn(process.execPath, ["-e", `
      const Database = require("better-sqlite3");
      const db = new Database("${dbFile.replace(/\\/g, "\\\\")}");
      const count = db.prepare("SELECT COUNT(*) as c FROM test").get().c;
      console.log(count);
      db.close();
    `], { timeout: 5000 });
    
    const countOutput = await new Promise<string>((resolve, reject) => {
      let out = "";
      child2.stdout.on("data", (d) => out += d);
      child2.stderr.on("data", (d) => out += d);
      child2.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(out)));
    });
    
    addResult("SQLite persistence across process", countOutput === "100", `Row count: ${countOutput}`);
    
    rmSync(testDir, { recursive: true, force: true });
    
  } catch (e: unknown) {
    const err = e as { message?: string };
    addResult("SQLite durability", false, `Test error: ${err.message ?? String(e)}`);
  }
}

// Main test runner
async function main() {
  log("=== Replit Autoscale Deployment Feasibility Assessment ===");
  log(`Platform: ${process.platform} ${process.arch}`);
  log(`Node: ${process.version}`);
  log(`Replit: ${process.env.REPL_ID ? "YES" : "NO"}`);
  log(`Autoscale: ${process.env.REPLIT_DEPLOYMENT_URL ? "YES" : "NO"}`);
  log("");
  
  await testPersistentVolumes();
  log("");
  await testStableInboundEndpoint();
  log("");
  await testUserNamespacesAndCgroups();
  log("");
  await testProcessLifetime();
  log("");
  await testLibp2pConnectivity();
  log("");
  await testWorkerIsolation();
  log("");
  await testStorageDurability();
  log("");
  
  // Summary
  log("=== SUMMARY ===");
  const criticalTests = results.filter(r => r.critical);
  const passedCritical = criticalTests.filter(r => r.passed).length;
  const totalCritical = criticalTests.length;
  const passedAll = results.filter(r => r.passed).length;
  const totalAll = results.length;
  
  log(`Critical tests: ${passedCritical}/${totalCritical} passed`);
  log(`All tests: ${passedAll}/${totalAll} passed`);
  log("");
  
  // Determine overall verdict
  const criticalFailed = criticalTests.filter(r => !r.passed);
  if (criticalFailed.length > 0) {
    log("❌ VERDICT: Replit CANNOT host a full OpenNode peer");
    log("Failed critical requirements:");
    for (const test of criticalFailed) {
      log(`  - ${test.name}: ${test.details}`);
    }
    log("");
    log("Replit is suitable for UI/client deployment only.");
  } else {
    log("✅ VERDICT: Replit MAY support full OpenNode peer (all critical tests passed)");
    log("Note: libp2p connectivity tests require actual deployment verification.");
  }
  
  // Exit code based on critical tests
  process.exit(criticalFailed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});