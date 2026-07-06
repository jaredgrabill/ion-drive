/**
 * EmptyState — dashed placeholder for empty lists and zero states.
 *
 * Optional icon slot above the title and action slot (usually a Button)
 * below the hint. Announced to screen readers via `role="status"` so an
 * empty result set is not silent.
 *
 * @example
 * ```tsx
 * <EmptyState
 *   icon={<Database className="h-8 w-8" />}
 *   title="No data objects yet"
 *   hint="Create your first object to get going."
 *   action={<Button>New Object</Button>}
 * />
 * ```
 */

import { type ComponentPropsWithoutRef, type ReactNode, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface EmptyStateProps extends ComponentPropsWithoutRef<'div'> {
  /** Headline describing the empty state. */
  title: string;
  /** Secondary line suggesting what to do next. */
  hint?: string;
  /** Icon rendered above the title (usually a lucide icon). */
  icon?: ReactNode;
  /** Call-to-action rendered below the hint (usually a Button). */
  action?: ReactNode;
}

// --- Component -------------------------------------------------------

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ className, title, hint, icon, action, ...props }, ref) => (
    <div
      ref={ref}
      aria-live="polite"
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-10 text-center',
        className,
      )}
      {...props}
    >
      {icon && <div className="mb-2 text-muted-foreground/60">{icon}</div>}
      <p className="font-medium">{title}</p>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  ),
);
EmptyState.displayName = 'EmptyState';
