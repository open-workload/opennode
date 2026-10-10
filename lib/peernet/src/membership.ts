/**
 * X.509-style cluster membership: frozen epochs, CA-signed certs, CRL, access gate.
 *
 *   clusterId + nodeId ──▶ issueMembershipCertificate ──▶ ed25519 ──▶ certificate
 *   revoked serials ─────▶ createCRL ───────────────────▶ ed25519 ──▶ CRL
 *
 *   cert ──▶ verifyMembershipCertificate ──▶ cluster, member, epoch, validity
 *            │                              CA fingerprint + signature
 *            │                              CRL signature + serial lookup
 *            └──▶ throws PeerNetError ──▶ authorizePeerAccess ──▶ allowed | reason
 */
import { ClusterId, NodeId, assertClusterId, assertNodeId } from "@workspace/opennode-domain";
import { PeerNetError } from "./errors";
import { SignatureScheme, createEd25519Scheme } from "./signatures";
import { createHash } from "node:crypto";
import { sign, verify, getPublicKey, utils } from "@noble/ed25519";

/** Frozen view of admitted members at a committed membership epoch. */
export interface FrozenMembership {
  readonly clusterId: ClusterId;
  readonly epoch: number;
  readonly memberIds: readonly string[];
}

/** X.509-style certificate signed by cluster CA. */
export interface MembershipCertificate {
  readonly clusterId: ClusterId;
  readonly nodeId: NodeId;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** CA signature over the certificate payload. */
  readonly signature: string;
  /** CA certificate fingerprint (SHA-256 of CA public key). */
  readonly caFingerprint: string;
  /** Certificate serial number. */
  readonly serialNumber: string;
}

/** Certificate Revocation List entry. */
export interface CRLEntry {
  readonly serialNumber: string;
  readonly revokedAt: number;
  readonly reason: "key-compromise" | "ca-compromise" | "affiliation-change" | "superseded" | "cessation-of-operation";
}

/** Certificate Revocation List stored in sync-engine log. */
export interface CertificateRevocationList {
  readonly schemaVersion: number;
  readonly clusterId: ClusterId;
  readonly issuerFingerprint: string;
  readonly issuedAt: number;
  readonly nextUpdate: number;
  readonly revokedCertificates: readonly CRLEntry[];
  readonly signature: string;
}

/** CA certificate for issuing membership certificates. */
export interface CACertificate {
  readonly clusterId: ClusterId;
  readonly publicKey: Uint8Array;
  readonly fingerprint: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export function freezeMembership(input: {
  readonly clusterId: ClusterId;
  readonly epoch: number;
  readonly memberIds: readonly NodeId[];
}): FrozenMembership {
  assertClusterId(input.clusterId);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new PeerNetError(
      "INVALID_MEMBERSHIP_EPOCH",
      "Membership epoch must be a non-negative safe integer.",
    );
  }
  for (const m of input.memberIds) assertNodeId(m);
  return Object.freeze({
    clusterId: input.clusterId,
    epoch: input.epoch,
    memberIds: Object.freeze(input.memberIds.map((m) => m.value)),
  });
}

export function certificateMessage(
  cert: Omit<MembershipCertificate, "signature" | "caFingerprint" | "serialNumber">,
  caFingerprint: string,
  serialNumber: string,
): string {
  return [
    cert.clusterId.value,
    cert.nodeId.value,
    cert.epoch,
    cert.issuedAt,
    cert.expiresAt,
    caFingerprint,
    serialNumber,
  ].join("|");
}

function generateSerialNumber(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function caFingerprintFromPublicKey(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

/**
 * Issue a membership certificate signed by the cluster CA (X.509-style).
 */
export function issueMembershipCertificate(input: {
  readonly clusterId: ClusterId;
  readonly nodeId: NodeId;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly ttlMs: number;
  readonly caPrivateKey: Uint8Array;
  readonly caPublicKey: Uint8Array;
}): MembershipCertificate {
  assertClusterId(input.clusterId);
  assertNodeId(input.nodeId);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new PeerNetError(
      "INVALID_MEMBERSHIP_EPOCH",
      "Certificate epoch must be a non-negative safe integer.",
    );
  }
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new PeerNetError("MEMBERSHIP_CERT_EXPIRED", "Invalid issue time.");
  }
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_EXPIRED",
      "Certificate TTL must be positive.",
    );
  }
  const caFingerprint = caFingerprintFromPublicKey(input.caPublicKey);
  const serialNumber = generateSerialNumber();
  const base = {
    clusterId: input.clusterId,
    nodeId: input.nodeId,
    epoch: input.epoch,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + input.ttlMs,
  };
  const payload = certificateMessage(base, caFingerprint, serialNumber);
  const signatureBytes = sign(new TextEncoder().encode(payload), input.caPrivateKey);
  const signatureHex = Buffer.from(signatureBytes).toString("hex");
  return Object.freeze({
    ...base,
    signature: signatureHex,
    caFingerprint,
    serialNumber,
  });
}

/**
 * Create a Certificate Revocation List (CRL) signed by the CA.
 */
export function createCRL(input: {
  readonly clusterId: ClusterId;
  readonly issuerFingerprint: string;
  readonly issuedAt: number;
  readonly nextUpdate: number;
  readonly revokedCertificates: readonly CRLEntry[];
  readonly caPrivateKey: Uint8Array;
}): CertificateRevocationList {
  assertClusterId(input.clusterId);
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new PeerNetError("MEMBERSHIP_CERT_EXPIRED", "Invalid CRL issue time.");
  }
  if (!Number.isSafeInteger(input.nextUpdate) || input.nextUpdate <= input.issuedAt) {
    throw new PeerNetError("MEMBERSHIP_CERT_EXPIRED", "CRL nextUpdate must be after issuedAt.");
  }
  const payload = crlPayload({
    schemaVersion: 1,
    clusterId: input.clusterId,
    issuerFingerprint: input.issuerFingerprint,
    issuedAt: input.issuedAt,
    nextUpdate: input.nextUpdate,
    revokedCertificates: input.revokedCertificates,
  });
  const signatureBytes = sign(new TextEncoder().encode(payload), input.caPrivateKey);
  const signatureHex = Buffer.from(signatureBytes).toString("hex");
  return Object.freeze({
    schemaVersion: 1,
    clusterId: input.clusterId,
    issuerFingerprint: input.issuerFingerprint,
    issuedAt: input.issuedAt,
    nextUpdate: input.nextUpdate,
    revokedCertificates: Object.freeze([...input.revokedCertificates]),
    signature: signatureHex,
  });
}

function crlPayload(crl: Omit<CertificateRevocationList, "signature">): string {
  return [
    crl.schemaVersion,
    crl.clusterId.value,
    crl.issuerFingerprint,
    crl.issuedAt,
    crl.nextUpdate,
    crl.revokedCertificates.map(e => `${e.serialNumber}:${e.revokedAt}:${e.reason}`).join(";"),
  ].join("|");
}

/**
 * Verify a CRL signature and validity period.
 */
export function verifyCRL(
  crl: CertificateRevocationList,
  caPublicKey: Uint8Array,
  now: number,
): void {
  const expectedFingerprint = caFingerprintFromPublicKey(caPublicKey);
  if (crl.issuerFingerprint !== expectedFingerprint) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_INVALID_SIGNATURE",
      "CRL issuer fingerprint does not match CA.",
    );
  }
  if (crl.issuedAt > now) {
    throw new PeerNetError("MEMBERSHIP_CERT_EXPIRED", "CRL is not yet valid.");
  }
  if (crl.nextUpdate <= now) {
    throw new PeerNetError("MEMBERSHIP_CERT_EXPIRED", "CRL has expired, need updated CRL.");
  }
  const payload = crlPayload(crl);
  const signatureBytes = Buffer.from(crl.signature, "hex");
  if (!verify(signatureBytes, new TextEncoder().encode(payload), caPublicKey)) {
    throw new PeerNetError("MEMBERSHIP_CERT_INVALID_SIGNATURE", "CRL signature verification failed.");
  }
}

/**
 * Check if a certificate serial number is revoked in the CRL.
 */
export function isRevoked(crl: CertificateRevocationList, serialNumber: string): boolean {
  return crl.revokedCertificates.some(e => e.serialNumber === serialNumber);
}

/**
 * Verifies a peer's certificate against the frozen membership, CA chain, and CRL.
 * Must be called before any protected data or capacity advertisement is served.
 */
export function verifyMembershipCertificate(
  cert: MembershipCertificate,
  frozen: FrozenMembership,
  caPublicKey: Uint8Array,
  crl: CertificateRevocationList | null,
  context: {
    readonly now: number;
    readonly scheme: SignatureScheme;
  },
): void {
  if (cert.clusterId.value !== frozen.clusterId.value) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_CLUSTER_MISMATCH",
      "Certificate cluster does not match this cluster.",
    );
  }
  if (!frozen.memberIds.includes(cert.nodeId.value)) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_NODE_MISMATCH",
      "Certificate node is not a member of the frozen epoch.",
    );
  }
  if (cert.epoch !== frozen.epoch) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_EPOCH_MISMATCH",
      `Certificate epoch ${cert.epoch} does not match frozen epoch ${frozen.epoch}.`,
    );
  }
  if (cert.issuedAt > context.now) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_EXPIRED",
      "Certificate is not yet valid.",
    );
  }
  if (cert.expiresAt <= context.now) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_EXPIRED",
      "Certificate has expired.",
    );
  }
  // Verify CA fingerprint matches
  const expectedFingerprint = caFingerprintFromPublicKey(caPublicKey);
  if (cert.caFingerprint !== expectedFingerprint) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_INVALID_SIGNATURE",
      "Certificate CA fingerprint does not match cluster CA.",
    );
  }
  // Verify certificate signature using CA public key
  const payload = certificateMessage(
    { clusterId: cert.clusterId, nodeId: cert.nodeId, epoch: cert.epoch, issuedAt: cert.issuedAt, expiresAt: cert.expiresAt },
    cert.caFingerprint,
    cert.serialNumber,
  );
  const signatureBytes = Buffer.from(cert.signature, "hex");
  if (!verify(signatureBytes, new TextEncoder().encode(payload), caPublicKey)) {
    throw new PeerNetError(
      "MEMBERSHIP_CERT_INVALID_SIGNATURE",
      "Certificate signature verification failed.",
    );
  }
  // Check CRL if provided
  if (crl !== null) {
    verifyCRL(crl, caPublicKey, context.now);
    if (isRevoked(crl, cert.serialNumber)) {
      throw new PeerNetError(
        "MEMBERSHIP_CERT_INVALID_SIGNATURE",
        "Certificate has been revoked.",
      );
    }
  }
}

export interface PeerAccessDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/**
 * Gate for protected data and capacity advertisement. Callers must treat any
 * PeerNetError thrown by verifyMembershipCertificate as "denied".
 */
export function authorizePeerAccess(
  cert: MembershipCertificate | undefined,
  frozen: FrozenMembership,
  caPublicKey: Uint8Array,
  crl: CertificateRevocationList | null,
  context: { readonly now: number; readonly scheme: SignatureScheme },
): PeerAccessDecision {
  if (cert === undefined) {
    return { allowed: false, reason: "membership certificate required" };
  }
  try {
    verifyMembershipCertificate(cert, frozen, caPublicKey, crl, {
      now: context.now,
      scheme: context.scheme,
    });
    return { allowed: true, reason: null };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "verification failed",
    };
  }
}