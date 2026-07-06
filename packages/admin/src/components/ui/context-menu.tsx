/**
 * ContextMenu — right-click menu built on Radix ContextMenu.
 *
 * Used by the DataGrid column headers (Sort A→Z, Hide column, …). Styling
 * mirrors DropdownMenu so the two menu types are visually identical.
 *
 * @example
 * ```tsx
 * <ContextMenu>
 *   <ContextMenuTrigger asChild><th>…</th></ContextMenuTrigger>
 *   <ContextMenuContent>
 *     <ContextMenuItem onSelect={sortAsc}>Sort A→Z</ContextMenuItem>
 *   </ContextMenuContent>
 * </ContextMenu>
 * ```
 */

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Components ------------------------------------------------------

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export const ContextMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        'z-50 min-w-[10rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md animate-fade-in',
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = 'ContextMenuContent';

export interface ContextMenuItemProps
  extends ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> {
  /** Renders the item in the destructive color. */
  destructive?: boolean;
}

export const ContextMenuItem = forwardRef<HTMLDivElement, ContextMenuItemProps>(
  ({ className, destructive = false, ...props }, ref) => (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
        destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive',
        className,
      )}
      {...props}
    />
  ),
);
ContextMenuItem.displayName = 'ContextMenuItem';

export const ContextMenuSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = 'ContextMenuSeparator';
