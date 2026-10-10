import { describe, it, expect } from "vitest";
import { etc } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes } from "@noble/hashes/utils";
import { createEd25519Scheme, createEd25519KeyPair } from "@workspace/peernet/signatures";
import {
  AuditEvent,
  CorrelationIds,
  createClusterId,
  createNodeId,
} from "@workspace/opennode-domain";
import {
  createSecretBroker,
  SecretBroker,
  SecretBrokerConfig,
  SecretStore,
  AuditSink,
} from "./secret-broker";
import {
  GetSecretInput,
  IssueSecretInput,
  JobScope,
  LeaseBoundCapability,
  SecretId,
  SecretValue,
  createJobScope,
  createLeaseBoundCapability,
  createSecretId,
  createWorkerIdentity,
  isWorkerIdentityValid,
  leaseCapabilityMessage,
} from "./types";

etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));

const scheme = createEd25519Scheme();
const issuerKey = createEd25519KeyPair();
const issuerNodeId = createNodeId(Buffer.from(issuerKey.publicKey).toString("hex"));

const correlation: CorrelationIds = { requestId: "get-secret-test" };
const secretId = createSecretId("db-password");
const jobScope = createJobScope({
  jobId: "run-123",
  clusterId: createClusterId("cluster-1"),
  attemptId: "attempt-1",
});
const workerNodeId = createNodeId("worker-1");
const now = Date.now();
const workerIdentity = createWorkerIdentity({
  workerNodeId,
  authorizedBy: issuerNodeId,
  issuedAt: now - 1_000,
  expiresAt: now + 60_000,
});

class MemoryStore implements SecretStore {
  private readonly entries = new Map<string, SecretValue>();

  async put(input: IssueSecretInput): Promise<void> {
    this.entries.set(this.key(input.secretId, input.jobScope), {
      schemaVersion: 1,
      secretId: input.secretId,
      value: input.value,
      createdAt: Date.now(),
    });
  }

  async get(secretId: SecretId, jobScope: JobScope): Promise<SecretValue | null> {
    return this.entries.get(this.key(secretId, jobScope)) ?? null;
  }

  async delete(secretId: SecretId, jobScope: JobScope): Promise<void> {
    this.entries.delete(this.key(secretId, jobScope));
  }

  async exists(secretId: SecretId, jobScope: JobScope): Promise<boolean> {
    return this.entries.has(this.key(secretId, jobScope));
  }

  private key(secretId: SecretId, jobScope: JobScope): string {
    return `${secretId.value}:${jobScope.jobId}:${jobScope.attemptId}`;
  }
}

class RecordingAudit implements AuditSink {
  readonly events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

function createCapability(
  overrides: Partial<Omit<LeaseBoundCapability, "schemaVersion">> = {},
): LeaseBoundCapability {
  return createLeaseBoundCapability({
    runId: "run-123",
    attemptOrdinal: "attempt-1",
    workerNodeId,
    membershipEpoch: 4,
    fencingToken: "fence-9",
    issuedAt: now,
    expiresAt: now + 30_000,
    ...overrides,
  });
}

function signCapability(capability: LeaseBoundCapability): string {
  return scheme.sign(issuerKey.privateKey, leaseCapabilityMessage(capability));
}

function tamper(signature: string): string {
  const first = signature[0] === "0" ? "1" : "0";
  return first + signature.slice(1);
}

async function createSeededBroker(
  overrides: Partial<SecretBrokerConfig> = {},
): Promise<{ broker: SecretBroker; audit: RecordingAudit }> {
  const audit = new RecordingAudit();
  const broker = createSecretBroker({
    store: new MemoryStore(),
    audit,
    verifyCapability: (issuer, message, signature) =>
      scheme.verify(issuer, message, signature),
    ...overrides,
  });
  await broker.issue({ secretId, jobScope, value: "s3cret" }, correlation);
  audit.events.length = 0;
  return { broker, audit };
}

async function expectUnauthorized(
  result: Promise<unknown>,
  audit: RecordingAudit,
): Promise<void> {
  await expect(result).rejects.toMatchObject({
    name: "SecretBrokerError",
    code: "UNAUTHORIZED_WORKER",
  });
  expect(audit.events).toHaveLength(1);
  expect(audit.events[0].details).toMatchObject({
    action: "get_denied",
    success: false,
    errorCode: "UNAUTHORIZED_WORKER",
  });
}

describe("leaseCapabilityMessage", () => {
  it("joins the capability fields with pipes in schema order", () => {
    const capability = createCapability();
    expect(leaseCapabilityMessage(capability)).toBe(
      `capability|run-123|attempt-1|worker-1|4|fence-9|${now}|${now + 30_000}`,
    );
  });
});

describe("createLeaseBoundCapability", () => {
  it("rejects issuedAt that is not before expiresAt", () => {
    expect(() => createCapability({ issuedAt: now, expiresAt: now })).toThrow();
  });
});

describe("secret broker get with a lease-bound capability", () => {
  it("returns the secret for a valid signed capability", async () => {
    const { broker, audit } = await createSeededBroker();
    const capability = createCapability();

    const value = await broker.get(
      {
        secretId,
        jobScope,
        workerIdentity,
        capability,
        capabilitySignature: signCapability(capability),
        issuerNodeId,
      },
      correlation,
    );

    expect(value.value).toBe("s3cret");
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].details).toMatchObject({ action: "get", success: true });
  });

  it("denies when the capability is missing", async () => {
    const { broker, audit } = await createSeededBroker();

    await expectUnauthorized(
      broker.get(
        {
          secretId,
          jobScope,
          workerIdentity,
          capability: undefined as unknown as LeaseBoundCapability,
          capabilitySignature: "00",
          issuerNodeId,
        },
        correlation,
      ),
      audit,
    );
  });

  it("denies a valid identity window when no capability is presented at all", async () => {
    const { broker, audit } = await createSeededBroker();
    expect(isWorkerIdentityValid(workerIdentity, Date.now())).toBe(true);

    await expectUnauthorized(
      broker.get(
        { secretId, jobScope, workerIdentity } as unknown as GetSecretInput,
        correlation,
      ),
      audit,
    );
  });

  it("denies a tampered capability signature", async () => {
    const { broker, audit } = await createSeededBroker();
    const capability = createCapability();

    await expectUnauthorized(
      broker.get(
        {
          secretId,
          jobScope,
          workerIdentity,
          capability,
          capabilitySignature: tamper(signCapability(capability)),
          issuerNodeId,
        },
        correlation,
      ),
      audit,
    );
  });

  it("denies an expired capability", async () => {
    const { broker, audit } = await createSeededBroker();
    const capability = createCapability({
      issuedAt: now - 10_000,
      expiresAt: now - 1,
    });

    await expectUnauthorized(
      broker.get(
        {
          secretId,
          jobScope,
          workerIdentity,
          capability,
          capabilitySignature: signCapability(capability),
          issuerNodeId,
        },
        correlation,
      ),
      audit,
    );
  });

  it("denies a capability whose lifetime outlives the identity window", async () => {
    const { broker, audit } = await createSeededBroker();
    const capability = createCapability({ expiresAt: workerIdentity.expiresAt + 1 });

    await expectUnauthorized(
      broker.get(
        {
          secretId,
          jobScope,
          workerIdentity,
          capability,
          capabilitySignature: signCapability(capability),
          issuerNodeId,
        },
        correlation,
      ),
      audit,
    );
  });

  it("denies a capability bound to a different run", async () => {
    const { broker, audit } = await createSeededBroker();
    const capability = createCapability({ runId: "run-other" });

    await expectUnauthorized(
      broker.get(
        {
          secretId,
          jobScope,
          workerIdentity,
          capability,
          capabilitySignature: signCapability(capability),
          issuerNodeId,
        },
        correlation,
      ),
      audit,
    );
  });

  it("denies a capability bound to a different attempt", async () => {
    const { broker, audit } = await createSeededBroker();
    const capability = createCapability({ attemptOrdinal: "attempt-2" });

    await expectUnauthorized(
      broker.get(
        {
          secretId,
          jobScope,
          workerIdentity,
          capability,
          capabilitySignature: signCapability(capability),
          issuerNodeId,
        },
        correlation,
      ),
      audit,
    );
  });

  it("denies a capability bound to a different worker node", async () => {
    const { broker, audit } = await createSeededBroker();
    const capability = createCapability({ workerNodeId: createNodeId("worker-2") });

    await expectUnauthorized(
      broker.get(
        {
          secretId,
          jobScope,
          workerIdentity,
          capability,
          capabilitySignature: signCapability(capability),
          issuerNodeId,
        },
        correlation,
      ),
      audit,
    );
  });
});
