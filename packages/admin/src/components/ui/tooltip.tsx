/**
 * Tooltip — delay-show info hint built on Radix Tooltip.
 *
 * `TooltipProvider` must wrap the app once (done in App.tsx) so all tooltips
 * share the skip-delay behavior. `SimpleTooltip` is the convenience wrapper
 * used for icon-only buttons and collapsed sidebar items.
 *
 * @example
 * ```tsx
 * <SimpleTooltip label="Refresh">
 *   <Button size="icon" aria-label="Refresh"><RotateCw /></Button>
 * </SimpleTooltip>
 * ```
 */

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ComponentPropsWithoutRef, type ReactNode, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Components ------------------------------------------------------

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground shadow-md animate-fade-in',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';

export interface SimpleTooltipProps {
  /** Tooltip text. */
  label: ReactNode;
  /** Placement side (default top). */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** The trigger element (rendered via `asChild`). */
  children: ReactNode;
}

/** One-liner tooltip for icon buttons: wraps trigger + content. */
export function SimpleTooltip({ label, side = 'top', children }: SimpleTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
SimpleTooltip.displayName = 'SimpleTooltip';
