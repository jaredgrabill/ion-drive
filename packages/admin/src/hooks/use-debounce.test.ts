/**
 * useDebounce / useLocalStorage tests — timing behavior and persistence.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebounce } from './use-debounce';
import { useLocalStorage } from './use-local-storage';

describe('useDebounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('a', 300));
    expect(result.current).toBe('a');
  });

  it('only updates after the delay elapses', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('b');
  });

  it('restarts the timer on rapid changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: 'c' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('c');
  });
});

describe('useLocalStorage', () => {
  it('falls back to the initial value', () => {
    const { result } = renderHook(() => useLocalStorage('k', 'default'));
    expect(result.current[0]).toBe('default');
  });

  it('persists updates as JSON', () => {
    const { result } = renderHook(() => useLocalStorage('k', 0));
    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);
    expect(window.localStorage.getItem('k')).toBe('5');
  });

  it('reads back a previously stored value', () => {
    window.localStorage.setItem('k', JSON.stringify({ nested: true }));
    const { result } = renderHook(() => useLocalStorage('k', {}));
    expect(result.current[0]).toEqual({ nested: true });
  });

  it('supports functional updates', () => {
    const { result } = renderHook(() => useLocalStorage('k', 1));
    act(() => result.current[1]((prev) => prev + 1));
    expect(result.current[0]).toBe(2);
  });
});
