/**
 * Skeleton — shimmer loading placeholder.
 *
 * Renders a muted block with an animated shimmer sweep (`animate-shimmer`
 * from the design tokens; disabled under `prefers-reduced-motion`). Size the
 * skeleton to match the final content's dimensions so there is zero layout
 * shift when real data arrives.
 *
 * @example
 * ```tsx
 * <Skeleton className="h-9 w-full" />
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface SkeletonProps extends ComponentPropsWithoutRef<'div'> {}

// --- Component -------------------------------------------------------

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        'animate-shimmer rounded-md bg-muted bg-[linear-gradient(110deg,transparent_40%,hsl(var(--foreground)/0.06)_50%,transparent_60%)] bg-[length:200%_100%]',
        className,
      )}
      {...props}
    />
  ),
);
Skeleton.displayName = 'Skeleton';
