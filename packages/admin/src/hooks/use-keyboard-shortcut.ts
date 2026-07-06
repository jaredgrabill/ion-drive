/**
 * useKeyboardShortcut — registers a global key combo (⌘K / Ctrl+K, Escape…).
 *
 * Listens on `window` for the given key with optional modifiers and invokes
 * the handler, calling `preventDefault()` so the browser default (e.g. the
 * browser's own Ctrl+K) is suppressed. `meta: true` matches Cmd on macOS
 * *or* Ctrl elsewhere, which is what "⌘K" means in practice for a web app.
 * Shortcuts fired while typing in an input/textarea are ignored unless
 * `allowInInputs` is set (Escape usually wants it).
 */

import { useEffect } from 'react';

export interface KeyboardShortcutOptions {
  /** Match Cmd (mac) or Ctrl (elsewhere). */
  meta?: boolean;
  /** Match the Shift modifier. */
  shift?: boolean;
  /** Fire even when focus is inside an input/textarea/select. */
  allowInInputs?: boolean;
  /** Disable the shortcut without unmounting. */
  enabled?: boolean;
}

/**
 * @param key - `KeyboardEvent.key`, case-insensitive (e.g. "k", "Escape").
 * @param handler - Called when the combo matches.
 * @param options - Modifier requirements and input behavior.
 */
export function useKeyboardShortcut(
  key: string,
  handler: (event: KeyboardEvent) => void,
  options: KeyboardShortcutOptions = {},
): void {
  const { meta = false, shift = false, allowInInputs = false, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (meta && !(event.metaKey || event.ctrlKey)) return;
      if (!meta && (event.metaKey || event.ctrlKey)) return;
      if (shift !== event.shiftKey) return;
      if (!allowInInputs) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable)
          return;
      }
      event.preventDefault();
      handler(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, handler, meta, shift, allowInInputs, enabled]);
}
