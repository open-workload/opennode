/**
 * AES-256-GCM encryption for chunk payloads, plus an XOR stub kept alongside it.
 *
 *   plaintext ──▶ random 12-byte IV ──▶ createCipheriv ──▶ ciphertext + authTag
 *   key (32 bytes) ─────────────────┘                     └──▶ EncryptedData
 *   EncryptedData ──▶ setAuthTag ──▶ createDecipheriv ──▶ plaintext
 *
 * StubEncryptor is repeating-key XOR with a zero IV and a zero auth tag, so it
 * is not encryption; nothing outside this file imports it.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export interface Encryptor {
  readonly algorithm: string;
  encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptedData>;
  decrypt(encrypted: EncryptedData, key: Uint8Array): Promise<Uint8Array>;
  generateKey(): Promise<Uint8Array>;
}

export interface EncryptedData {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly algorithm: string;
}

export interface EncryptionConfig {
  readonly algorithm: string;
  readonly keySize: number;
  readonly ivSize: number;
  readonly authTagSize: number;
}

export function createAesGcmEncryptor(config?: Partial<EncryptionConfig>): Encryptor {
  const finalConfig: EncryptionConfig = {
    algorithm: "aes-256-gcm",
    keySize: 32,
    ivSize: 12,
    authTagSize: 16,
    ...config,
  };

  return {
    algorithm: finalConfig.algorithm,
    async encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptedData> {
      if (key.length !== finalConfig.keySize) {
        throw new Error(`Invalid key size: expected ${finalConfig.keySize} bytes, got ${key.length}`);
      }
      const iv = randomBytes(finalConfig.ivSize);
      const cipher = createCipheriv(finalConfig.algorithm, key, iv) as unknown as { update: (data: Uint8Array) => Buffer; final: () => Buffer; getAuthTag: () => Buffer };
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return {
        ciphertext: new Uint8Array(ciphertext),
        iv: new Uint8Array(iv),
        authTag: new Uint8Array(authTag),
        algorithm: finalConfig.algorithm,
      };
    },
    async decrypt(encrypted: EncryptedData, key: Uint8Array): Promise<Uint8Array> {
      if (key.length !== finalConfig.keySize) {
        throw new Error(`Invalid key size: expected ${finalConfig.keySize} bytes, got ${key.length}`);
      }
      if (encrypted.algorithm !== finalConfig.algorithm) {
        throw new Error(`Algorithm mismatch: expected ${finalConfig.algorithm}, got ${encrypted.algorithm}`);
      }
      if (encrypted.iv.length !== finalConfig.ivSize) {
        throw new Error(`Invalid IV size: expected ${finalConfig.ivSize} bytes, got ${encrypted.iv.length}`);
      }
      if (encrypted.authTag.length !== finalConfig.authTagSize) {
        throw new Error(`Invalid auth tag size: expected ${finalConfig.authTagSize} bytes, got ${encrypted.authTag.length}`);
      }
      const decipher = createDecipheriv(finalConfig.algorithm, key, encrypted.iv) as unknown as { update: (data: Buffer) => Buffer; final: () => Buffer; setAuthTag: (tag: Buffer) => void };
      decipher.setAuthTag(Buffer.from(encrypted.authTag));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext)), decipher.final()]);
      return new Uint8Array(plaintext);
    },
    async generateKey(): Promise<Uint8Array> {
      return randomBytes(finalConfig.keySize);
    },
  };
}

export const defaultEncryptor = createAesGcmEncryptor();

export class StubEncryptor implements Encryptor {
  readonly algorithm = "stub-xor";

  async encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptedData> {
    const iv = new Uint8Array(16);
    const ciphertext = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) {
      ciphertext[i] = plaintext[i] ^ key[i % key.length];
    }
    const authTag = new Uint8Array(16);
    return { ciphertext, iv, authTag, algorithm: this.algorithm };
  }

  async decrypt(encrypted: EncryptedData, key: Uint8Array): Promise<Uint8Array> {
    if (encrypted.algorithm !== this.algorithm) {
      throw new Error(`Algorithm mismatch: expected ${this.algorithm}, got ${encrypted.algorithm}`);
    }
    const plaintext = new Uint8Array(encrypted.ciphertext.length);
    for (let i = 0; i < encrypted.ciphertext.length; i++) {
      plaintext[i] = encrypted.ciphertext[i] ^ key[i % key.length];
    }
    return plaintext;
  }

  async generateKey(): Promise<Uint8Array> {
    return randomBytes(32);
  }
}

export function createStubEncryptor(): Encryptor {
  return new StubEncryptor();
}