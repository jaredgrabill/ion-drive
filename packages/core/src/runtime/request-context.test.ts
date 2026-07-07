import { describe, expect, it } from 'vitest';
import { currentActor, currentActorId, runWithActor } from './request-context.js';

describe('request context (ambient actor)', () => {
  it('resolves to null outside any actor scope', () => {
    expect(currentActor()).toBeNull();
    expect(currentActorId()).toBeNull();
  });

  it('exposes the actor inside runWithActor, including across awaits', async () => {
    await runWithActor({ userId: 'u1', apiKeyId: null, via: 'session' }, async () => {
      expect(currentActor()?.userId).toBe('u1');
      await Promise.resolve();
      expect(currentActorId()).toBe('u1');
    });
    expect(currentActor()).toBeNull();
  });

  it('prefers userId over apiKeyId for the opaque actor id', () => {
    runWithActor({ userId: 'u1', apiKeyId: 'k1', via: 'api_key' }, () => {
      expect(currentActorId()).toBe('u1');
    });
    runWithActor({ userId: null, apiKeyId: 'k1', via: 'api_key' }, () => {
      expect(currentActorId()).toBe('k1');
    });
  });

  it('nests: an inner scope shadows and restores the outer actor', () => {
    runWithActor({ userId: 'outer', apiKeyId: null, via: 'session' }, () => {
      runWithActor(null, () => {
        expect(currentActor()).toBeNull();
      });
      expect(currentActorId()).toBe('outer');
    });
  });
});
