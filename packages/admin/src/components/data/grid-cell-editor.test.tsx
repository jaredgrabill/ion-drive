/**
 * GridCellEditor tests — value coercion round-trips and editor rendering
 * per cell kind.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FieldDefinition } from '../../lib/types';
import { GridCellEditor, coerceValue, editValueOf } from './grid-cell-editor';

function field(columnType: string): FieldDefinition {
  return {
    name: 'f',
    displayName: 'Field',
    columnName: 'f',
    columnType,
  };
}

describe('coerceValue', () => {
  it('returns null for empty strings', () => {
    expect(coerceValue('text', '')).toBeNull();
    expect(coerceValue('number', '')).toBeNull();
  });

  it('coerces booleans and numbers', () => {
    expect(coerceValue('boolean', 'true')).toBe(true);
    expect(coerceValue('boolean', 'false')).toBe(false);
    expect(coerceValue('number', '42')).toBe(42);
    expect(coerceValue('currency', '19.99')).toBe(19.99);
  });

  it('parses JSON, falling back to the raw string', () => {
    expect(coerceValue('json', '{"a":1}')).toEqual({ a: 1 });
    expect(coerceValue('json', 'not json')).toBe('not json');
  });

  it('keeps text as-is', () => {
    expect(coerceValue('text', 'hello')).toBe('hello');
  });
});

describe('editValueOf', () => {
  it('stringifies stored values for editing', () => {
    expect(editValueOf(null)).toBe('');
    expect(editValueOf(42)).toBe('42');
    expect(editValueOf({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('GridCellEditor', () => {
  it('renders a text input for text fields', () => {
    render(<GridCellEditor field={field('text')} value="abc" onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveValue('abc');
  });

  it('renders a number input for numeric fields', () => {
    render(<GridCellEditor field={field('integer')} value="5" onChange={() => {}} />);
    expect(screen.getByRole('spinbutton')).toHaveValue(5);
  });

  it('renders a checkbox for booleans', () => {
    render(<GridCellEditor field={field('boolean')} value="true" onChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('renders a textarea for json with mono styling', () => {
    render(<GridCellEditor field={field('json')} value="{}" onChange={() => {}} />);
    expect(screen.getByRole('textbox').className).toContain('font-mono');
  });

  it('renders five star toggle buttons for ratings', () => {
    const onChange = vi.fn();
    render(<GridCellEditor field={field('rating')} value="3" onChange={onChange} />);
    const stars = screen.getAllByRole('button');
    expect(stars).toHaveLength(5);
    // aria-pressed reflects the current 3-star value.
    expect(stars.filter((s) => s.getAttribute('aria-pressed') === 'true')).toHaveLength(3);
  });
});
