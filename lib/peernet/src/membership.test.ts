import { describe, it, expect, beforeAll } from "vitest";
import { etc } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes } from "@noble/hashes/utils";
import { createEd25519KeyPair } from "@workspace/peernet/signatures";
import {
  authorizePeerAccess,
  createCRL,
  freezeMembership,
  isRevoked,
  issueMembershipCertificate,
  type CertificateRevocationList,
  type MembershipCertificate,
} from "@workspace/peernet/membership";
import type { SignatureScheme } from "@workspace/peernet/signatures";

etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));

const SCHEMA_VERSION = 1 as const;
const NOW = 1_700_000_000_000;
const TTL_MS = 60_000;

const clusterId = { schemaVersion: SCHEMA_VERSION, value: "cluster-test" };
const nodeId1 = { schemaVersion: SCHEMA_VERSION, value: "node-1" };
const nodeId2 = { schemaVersion: SCHEMA_VERSION, value: "node-2" };
const wrongClusterId = { schemaVersion: SCHEMA_VERSION, value: "cluster-wrong" };

let caKey: { privateKey: Uint8Array; publicKey: Uint8Array };
let otherCaKey: { privateKey: Uint8Array; publicKey: Uint8Array };

beforeAll(() => {
  caKey = createEd25519KeyPair();
  otherCaKey = createEd25519KeyPair();
});

const dummyScheme: SignatureScheme = {
  sign: () => "",
  verify: () => true,
};

function makeCertificate(overrides?: {
  nodeId?: typeof nodeId1;
  epoch?: number;
  issuedAt?: number;
  ttlMs?: number;
  caPrivateKey?: Uint8Array;
  caPublicKey?: Uint8Array;
}): MembershipCertificate {
  return issueMembershipCertificate({
    clusterId,
    nodeId: overrides?.nodeId ?? nodeId1,
    epoch: overrides?.epoch ?? 1,
    issuedAt: overrides?.issuedAt ?? NOW - 1_000,
    ttlMs: overrides?.ttlMs ?? TTL_MS,
    caPrivateKey: overrides?.caPrivateKey ?? caKey.privateKey,
    caPublicKey: overrides?.caPublicKey ?? caKey.publicKey,
  });
}

function makeCRL(
  revokedSerials: string[],
  overrides?: {
    issuedAt?: number;
    nextUpdate?: number;
    caPrivateKey?: Uint8Array;
    issuerFingerprint?: string;
  },
): CertificateRevocationList {
  const certForFingerprint = makeCertificate();
  return createCRL({
    clusterId,
    issuerFingerprint: overrides?.issuerFingerprint ?? certForFingerprint.caFingerprint,
    issuedAt: overrides?.issuedAt ?? NOW - 1_000,
    nextUpdate: overrides?.nextUpdate ?? NOW + 60_000,
    revokedCertificates: revokedSerials.map((serialNumber) => ({
      serialNumber,
      revokedAt: NOW,
      reason: "key-compromise" as const,
    })),
    caPrivateKey: overrides?.caPrivateKey ?? caKey.privateKey,
  });
}

describe("membership - authorizePeerAccess and validation", () => {
  const frozen = freezeMembership({ clusterId, epoch: 1, memberIds: [nodeId1, nodeId2] });

  it("accepts a valid certificate", () => {
    const cert = makeCertificate();
    const decision = authorizePeerAccess(cert, frozen, caKey.publicKey, null, {
      now: NOW,
      scheme: dummyScheme,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it("rejects when certificate is missing (undefined)", () => {
    const decision = authorizePeerAccess(undefined, frozen, caKey.publicKey, null, {
      now: NOW,
      scheme: dummyScheme,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("membership certificate required");
  });

  it("rejects certificate signed by unknown CA", () => {
    const cert = makeCertificate({
      caPrivateKey: otherCaKey.privateKey,
      caPublicKey: otherCaKey.publicKey,
    });
    const decision = authorizePeerAccess(cert, frozen, caKey.publicKey, null, {
      now: NOW,
      scheme: dummyScheme,
    });
    expect(decision.allowed).toBe(false);
    // Real validation throws - reason reflects error message; key branches: fingerprint mismatch or sig verify fail
    expect(decision.reason).not.toBeNull();
  });

  it("rejects revoked serial via CRL", () => {
    const cert = makeCertificate();
    const crl = makeCRL([cert.serialNumber]);
    const decision = authorizePeerAccess(cert, frozen, caKey.publicKey, crl, {
      now: NOW,
      scheme: dummyScheme,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).not.toBeNull();
  });

  it("rejects expired certificate", () => {
    const cert = makeCertificate({ issuedAt: NOW - 120_000, ttlMs: 60_000 });
    const decision = authorizePeerAccess(cert, frozen, caKey.publicKey, null, {
      now: NOW,
      scheme: dummyScheme,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("expired");
  });

  it("rejects certificate with wrong cluster", () => {
    const wrongFrozen = freezeMembership({ clusterId: wrongClusterId, epoch: 1, memberIds: [nodeId1] });
    const cert = makeCertificate();
    const decision = authorizePeerAccess(cert, wrongFrozen, caKey.publicKey, null, {
      now: NOW,
      scheme: dummyScheme,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).not.toBeNull();
  });
});

describe("membership - CRL operations", () => {
  it("isRevoked returns true for revoked serial and false for fresh one", () => {
    const cert = makeCertificate();
    const crl = makeCRL([cert.serialNumber]);
    expect(isRevoked(crl, cert.serialNumber)).toBe(true);
    expect(isRevoked(crl, "non-revoked-serial-123456")).toBe(false);
  });

  it("createCRL produces CRL that isRevoked honors", () => {
    const cert = makeCertificate();
    const crl = createCRL({
      clusterId,
      issuerFingerprint: cert.caFingerprint,
      issuedAt: NOW - 500,
      nextUpdate: NOW + 30_000,
      revokedCertificates: [
        { serialNumber: cert.serialNumber, revokedAt: NOW - 100, reason: "key-compromise" },
        { serialNumber: "another-serial", revokedAt: NOW - 50, reason: "superseded" },
      ],
      caPrivateKey: caKey.privateKey,
    });
    expect(crl.schemaVersion).toBe(1);
    expect(crl.clusterId).toEqual(clusterId);
    expect(crl.issuerFingerprint).toBe(cert.caFingerprint);
    expect(isRevoked(crl, cert.serialNumber)).toBe(true);
    expect(isRevoked(crl, "another-serial")).toBe(true);
    expect(isRevoked(crl, "never-revoked")).toBe(false);
  });
});
