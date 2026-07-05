import { describe, expect, it } from 'vitest';
import { topicLikePrefix, topicMatches } from './topic-match.js';

describe('topicMatches', () => {
  it('matches exact topics', () => {
    expect(topicMatches('data.contacts.created', 'data.contacts.created')).toBe(true);
    expect(topicMatches('data.contacts.created', 'data.contacts.updated')).toBe(false);
  });

  it('* matches exactly one segment', () => {
    expect(topicMatches('data.*.created', 'data.contacts.created')).toBe(true);
    expect(topicMatches('data.*.created', 'data.invoices.created')).toBe(true);
    expect(topicMatches('data.*.created', 'data.contacts.updated')).toBe(false);
    // '*' does not span multiple segments
    expect(topicMatches('data.*', 'data.contacts.created')).toBe(false);
  });

  it('# matches zero or more segments', () => {
    expect(topicMatches('data.#', 'data.contacts.created')).toBe(true);
    expect(topicMatches('data.#', 'data.contacts')).toBe(true);
    expect(topicMatches('data.#', 'data')).toBe(true);
    expect(topicMatches('data.#', 'tasks.run')).toBe(false);
    expect(topicMatches('#', 'anything.at.all')).toBe(true);
  });

  it('combines wildcards', () => {
    expect(topicMatches('data.#.created', 'data.a.b.created')).toBe(true);
    expect(topicMatches('data.#.created', 'data.created')).toBe(true);
  });
});

describe('topicLikePrefix', () => {
  it('returns the literal prefix before the first wildcard', () => {
    expect(topicLikePrefix('data.#')).toBe('data.%');
    expect(topicLikePrefix('data.*.created')).toBe('data.%');
    expect(topicLikePrefix('#')).toBe('%');
    expect(topicLikePrefix('*.created')).toBe('%');
  });

  it('matches an all-literal pattern exactly', () => {
    expect(topicLikePrefix('data.contacts.created')).toBe('data.contacts.created');
  });
});
