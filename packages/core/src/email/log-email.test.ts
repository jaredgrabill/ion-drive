import { describe, expect, it } from 'vitest';
import type { LogFields, LoggerProvider } from '../logging/logger-provider.js';
import { LogEmailProvider } from './log-email.js';

/** A logger double capturing warn lines. */
function captureLogger() {
  const warns: { msg: string; fields?: LogFields }[] = [];
  const logger: LoggerProvider = {
    info: () => {},
    warn: (msg, fields) => warns.push({ msg, fields }),
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

describe('LogEmailProvider', () => {
  it('accepts the message and logs it instead of sending', async () => {
    const { logger, warns } = captureLogger();
    const provider = new LogEmailProvider(logger);

    const result = await provider.send({ to: 'a@example.com', subject: 'Hi', text: 'body' });

    expect(provider.name).toBe('log');
    expect(result.accepted).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({ to: 'a@example.com', subject: 'Hi' });
  });

  it('never throws (email seam is a no-op without a transport)', async () => {
    const { logger } = captureLogger();
    const provider = new LogEmailProvider(logger);
    await expect(provider.send({ to: [], subject: '' })).resolves.toBeDefined();
  });
});
