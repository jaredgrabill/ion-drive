/**
 * Unit tests for the spec-04 integrity + trust-tier layer: digest vectors
 * (known sha256s), the hard-fail digest/size gates and their documented
 * messages, `normalizeRepo` variants, `packBytes` determinism (a local digest
 * must equal the published artifact's), the `computeTier` decision table run
 * exhaustively on fake attestation outcomes, and the badges.
 */

import { describe, expect, it } from 'vitest';
import type { AttestationOutcome } from './sigstore-adapter.js';
import {
  GITHUB_ACTIONS_ISSUER,
  IntegrityError,
  checkSize,
  computeDigest,
  computeTier,
  normalizeRepo,
  packBytes,
  tierBadge,
  verifyDigest,
} from './verify.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('computeDigest', () => {
  it('matches known sha256 vectors', () => {
    // sha256("") and sha256("abc") — the classic FIPS 180-2 vectors.
    expect(computeDigest(bytes(''))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(computeDigest(bytes('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('verifyDigest / checkSize (the hard gates)', () => {
  const url = 'https://reg.test/crm/dist/0.2.0/block.json';

  it('passes silently on a match', () => {
    const b = bytes('{"name":"crm"}');
    expect(() => verifyDigest(b, computeDigest(b), url)).not.toThrow();
    expect(() => checkSize(b, b.byteLength, url)).not.toThrow();
    expect(() => checkSize(b, undefined, url)).not.toThrow(); // size optional
  });

  it('throws IntegrityError with the documented message on mismatch (AC1)', () => {
    const b = bytes('{"name":"crm"}');
    const err = (() => {
      try {
        verifyDigest(b, `sha256:${'0'.repeat(64)}`, url);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(IntegrityError);
    expect(err?.message).toContain(`expected: sha256:${'0'.repeat(64)}`);
    expect(err?.message).toContain(`actual:   ${computeDigest(b)}`);
    expect(err?.message).toContain(url);
    expect(err?.message).toContain(
      'The registry or artifact host may be compromised, or the publisher mutated a released version',
    );
  });

  it('size mismatch is the same hard failure', () => {
    expect(() => checkSize(bytes('abcd'), 3, url)).toThrow(IntegrityError);
  });
});

describe('normalizeRepo', () => {
  it.each([
    ['https://github.com/Owner/Repo', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['http://github.com/owner/repo/', 'owner/repo'],
    ['github.com/owner/repo', 'owner/repo'],
    ['owner/repo', 'owner/repo'],
    ['jaredgrabill/ion-drive-blocks', 'jaredgrabill/ion-drive-blocks'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRepo(input)).toBe(expected);
  });

  it.each(['https://gitlab.com/owner/repo', 'not a repo', '', 'owner/repo/extra'])(
    'rejects %s',
    (input) => {
      expect(normalizeRepo(input)).toBeNull();
    },
  );

  it('returns null for undefined', () => {
    expect(normalizeRepo(undefined)).toBeNull();
  });
});

describe('packBytes', () => {
  it('is deterministic and matches the pack file format (pretty JSON + newline)', () => {
    const manifest = { name: 'crm', version: '0.2.0', code: [] };
    const a = packBytes(manifest);
    const b = packBytes(manifest);
    expect(computeDigest(a)).toBe(computeDigest(b));
    expect(new TextDecoder().decode(a)).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });
});

// --- computeTier decision table (spec-04 §3, AC2) --------------------------------

const DIGEST = `sha256:${'a'.repeat(64)}`;
const HEX = 'a'.repeat(64);
const OFFICIAL = 'jaredgrabill/ion-drive-blocks';

function verifiedOutcome(
  overrides: Partial<{
    subjectDigests: string[];
    issuer?: string;
    sourceRepository?: string;
  }> = {},
): AttestationOutcome {
  return {
    kind: 'verified',
    facts: {
      subjectDigests: [HEX],
      issuer: GITHUB_ACTIONS_ISSUER,
      sourceRepository: 'https://github.com/acme/blocks',
      ...overrides,
    },
  };
}

describe('computeTier decision table', () => {
  it('no attestation → community/absent', () => {
    expect(computeTier({ computedDigest: DIGEST })).toEqual({
      tier: 'community',
      attestationStatus: 'absent',
    });
  });

  it('unavailable outcome → community/unavailable with the reason (AC7)', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      attestation: { kind: 'unavailable', reason: 'offline' },
    });
    expect(result).toEqual({
      tier: 'community',
      attestationStatus: 'unavailable',
      reason: 'offline',
    });
  });

  it('invalid outcome → community/invalid with the reason', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      attestation: { kind: 'invalid', reason: 'bad signature' },
    });
    expect(result.tier).toBe('community');
    expect(result.attestationStatus).toBe('invalid');
  });

  it('verified + repo match → verified/ok', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      repository: 'https://github.com/acme/blocks',
      attestation: verifiedOutcome(),
    });
    expect(result).toEqual({ tier: 'verified', attestationStatus: 'ok' });
  });

  it('verified from the official repo constant → official', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      repository: `https://github.com/${OFFICIAL}`,
      attestation: verifiedOutcome({ sourceRepository: `https://github.com/${OFFICIAL}` }),
    });
    expect(result.tier).toBe('official');
  });

  it('officialRepos is overridable (tests/forks)', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      repository: 'https://github.com/acme/blocks',
      attestation: verifiedOutcome(),
      officialRepos: ['acme/blocks'],
    });
    expect(result.tier).toBe('official');
  });

  it('subject digest must equal the digest WE computed — not any registry claim (AC3)', () => {
    const result = computeTier({
      computedDigest: `sha256:${'b'.repeat(64)}`, // artifact bytes differ from subject
      repository: 'https://github.com/acme/blocks',
      attestation: verifiedOutcome(),
    });
    expect(result.tier).toBe('community');
    expect(result.attestationStatus).toBe('invalid');
    expect(result.reason).toContain('subject digest');
  });

  it('wrong OIDC issuer → invalid', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      repository: 'https://github.com/acme/blocks',
      attestation: verifiedOutcome({ issuer: 'https://accounts.google.com' }),
    });
    expect(result.attestationStatus).toBe('invalid');
    expect(result.reason).toContain('issuer');
  });

  it('repository claim mismatch → invalid', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      repository: 'https://github.com/acme/blocks',
      attestation: verifiedOutcome({ sourceRepository: 'https://github.com/evil/blocks' }),
    });
    expect(result.attestationStatus).toBe('invalid');
    expect(result.reason).toContain('source repository');
  });

  it('no registry repository field → cannot verify (rule 4)', () => {
    const result = computeTier({ computedDigest: DIGEST, attestation: verifiedOutcome() });
    expect(result.tier).toBe('community');
    expect(result.reason).toContain('no repository field');
  });

  it('repo matching normalizes case, .git, and bare owner/repo forms', () => {
    const result = computeTier({
      computedDigest: DIGEST,
      repository: 'ACME/Blocks',
      attestation: verifiedOutcome({ sourceRepository: 'https://github.com/acme/blocks.git' }),
    });
    expect(result.tier).toBe('verified');
  });
});

describe('tierBadge', () => {
  it('renders the three badges from the spec table', () => {
    expect(tierBadge('official')).toBe('◆ official');
    expect(tierBadge('verified', 'https://github.com/acme/blocks')).toBe(
      '✔ verified · github.com/acme/blocks',
    );
    expect(tierBadge('community')).toBe('○ community (unattested)');
  });
});
