/**
 * Hostile input tests exercising existing validation/rejection branches
 * without modifying production code. These tests verify isolation boundaries.
 */

import { describe, it, expect } from "vitest";
import { ContentStoreClient, DownloadAuthz } from "./contentStore";
import { validateWorkerSpec } from "./spec";
import { SecretBrokerClient } from "./secretBroker";
import { RealWorkerBackend } from "./realBackend";
import { RootlessBackend } from "./rootlessBackend";
import { tmpdir } from "node:os";

const createMasterKey = () => ContentStoreClient.generateMasterKey("test-master");

const makeSpecBase = () => ({
  runId: "run-1",
  attemptId: "attempt-1",
  jobId: "job-1",
  clusterId: "cluster-1",
  image: { ref: "busybox:1.35", digest: "sha256" + "a".repeat(64) },
  command: ["/bin/true"],
  env: { entries: [] },
  limits: {
    cpuMilli: 1000,
    memoryBytes: 64 * 1024 * 1024,
    pidLimit: 64,
    diskBytes: 64 * 1024 * 1024,
    wallClockMs: 5000,
    outputBytes: 65536,
  },
  network: {
    mode: "deny_all" as const,
    allowedEgressHosts: [],
    blockMetadataEndpoints: true,
    blockControlPlane: true,
  },
  scratchDir: "/tmp/test-scratch",
});

describe("ContentStoreClient - hostile inputs", () => {
  it("rejects oversized chunk (chunk_too_large)", async () => {
    const client = new ContentStoreClient({ masterKey: createMasterKey(), maxChunkSize: 10 });
    const largeData = new Uint8Array(11);
    await expect(client.encryptChunk(largeData)).rejects.toThrowError(
      expect.objectContaining({ code: "chunk_too_large" })
    );
  });

  it("allows chunk at exactly maxChunkSize boundary", async () => {
    const max = 100;
    const client = new ContentStoreClient({ masterKey: createMasterKey(), maxChunkSize: max });
    const data = new Uint8Array(max);
    for (let i = 0; i < max; i++) data[i] = i % 255;
    const result = await client.encryptChunk(data);
    expect(result).toBeDefined();
  });

  it("rejects checksum mismatch on decrypt", async () => {
    const client = new ContentStoreClient({ masterKey: createMasterKey() });
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const encrypted = await client.encryptChunk(data);
    await expect(
      client.decryptChunk({
        encryptedData: encrypted.encryptedData,
        wrappedKey: encrypted.wrappedKey,
        expectedChecksum: "wrong-checksum",
      })
    ).rejects.toThrowError(expect.objectContaining({ code: "checksum_mismatch" }));
  });

  it("rejects master key mismatch on decrypt", async () => {
    const client1 = new ContentStoreClient({ masterKey: createMasterKey() });
    const client2 = new ContentStoreClient({ masterKey: ContentStoreClient.generateMasterKey('other-master') });
    const data = new Uint8Array([7, 8, 9]);
    const encrypted = await client1.encryptChunk(data);
    await expect(
      client2.decryptChunk({
        encryptedData: encrypted.encryptedData,
        wrappedKey: encrypted.wrappedKey,
        expectedChecksum: encrypted.checksum,
      })
    ).rejects.toThrowError(expect.objectContaining({ code: "master_key_mismatch" }));
  });

  it("DownloadAuthz rejects unknown principal", () => {
    const authz = new DownloadAuthz();
    expect(
      authz.checkAccess({
        workerNodeId: "worker-1",
        jobId: "job-1",
        attemptId: "attempt-1",
        chunkAddress: "addr-1",
      })
    ).toBe(false);
  });

  it("DownloadAuthz rejects after revokeAccess", () => {
    const authz = new DownloadAuthz();
    authz.authorize("worker-1", "job-1", "attempt-1", ["addr-1"]);
    authz.revokeAccess("job-1", "attempt-1");
    expect(
      authz.checkAccess({
        workerNodeId: "worker-1",
        jobId: "job-1",
        attemptId: "attempt-1",
        chunkAddress: "addr-1",
      })
    ).toBe(false);
  });

  it("DownloadAuthz rejects mismatched attemptId", () => {
    const authz = new DownloadAuthz();
    authz.authorize("worker-1", "job-1", "attempt-1", ["addr-1"]);
    expect(
      authz.checkAccess({
        workerNodeId: "worker-1",
        jobId: "job-1",
        attemptId: "attempt-2",
        chunkAddress: "addr-1",
      })
    ).toBe(false);
  });
});

describe("validateWorkerSpec - hostile inputs", () => {
  it("rejects metadata endpoint injection and control-plane regex", () => {
    const spec = {
      ...makeSpecBase(),
      network: {
        mode: "allowlist" as const,
        allowedEgressHosts: ["169.254.169.254", "api.internal.opennode-control-plane.test", "169.254.169.253"],
        blockMetadataEndpoints: true,
        blockControlPlane: true,
      },
    };
    const result = validateWorkerSpec(spec as any);
    expect(result.ok).toBe(false);
  });

  it("rejects env with invalid name, duplicate, secret_ref issues, literal missing value", () => {
    const spec = {
      ...makeSpecBase(),
      env: {
        entries: [
          { name: "A-B", source: "literal" as const, value: "x" },
          { name: "dup", source: "literal" as const, value: "1" },
          { name: "dup", source: "literal" as const, value: "2" },
          { name: "secret", source: "secret_ref" as const, value: "inline" },
          { name: "secret2", source: "secret_ref" as const },
          { name: "badlit", source: "literal" as const },
        ],
      },
    };
    const result = validateWorkerSpec(spec as any);
    expect(result.ok).toBe(false);
  });

  it("rejects insecure network policy variants", () => {
    const cases = [
      { mode: "open", allowedEgressHosts: [], blockMetadataEndpoints: true, blockControlPlane: true },
      { mode: "allowlist", allowedEgressHosts: [], blockMetadataEndpoints: true, blockControlPlane: true },
      { mode: "deny_all", allowedEgressHosts: [], blockMetadataEndpoints: false, blockControlPlane: true },
      { mode: "deny_all", allowedEgressHosts: [], blockMetadataEndpoints: true, blockControlPlane: false },
    ];
    for (const net of cases) {
      const spec = { ...makeSpecBase(), network: net as any };
      const result = validateWorkerSpec(spec as any);
      expect(result.ok).toBe(false);
    }
  });
});

describe("SecretBrokerClient - hostile tokens", () => {
  const fakeBroker = {} as any;

  it("rejects empty lease token", async () => {
    const client = new SecretBrokerClient({ broker: fakeBroker, workerNodeId: "worker-1" as any });
    await expect(client.getSecret("ref", "job", "attempt", "cluster" as any, "")).rejects.toThrowError(
      expect.objectContaining({ code: "invalid_lease_token" })
    );
  });

  it("rejects token with 'nope'", async () => {
    const client = new SecretBrokerClient({ broker: fakeBroker, workerNodeId: "worker-1" as any });
    await expect(client.getSecret("ref", "job", "attempt", "cluster" as any, "nope")).rejects.toThrowError(
      expect.objectContaining({ code: "invalid_lease_token" })
    );
  });

  it("rejects token with 'null'", async () => {
    const client = new SecretBrokerClient({ broker: fakeBroker, workerNodeId: "worker-1" as any });
    await expect(client.getSecret("ref", "job", "attempt", "cluster" as any, "null")).rejects.toThrowError(
      expect.objectContaining({ code: "invalid_lease_token" })
    );
  });

  it("rejects token with empty object", async () => {
    const client = new SecretBrokerClient({ broker: fakeBroker, workerNodeId: "worker-1" as any });
    await expect(client.getSecret("ref", "job", "attempt", "cluster" as any, "{}")).rejects.toThrowError(
      expect.objectContaining({ code: "invalid_lease_token" })
    );
  });

  it("rejects token with capability null", async () => {
    const client = new SecretBrokerClient({ broker: fakeBroker, workerNodeId: "worker-1" as any });
    const token = JSON.stringify({
      capability: null,
      capabilitySignature: "sig",
      issuerNodeId: "issuer",
    });
    await expect(client.getSecret("ref", "job", "attempt", "cluster" as any, token)).rejects.toThrowError(
      expect.objectContaining({ code: "invalid_lease_token" })
    );
  });
});

describe("RealWorkerBackend - hostile setup", () => {
  it("propagates oci pull rejection and performs cleanup", async () => {
    const failingPuller = {
      pull: async () => {
        throw new Error("pull failed");
      },
    };
    const backend = new RealWorkerBackend({
      ociPuller: failingPuller as any,
      scratchRoot: tmpdir(),
    });
    await expect(backend.start(makeSpecBase() as any)).rejects.toThrow("pull failed");
  });

  it("reports infrastructure_error when runtimePath points to nonexistent binary", async () => {
    const backend = new RealWorkerBackend({
      runtimePath: "/nonexistent/docker-xyz",
      scratchRoot: tmpdir(),
    });
    const handle = await backend.start(makeSpecBase() as any);
    const result = await handle.wait();
    expect(result.status).toBe("infrastructure_error");
    await handle.cleanup();
  });
});

describe("RootlessBackend - hostile invocation", () => {
  it("reports infrastructure_error when invocationFactory returns nonexistent binary", async () => {
    const backend = new RootlessBackend({
      kind: "userns",
      installPrefix: "/nonexistent",
      invocationFactory: () => ({ file: "/nonexistent/xyz", args: [] }),
    });
    const handle = await backend.start(makeSpecBase() as any);
    const result = await handle.wait();
    expect(result.status).toBe("infrastructure_error");
    await handle.cleanup();
  });
});
