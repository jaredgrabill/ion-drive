/**
 * Grid store — per-object grid preferences (zustand + localStorage persist).
 *
 * Holds column visibility and column widths keyed by object name, so each
 * object's grid remembers its layout across sessions. Ephemeral grid state
 * (selection, focus, edit) stays in the DataGrid component — only layout
 * preferences belong here.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// --- Types -----------------------------------------------------------

export interface ObjectGridPrefs {
  /** Field names hidden from the grid. */
  hidden: string[];
  /** Column widths (px) keyed by field name. */
  widths: Record<string, number>;
}

interface GridStoreState {
  prefs: Record<string, ObjectGridPrefs>;
  setHidden: (object: string, hidden: string[]) => void;
  setWidth: (object: string, field: string, width: number) => void;
}

const EMPTY_PREFS: ObjectGridPrefs = { hidden: [], widths: {} };

// --- Store -----------------------------------------------------------

export const useGridStore = create<GridStoreState>()(
  persist(
    (set) => ({
      prefs: {},
      setHidden: (object, hidden) =>
        set((state) => ({
          prefs: {
            ...state.prefs,
            [object]: { ...(state.prefs[object] ?? EMPTY_PREFS), hidden },
          },
        })),
      setWidth: (object, field, width) =>
        set((state) => {
          const current = state.prefs[object] ?? EMPTY_PREFS;
          return {
            prefs: {
              ...state.prefs,
              [object]: { ...current, widths: { ...current.widths, [field]: width } },
            },
          };
        }),
    }),
    { name: 'ion-grid-prefs' },
  ),
);

/** Selects one object's prefs (with defaults) from the store. */
export function useObjectGridPrefs(object: string): ObjectGridPrefs {
  return useGridStore((state) => state.prefs[object]) ?? EMPTY_PREFS;
}
