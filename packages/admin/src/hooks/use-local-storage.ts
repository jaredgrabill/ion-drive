/**
 * useLocalStorage — type-safe persistent state backed by localStorage.
 *
 * Reads the initial value lazily (JSON-parsed), writes on every change, and
 * degrades gracefully when storage is unavailable (private browsing, quota).
 * Values must be JSON-serializable.
 */

import { useCallback, useState } from 'react';

/**
 * @param key - The localStorage key.
 * @param initialValue - Fallback when the key is absent or unreadable.
 * @returns `[value, setValue]` — same contract as `useState`.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [stored, setStored] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initialValue : (JSON.parse(raw) as T);
    } catch {
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStored((prev) => {
        const next = value instanceof Function ? value(prev) : value;
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Storage full or unavailable — state still updates in-memory.
        }
        return next;
      });
    },
    [key],
  );

  return [stored, setValue];
}
