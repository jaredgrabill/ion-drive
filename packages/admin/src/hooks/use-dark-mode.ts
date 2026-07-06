/**
 * useDarkMode — theme state synced to `<html class="dark">` and localStorage.
 *
 * Extracted from the pre-Phase-8 AppShell. The `.dark` class drives the
 * design-token overrides in index.css (via the Tailwind `dark` variant), and
 * the choice persists under the `ion-theme` key.
 */

import { useEffect } from 'react';
import { useLocalStorage } from './use-local-storage';

/** @returns `[dark, toggle]` — current mode and a toggler. */
export function useDarkMode(): [boolean, () => void] {
  const [theme, setTheme] = useLocalStorage<'dark' | 'light'>('ion-theme', 'light');
  const dark = theme === 'dark';
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return [dark, () => setTheme(dark ? 'light' : 'dark')];
}
