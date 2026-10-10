import { describe, expect, it, beforeAll, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { etc, sign } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes } from "@noble/hashes/utils";
import { createEd25519KeyPair } from "@workspace/peernet/signatures";
import {
  createCRL,
  freezeMembership,
  issueMembershipCertificate,
  type CertificateRevocationList,
  type MembershipCertificate,
} from "@workspace/peernet/membership";
import { createPeerAuthMiddleware, type PeerAuthenticatedRequest } from "./peerAuth";

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));

const NOW = 1_700_000_000_000;
const REQUEST_URL = "/api/peer/capacity";
const NONCE = "abcdefghijklmnopqrstuvwxyz0123456789";
const SCHEMA_VERSION = 1 as const;

const clusterId = { schemaVersion: SCHEMA_VERSION, value: "cluster-a" };
const nodeId = { schemaVersion: SCHEMA_VERSION, value: "node-1" };

let caKey: { privateKey: Uint8Array; publicKey: Uint8Array };
let peerKey: { privateKey: Uint8Array; publicKey: Uint8Array };

beforeAll(() => {
  caKey = createEd25519KeyPair();
  peerKey = createEd25519KeyPair();
});

function makeCertificate(overrides?: { issuedAt?: number; ttlMs?: number }): MembershipCertificate {
  return issueMembershipCertificate({
    clusterId,
    nodeId,
    epoch: 3,
    issuedAt: overrides?.issuedAt ?? NOW - 1_000,
    ttlMs: overrides?.ttlMs ?? 60_000,
    caPrivateKey: caKey.privateKey,
    caPublicKey: caKey.publicKey,
  });
}

function signRequest(cert: MembershipCertificate, nonce: string, timestamp = NOW): Record<string, string> {
  const message = ["POST", REQUEST_URL, String(timestamp), nonce, "{}"].join("\n");
  const signature = Buffer.from(sign(new TextEncoder().encode(message), peerKey.privateKey)).toString("base64");
  return {
    "x-peer-certificate": Buffer.from(JSON.stringify(cert)).toString("base64"),
    "x-peer-signature": signature,
    "x-peer-timestamp": String(timestamp),
    "x-peer-nonce": nonce,
  };
}

function makeMiddleware(getCRL: () => CertificateRevocationList | null = () => null) {
  return createPeerAuthMiddleware({
    caPublicKey: caKey.publicKey,
    frozenMembership: freezeMembership({ clusterId, epoch: 3, memberIds: [nodeId] }),
    getCRL,
    now: () => NOW,
    getPeerPublicKey: (id: string) => (id === nodeId.value ? peerKey.publicKey : null),
  });
}

function invoke(middleware: ReturnType<typeof createPeerAuthMiddleware>, headers: Record<string, string>) {
  const req = {
    method: "POST",
    originalUrl: REQUEST_URL,
    path: REQUEST_URL,
    headers,
    body: {},
  } as unknown as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const setHeader = vi.fn();
  const res = { status, json, setHeader } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, status, json, setHeader, next };
}

describe("createPeerAuthMiddleware", () => {
  it("allows a signed request with a valid membership certificate", async () => {
    const middleware = makeMiddleware();
    const cert = makeCertificate();
    const { req, res, status, next } = invoke(middleware, signRequest(cert, NONCE));

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect((req as unknown as PeerAuthenticatedRequest).peerAuth).toEqual({
      certificate: cert,
      nodeId: nodeId.value,
      clusterId: clusterId.value,
    });
  });

  it("rejects an expired membership certificate", async () => {
    const middleware = makeMiddleware();
    const cert = makeCertificate({ issuedAt: NOW - 120_000, ttlMs: 60_000 });
    const { req, res, status, json, next } = invoke(middleware, signRequest(cert, NONCE));

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PEER_CERT_INVALID", error: "Certificate has expired." }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a certificate whose CA signature no longer validates", async () => {
    const middleware = makeMiddleware();
    const cert = makeCertificate();
    const tampered = { ...cert, expiresAt: cert.expiresAt + 1 };
    const { req, res, status, json, next } = invoke(middleware, signRequest(tampered, NONCE));

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "PEER_CERT_INVALID" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a certificate revoked on the cluster CRL", async () => {
    const cert = makeCertificate();
    const crl = createCRL({
      clusterId,
      issuerFingerprint: cert.caFingerprint,
      issuedAt: NOW - 1_000,
      nextUpdate: NOW + 60_000,
      revokedCertificates: [{ serialNumber: cert.serialNumber, revokedAt: NOW, reason: "key-compromise" }],
      caPrivateKey: caKey.privateKey,
    });
    const middleware = makeMiddleware(() => crl);
    const { req, res, status, json, next } = invoke(middleware, signRequest(cert, NONCE));

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PEER_CERT_INVALID", error: "Certificate has been revoked." }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a replayed nonce", async () => {
    const middleware = makeMiddleware();
    const headers = signRequest(makeCertificate(), NONCE);

    const first = invoke(middleware, headers);
    await middleware(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledOnce();

    const second = invoke(middleware, headers);
    await middleware(second.req, second.res, second.next);
    expect(second.status).toHaveBeenCalledWith(401);
    expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PEER_SIGNATURE_INVALID" }));
    expect(second.next).not.toHaveBeenCalled();
  });
});