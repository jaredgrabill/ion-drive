/**
 * StatusDot tests — status classes and screen-reader text (color is never
 * the only signal).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusDot } from './status-dot';

describe('StatusDot', () => {
  it('exposes the status as screen-reader text', () => {
    render(<StatusDot status="healthy" />);
    expect(screen.getByText('healthy')).toHaveClass('sr-only');
  });

  it('uses a custom label when provided', () => {
    render(<StatusDot status="error" label="System Error" />);
    expect(screen.getByText('System Error')).toBeInTheDocument();
  });

  it('applies the matching status color class', () => {
    const { container } = render(<StatusDot status="warning" />);
    expect(container.querySelector('.bg-status-warning')).not.toBeNull();
  });

  it('adds pulse animation only when asked', () => {
    const { container, rerender } = render(<StatusDot status="healthy" />);
    expect(container.querySelector('.animate-pulse-glow')).toBeNull();
    rerender(<StatusDot status="healthy" pulse />);
    expect(container.querySelector('.animate-pulse-glow')).not.toBeNull();
  });
});
