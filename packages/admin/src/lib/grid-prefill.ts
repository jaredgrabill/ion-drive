/**
 * Grid search prefill — one-shot handoff of a search term into a DataGrid.
 *
 * The command palette's global record search navigates to an object's page
 * and wants that grid to open with the search term already applied (so the
 * selected record is visible). Following the `CREATE_OBJECT_FLAG` pattern,
 * the handoff is a sessionStorage flag: the palette writes `{object, term}`
 * before navigating, and the next DataGrid to mount consumes it — the term
 * is returned only when the object matches, and the flag is always cleared
 * so a stale prefill never fires later.
 */

const KEY = 'ion-grid-prefill-search';

/** Stores a one-shot search term for the given object's grid. */
export function setGridSearchPrefill(object: string, term: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ object, term }));
  } catch {
    // Storage unavailable (private mode/quota) — the prefill is best-effort.
  }
}

/** Reads and clears the prefill; returns the term when it targets `object`. */
export function consumeGridSearchPrefill(object: string): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    if (raw !== null) sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { object: target, term } = parsed as { object?: unknown; term?: unknown };
    return target === object && typeof term === 'string' ? term : null;
  } catch {
    return null;
  }
}
