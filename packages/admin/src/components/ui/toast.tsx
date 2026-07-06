/**
 * Toast — notification stack, a thin wrapper around `sonner`.
 *
 * `Toaster` mounts once in App.tsx (bottom-right, theme-aware via the
 * document's `.dark` class). All feedback for CRUD mutations goes through
 * `toast.success/error/…` instead of `alert()` or inline error text.
 *
 * @example
 * ```tsx
 * toast.success('Record updated');
 * toast.error(`Failed to save: ${message}`);
 * ```
 */

import { Toaster as SonnerToaster, toast } from 'sonner';

// --- Component -------------------------------------------------------

/** App-level toast outlet. Mount exactly once, near the root. */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group rounded-lg border border-border bg-popover text-popover-foreground shadow-lg',
          title: 'text-sm font-medium',
          description: 'text-xs text-muted-foreground',
        },
      }}
    />
  );
}
Toaster.displayName = 'Toaster';

export { toast };
