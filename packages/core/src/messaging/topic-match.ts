/**
 * Topic pattern matching for subscriptions.
 *
 * Topics are dotted paths (`data.contacts.created`). Patterns follow the widely
 * understood AMQP topic-exchange convention:
 *  - a literal segment matches that exact segment,
 *  - `*` matches exactly one segment,
 *  - `#` matches zero or more segments.
 *
 * So `data.#` catches every data event, `data.*.created` catches creates across
 * all objects, and `data.contacts.*` catches every contacts change. See ADR-015.
 */

/** Whether `topic` matches `pattern` under the `*`/`#` convention. */
export function topicMatches(pattern: string, topic: string): boolean {
  return matchSegments(pattern.split('.'), topic.split('.'));
}

function matchSegments(pattern: string[], topic: string[]): boolean {
  if (pattern.length === 0) return topic.length === 0;

  const [head, ...rest] = pattern;

  if (head === '#') {
    // Zero segments consumed…
    if (matchSegments(rest, topic)) return true;
    // …or one-or-more (consume a topic segment, keep the '#').
    return topic.length > 0 && matchSegments(pattern, topic.slice(1));
  }

  if (topic.length === 0) return false;
  if (head === '*' || head === topic[0]) return matchSegments(rest, topic.slice(1));
  return false;
}

/**
 * Derives a SQL `LIKE` prefix from a pattern for a coarse candidate filter —
 * an optimization only; exact matching is done in JS via {@link topicMatches}.
 * Returns the literal leading segments before the first wildcard, so
 * `data.*.created` → `data.%` and an exact pattern → itself.
 */
export function topicLikePrefix(pattern: string): string {
  const segments = pattern.split('.');
  const literal: string[] = [];
  for (const segment of segments) {
    if (segment === '*' || segment === '#') break;
    literal.push(segment);
  }

  if (literal.length === 0) return '%';

  const prefix = escapeLike(literal.join('.'));
  // If the whole pattern was literal, match it exactly; otherwise match the prefix.
  return literal.length === segments.length ? prefix : `${prefix}.%`;
}

/** Escapes LIKE metacharacters so literal segments are matched literally. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
