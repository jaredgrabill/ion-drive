/**
 * Vitest setup — registers Testing Library's jest-dom matchers plus
 * vitest-axe's `toHaveNoViolations`, and cleans up the DOM between tests.
 * jsdom lacks a few browser APIs Radix relies on (ResizeObserver, matchMedia,
 * scrollIntoView, PointerEvent capture), so minimal polyfills are installed
 * here. The matching type augmentations live in src/vitest-env.d.ts.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// vitest-axe 0.1.0's bundled `extend-expect` entry targets the legacy `Vi`
// global namespace (Vitest 0.x), so we extend manually per its README.
expect.extend(axeMatchers);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// --- jsdom polyfills for Radix ----------------------------------------

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub });
}

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
