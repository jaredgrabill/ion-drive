import { describe, expect, it } from 'vitest';
import { Encryptor, generateEncryptionKey } from './encryption.js';

describe('Encryptor', () => {
  const key = generateEncryptionKey();

  it('round-trips a plaintext value', () => {
    const enc = new Encryptor(key);
    const secret = 'sk_live_supersecret_value_123';
    const cipher = enc.encrypt(secret);
    expect(cipher).not.toContain(secret);
    expect(enc.decrypt(cipher)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const enc = new Encryptor(key);
    expect(enc.encrypt('same')).not.toBe(enc.encrypt('same'));
  });

  it('fails to decrypt tampered ciphertext', () => {
    const enc = new Encryptor(key);
    const cipher = enc.encrypt('value');
    const [iv, tag, data] = cipher.split('.');
    // Tampered ciphertext body fails the GCM auth check.
    expect(() => enc.decrypt(`${iv}.${tag}.${Buffer.from('evil').toString('base64')}`)).toThrow();
    // Tampered auth tag fails verification.
    expect(() =>
      enc.decrypt(`${iv}.${Buffer.from('badtagbadtagbadd').toString('base64')}.${data}`),
    ).toThrow();
    // Malformed (wrong number of parts).
    expect(() => enc.decrypt('only.two')).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const cipher = new Encryptor(key).encrypt('value');
    expect(() => new Encryptor(generateEncryptionKey()).decrypt(cipher)).toThrow();
  });

  it('accepts a non-hex passphrase (stretched via scrypt)', () => {
    const enc = new Encryptor('a-human-friendly-passphrase');
    expect(enc.decrypt(enc.encrypt('hello'))).toBe('hello');
  });
});
