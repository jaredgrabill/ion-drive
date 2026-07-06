/**
 * Dialog + AlertDialog — modal dialogs built on Radix Dialog.
 *
 * `Dialog` keeps the pre-Phase-8 controlled API (`open`, `onClose`, `title`,
 * `footer`) so existing call sites are unchanged, but gains Radix's focus
 * trap, Escape handling, scroll lock, and portal rendering.
 *
 * `AlertDialog` is the confirmation variant that replaces every `confirm()`
 * call: title + description + Cancel/Confirm footer. For high-stakes actions
 * pass `requireText` to demand the user type an exact string (e.g. the object
 * name) before the confirm button enables.
 *
 * @example
 * ```tsx
 * <AlertDialog
 *   open={confirming}
 *   onClose={() => setConfirming(false)}
 *   title="Delete Data Object"
 *   description="This cannot be undone."
 *   confirmLabel="Delete"
 *   confirmVariant="destructive"
 *   onConfirm={() => deleteObject.mutate()}
 * />
 * ```
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { Button, type ButtonProps } from './button';
import { Input } from './input';
import { Label } from './label';

// --- Types -----------------------------------------------------------

export interface DialogProps {
  /** Controlled open state. */
  open: boolean;
  /** Called when the user dismisses (Escape, backdrop, close button, Cancel). */
  onClose: () => void;
  /** Heading shown in the dialog header. */
  title: string;
  /** Optional supporting text under the title. */
  description?: string;
  children?: ReactNode;
  /** Right-aligned footer actions. */
  footer?: ReactNode;
  /** Extra classes for the content panel (e.g. `max-w-2xl`). */
  className?: string;
}

// --- Dialog ----------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card shadow-lg animate-slide-up focus:outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between border-b border-border p-4">
            <div className="flex flex-col gap-1">
              <DialogPrimitive.Title className="text-lg font-semibold leading-none">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                // Radix warns when a Description is absent; render an empty one.
                <DialogPrimitive.Description className="sr-only">
                  {title}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border p-4">{footer}</div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
Dialog.displayName = 'Dialog';

// --- AlertDialog -----------------------------------------------------

export interface AlertDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Explains the consequence; be specific about what is lost. */
  description: string;
  /** Confirm button label (default "Confirm"). */
  confirmLabel?: string;
  /** Confirm button variant; use `destructive` for irreversible actions. */
  confirmVariant?: ButtonProps['variant'];
  /** Called when the user confirms. The dialog closes itself afterwards. */
  onConfirm: () => void;
  /** Type-to-confirm: the exact string the user must type to enable Confirm. */
  requireText?: string;
  /** Disables the confirm button (e.g. while the mutation is pending). */
  confirmDisabled?: boolean;
  /** Extra body content (e.g. an option checkbox) above the confirm input. */
  children?: ReactNode;
}

export function AlertDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = 'Confirm',
  confirmVariant = 'default',
  onConfirm,
  requireText,
  confirmDisabled = false,
  children,
}: AlertDialogProps) {
  const [typed, setTyped] = useState('');
  // Reset the type-to-confirm input each time the dialog opens.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const blocked = confirmDisabled || (requireText !== undefined && typed !== requireText);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            disabled={blocked}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {requireText !== undefined && (
        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor="alert-confirm-text">
            Type <span className="font-mono font-semibold">{requireText}</span> to confirm
          </Label>
          <Input
            id="alert-confirm-text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
    </Dialog>
  );
}
AlertDialog.displayName = 'AlertDialog';
