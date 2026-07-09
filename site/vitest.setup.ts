/**
 * Vitest setup — Testing Library's jest-dom matchers + DOM cleanup between
 * tests (the admin console's rig pattern).
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
