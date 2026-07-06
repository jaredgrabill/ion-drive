/**
 * Test-environment type augmentation — registers @testing-library/jest-dom's
 * matchers (toBeInTheDocument, toHaveClass, …) and vitest-axe's
 * `toHaveNoViolations` on Vitest's assertion types. The runtime side is
 * wired in vitest.setup.ts.
 */

import '@testing-library/jest-dom/vitest';

import type { AxeMatchers } from 'vitest-axe/matchers';

declare module 'vitest' {
  // vitest-axe 0.1.0 ships augmentations only for the legacy `Vi` namespace
  // (Vitest 0.x), so we merge its matchers into Vitest 3's Matchers here.
  // biome-ignore lint/suspicious/noExplicitAny: must mirror Vitest's own `Matchers<T = any>` declaration for interface merging
  interface Matchers<T = any> extends AxeMatchers {}
}
