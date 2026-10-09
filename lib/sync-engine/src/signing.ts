import { createHmac, timingSafeEqual } from "node:crypto";

export interface Signer {
  readonly signerId: string;
  sign(message: string): string;
}

export interface SignatureVerifier {
  verify(signerId: string, message: string, signature: string): boolean;
}

export function createHmacSigner(signerId: string, secret: string): Signer {
  if (typeof signerId !== "string" || signerId.trim().length === 0) {
    throw new Error("signerId must not be empty");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("secret must not be empty");
  }
  return {
    signerId,
    sign(message: string): string {
      return createHmac("sha256", secret).update(message, "utf8").digest("hex");
    },
  };
}

export function createHmacVerifier(
  secrets: Readonly<Record<string, string>>,
): SignatureVerifier {
  return {
    verify(signerId: string, message: string, signature: string): boolean {
      const secret = secrets[signerId];
      if (secret === undefined) return false;
      const expected = createHmac("sha256", secret)
        .update(message, "utf8")
        .digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}
