/**
 * Dialog + AlertDialog tests — open/close, Escape handling, confirm flow,
 * and the type-to-confirm gate.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AlertDialog, Dialog } from './dialog';

describe('Dialog', () => {
  it('renders title and children when open', () => {
    render(
      <Dialog open onClose={() => {}} title="Edit Contact">
        <p>Body content</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit Contact' })).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Hidden">
        <p>Nope</p>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Escapable">
        <p>Body</p>
      </Dialog>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AlertDialog', () => {
  it('runs onConfirm then closes', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <AlertDialog
        open
        onClose={onClose}
        title="Delete record"
        description="This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('gates confirm behind type-to-confirm text', async () => {
    const onConfirm = vi.fn();
    render(
      <AlertDialog
        open
        onClose={() => {}}
        title="Delete object"
        description="Everything is lost."
        confirmLabel="Delete"
        requireText="contacts"
        onConfirm={onConfirm}
      />,
    );
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    expect(confirmButton).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), 'contacts');
    expect(confirmButton).toBeEnabled();
  });
});
