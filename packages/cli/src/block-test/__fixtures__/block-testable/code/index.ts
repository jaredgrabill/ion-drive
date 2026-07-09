/**
 * Testable fixture block — vendored logic entry point. Registers the `ping`
 * action its manifest declares (the happy path of the block-test suite).
 */
import { definePlugin } from '@ion-drive/core';

export default definePlugin({
  name: 'testable',
  setup(ctx) {
    ctx.actions.registerAction({
      block: 'testable',
      name: 'ping',
      description: 'Answers { pong: true }.',
      handler: async () => ({ pong: true }),
    });
  },
});
