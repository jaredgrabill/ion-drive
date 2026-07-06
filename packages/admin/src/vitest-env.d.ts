/**
 * Test-environment type augmentation — registers @testing-library/jest-dom's
 * matchers (toBeInTheDocument, toHaveClass, …) on Vitest's Assertion type.
 * The runtime side is wired in vitest.setup.ts.
 */

import '@testing-library/jest-dom/vitest';
