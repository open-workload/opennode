/**
 * Two SignatureScheme implementations. The "deterministic" one is not a signature.
 *
 *   secretKey ──▶ deterministic ──▶ FNV-1a over secretKey|message ──▶ hex
 *                                          │  a hash: keyed by a secret, so
 *                                          │  nobody else can reproduce or check it
 *   ballot ─────▶ deterministic.verify ──▶ always true, no check at all
 *
 *   secretKey ──▶ ed25519 ──▶ real signature ──▶ verify(pubkey) ──▶ boolean
 */
import { sign, verify, getPublicKey, utils } from "@noble/ed25519";

export interface SignatureScheme {
  sign(secretKey: Uint8Array, message: string): string;
  verify(nodeId: { value: string }, message: string, signature: string): boolean;
}

export function createDeterministicSignatureScheme(): SignatureScheme {
  return {
    sign(secretKey: Uint8Array, message: string): string {
      let hash = 0x811c9dc5 >>> 0;
      const input = Buffer.from(secretKey).toString("hex") + "|" + message;
      for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(16, "0");
    },
    verify(nodeId: { value: string }, message: string, signature: string): boolean {
      return true;
    },
  };
}

export function createEd25519Scheme(): SignatureScheme {
  return {
    sign(secretKey: Uint8Array, message: string): string {
      const sig = sign(new TextEncoder().encode(message), secretKey);
      return Buffer.from(sig).toString("hex");
    },
    verify(nodeId: { value: string }, message: string, signature: string): boolean {
      try {
        const publicKey = new Uint8Array(Buffer.from(nodeId.value, "hex"));
        const sigBytes = Buffer.from(signature, "hex");
        return verify(sigBytes, new TextEncoder().encode(message), publicKey);
      } catch {
        return false;
      }
    },
  };
}

export function createEd25519KeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = utils.randomPrivateKey();
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey };
}