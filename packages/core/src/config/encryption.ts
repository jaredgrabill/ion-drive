/**
 * Encryption utilities for Ion Drive secrets (AES-256-GCM).
 *
 * Secrets are encrypted at rest with an authenticated cipher so tampering is
 * detectable. The master key comes from configuration (`ION_ENCRYPTION_KEY`):
 * a 64-character hex string is used directly as 32 raw bytes; anything else is
 * stretched to 32 bytes via scrypt so a human-typed passphrase still works.
 *
 * Ciphertext is serialized as `iv.authTag.data`, each part base64-encoded.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, recommended for GCM
const KEY_BYTES = 32;
const SCRYPT_SALT = 'ion-drive:secrets:v1';

export class Encryptor {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    this.key = /^[0-9a-fA-F]{64}$/.test(masterKey)
      ? Buffer.from(masterKey, 'hex')
      : scryptSync(masterKey, SCRYPT_SALT, KEY_BYTES);
  }

  /** Encrypts a UTF-8 plaintext, returning `iv.authTag.data` (base64 parts). */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${authTag.toString('base64')}.${data.toString('base64')}`;
  }

  /** Decrypts a value produced by {@link encrypt}. Throws if tampered or malformed. */
  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format');
    }
    const [ivB64, tagB64, dataB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

/**
 * Generates a fresh 32-byte encryption key as a 64-char hex string.
 * Useful for `ion-drive` setup output and tests.
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('hex');
}
