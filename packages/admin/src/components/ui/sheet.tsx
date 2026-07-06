/**
 * Sheet — slide-out side panel built on Radix Dialog.
 *
 * Slides in from the right (default) or left over a dimmed backdrop, with
 * focus trap and Escape-to-close from Radix. The RecordSheet and long-text
 * cell editors build on this.
 *
 * @example
 * ```tsx
 * <Sheet open={open} onClose={close} title="Edit Contact" className="w-[520px]">
 *   …fields…
 * </Sheet>
 * ```
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';

// --- Types -----------------------------------------------------------

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Heading shown in the sheet header. */
  title: ReactNode;
  /** Optional supporting line under the title. */
  description?: ReactNode;
  /** Edge the panel slides from. */
  side?: 'right' | 'left';
  children?: ReactNode;
  /** Sticky footer actions. */
  footer?: ReactNode;
  /** Width classes for the panel (default `w-full max-w-[520px]`). */
  className?: string;
}

// --- Component -------------------------------------------------------

export function Sheet({
  open,
  onClose,
  title,
  description,
  side = 'right',
  children,
  footer,
  className,
}: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 z-50 flex w-full max-w-[520px] flex-col border-border bg-card shadow-lg focus:outline-none',
            side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
            'data-[state=open]:animate-slide-up',
            className,
          )}
        >
          <div className="flex items-start justify-between border-b border-border p-4">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogPrimitive.Title className="text-lg font-semibold leading-none">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description
                className={description ? 'text-sm text-muted-foreground' : 'sr-only'}
              >
                {description ?? 'Panel'}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close panel">
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
          {footer && (
            <div className="flex items-center gap-2 border-t border-border p-4">{footer}</div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
Sheet.displayName = 'Sheet';
