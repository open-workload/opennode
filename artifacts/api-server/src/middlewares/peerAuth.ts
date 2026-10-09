import { type Request, type Response, type NextFunction } from "express";
import { verify } from "@noble/ed25519";
import { PeerNetError } from "@workspace/peernet";
import {
  MembershipCertificate,
  CertificateRevocationList,
  FrozenMembership,
  verifyMembershipCertificate,
} from "@workspace/peernet/membership";
import { createEd25519Scheme } from "@workspace/peernet/signatures";
import { logger } from "../lib/logger";

const MAX_CLOCK_SKEW_MS = 60_000;

export interface PeerAuthenticatedRequest extends Request {
  peerAuth?: {
    certificate: MembershipCertificate;
    nodeId: string;
    clusterId: string;
  };
}

/**
 * Verify a request using the public key resolved from the committed node
 * identity, not from a caller-controlled certificate field. Signed request
 * scope includes method, path, timestamp, nonce, and canonical JSON body.
 */
async function verifyRequestSignature(
  req: Request,
  certificate: MembershipCertificate,
  opts: {
    readonly now: number;
    readonly getPeerPublicKey: (nodeId: string) => Uint8Array | null;
    readonly consumeNonce: (nodeId: string, nonce: string, expiresAt: number) => Promise<boolean>;
  },
): Promise<boolean> {
  const signatureHeader = req.headers["x-peer-signature"];
  const timestampHeader = req.headers["x-peer-timestamp"];
  const nonceHeader = req.headers["x-peer-nonce"];
  if (
    typeof signatureHeader !== "string" ||
    typeof timestampHeader !== "string" ||
    typeof nonceHeader !== "string" ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(nonceHeader)
  ) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(opts.now - timestamp) > MAX_CLOCK_SKEW_MS) {
    return false;
  }

  const nodeId = certificate.nodeId.value;
  try {
    const signature = Buffer.from(signatureHeader, "base64");
    const publicKey = opts.getPeerPublicKey(nodeId);
    if (!publicKey || publicKey.byteLength !== 32 || signature.byteLength !== 64) {
      return false;
    }
    const message = [
      req.method.toUpperCase(),
      req.originalUrl,
      String(timestamp),
      nonceHeader,
      stableStringify(req.body ?? {}),
    ].join("\n");
    const validSignature = await verify(
      signature,
      new TextEncoder().encode(message),
      publicKey,
    );
    if (!validSignature) return false;
    return await opts.consumeNonce(nodeId, nonceHeader, timestamp + MAX_CLOCK_SKEW_MS);
  } catch {
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

/**
 * Middleware for peer-facing endpoints that requires:
 * 1. Valid membership certificate (X.509-style signed by cluster CA)
 * 2. Signature on request body (X-Peer-Signature header)
 * 3. Certificate not expired, not revoked, correct cluster
 * 4. CRL check
 */
export function createPeerAuthMiddleware(opts: {
  readonly caPublicKey: Uint8Array;
  readonly frozenMembership: FrozenMembership;
  readonly getCRL: () => CertificateRevocationList | null;
  readonly now: () => number;
  readonly getPeerPublicKey: (nodeId: string) => Uint8Array | null;
  readonly consumeNonce: (nodeId: string, nonce: string, expiresAt: number) => Promise<boolean>;
}) {
  return async function peerAuthMiddleware(
    req: PeerAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Extract certificate from header (base64 encoded JSON)
    const certHeader = req.headers["x-peer-certificate"];
    if (!certHeader || typeof certHeader !== "string") {
      res.status(401).json({ 
        error: "Missing X-Peer-Certificate header", 
        code: "PEER_CERT_REQUIRED" 
      });
      return;
    }

    let certificate: MembershipCertificate;
    try {
      const certJson = Buffer.from(certHeader, "base64").toString("utf8");
      certificate = JSON.parse(certJson);
    } catch {
      res.status(400).json({ 
        error: "Invalid X-Peer-Certificate format", 
        code: "PEER_CERT_INVALID_FORMAT" 
      });
      return;
    }

    // Verify request body signature
    if (!(await verifyRequestSignature(req, certificate, {
      now: opts.now(),
      getPeerPublicKey: opts.getPeerPublicKey,
      consumeNonce: opts.consumeNonce,
    }))) {
      res.status(401).json({ 
        error: "Invalid or missing request body signature", 
        code: "PEER_SIGNATURE_INVALID" 
      });
      return;
    }

    // Verify membership certificate with CA and CRL
    const crl = opts.getCRL();
    try {
      verifyMembershipCertificate(
        certificate,
        opts.frozenMembership,
        opts.caPublicKey,
        crl,
        {
          now: opts.now(),
          scheme: createEd25519Scheme(),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Certificate verification failed";
      const code = error instanceof PeerNetError ? error.code : "PEER_CERT_INVALID";
      logger.warn({ err: error, path: req.path, nodeId: certificate.nodeId.value }, "Peer certificate verification failed");
      res.status(401).json({ error: message, code });
      return;
    }

    // Check cluster match
    const expectedClusterId = req.headers["x-cluster-id"];
    if (expectedClusterId && typeof expectedClusterId === "string") {
      if (certificate.clusterId.value !== expectedClusterId) {
        res.status(403).json({ 
          error: "Certificate cluster does not match requested cluster", 
          code: "PEER_CLUSTER_MISMATCH" 
        });
        return;
      }
    }

    req.peerAuth = {
      certificate,
      nodeId: certificate.nodeId.value,
      clusterId: certificate.clusterId.value,
    };

    res.setHeader("X-Peer-Node-ID", certificate.nodeId.value);
    res.setHeader("X-Peer-Cluster-ID", certificate.clusterId.value);
    next();
  };
}

/**
 * Optional peer auth - doesn't reject if certificate missing, but validates if present.
 */
export function createOptionalPeerAuthMiddleware(opts: {
  readonly caPublicKey: Uint8Array;
  readonly frozenMembership: FrozenMembership;
  readonly getCRL: () => CertificateRevocationList | null;
  readonly now: () => number;
  readonly getPeerPublicKey: (nodeId: string) => Uint8Array | null;
  readonly consumeNonce: (nodeId: string, nonce: string, expiresAt: number) => Promise<boolean>;
}) {
  const requiredMiddleware = createPeerAuthMiddleware(opts);
  return async function optionalPeerAuthMiddleware(
    req: PeerAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const certHeader = req.headers["x-peer-certificate"];
    if (!certHeader) {
      next();
      return;
    }
    await requiredMiddleware(req, res, next);
  };
}