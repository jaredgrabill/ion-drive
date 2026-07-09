/**
 * Broken fixture block — its manifest declares a `ping` action, but setup
 * deliberately registers nothing, so install must fail with the installer's
 * actionable "vendor its code" error (spec-06 AC2).
 */
import { definePlugin } from '@ion-drive/core';

export default definePlugin({
  name: 'broken',
  setup() {
    /* registers no handlers — that is the point */
  },
});
