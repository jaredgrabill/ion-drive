/**
 * useDebounce — returns a debounced copy of the input value.
 *
 * Updates the returned value only after `delay` ms of inactivity on the
 * input. Useful for search inputs where we want to avoid firing API calls
 * on every keystroke.
 */

import { useEffect, useState } from 'react';

/**
 * @param value - The rapidly-changing input value.
 * @param delay - Debounce delay in milliseconds (default 300).
 * @returns The debounced value.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
