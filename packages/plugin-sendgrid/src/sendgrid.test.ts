/**
 * Unit tests for the SendGrid provider and plugin: payload mapping, error
 * surfacing, default-from behavior, and the registry swap. `fetch` is stubbed —
 * nothing touches the network.
 */

import {
  CACHE_SERVICE,
  EMAIL_SERVICE,
  type LoggerProvider,
  type PluginContext,
  ServiceRegistry,
} from '@ion-drive/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendgridPlugin } from './index.js';
import { SendGridEmailProvider } from './sendgrid-provider.js';

const noopLogger: LoggerProvider = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function stubFetch(status = 202, body = '', headers: Record<string, string> = {}) {
  const mock = vi.fn(async () => new Response(body, { status, headers }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function lastRequest(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = mock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SendGridEmailProvider', () => {
  const provider = () =>
    new SendGridEmailProvider({
      apiKey: 'SG.test',
      from: 'default@acme.io',
      apiBase: 'https://sg.local',
    });

  it('maps the message onto the v3 mail/send payload', async () => {
    const mock = stubFetch(202, '', { 'x-message-id': 'msg-1' });
    const result = await provider().send({
      to: ['a@x.io', 'b@x.io'],
      cc: 'c@x.io',
      subject: 'Hi',
      text: 'plain',
      html: '<b>rich</b>',
      replyTo: 'reply@x.io',
    });

    expect(result).toEqual({ accepted: true, messageId: 'msg-1' });
    const { url, init } = lastRequest(mock);
    expect(url).toBe('https://sg.local/v3/mail/send');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer SG.test');

    const payload = JSON.parse(init.body as string);
    expect(payload.personalizations).toEqual([
      { to: [{ email: 'a@x.io' }, { email: 'b@x.io' }], cc: [{ email: 'c@x.io' }] },
    ]);
    expect(payload.from).toEqual({ email: 'default@acme.io' });
    expect(payload.reply_to).toEqual({ email: 'reply@x.io' });
    // SendGrid requires text/plain before text/html.
    expect(payload.content).toEqual([
      { type: 'text/plain', value: 'plain' },
      { type: 'text/html', value: '<b>rich</b>' },
    ]);
  });

  it('prefers the message from over the default', async () => {
    const mock = stubFetch();
    await provider().send({ to: 'a@x.io', from: 'me@x.io', subject: 's', text: 't' });
    expect(JSON.parse(lastRequest(mock).init.body as string).from).toEqual({ email: 'me@x.io' });
  });

  it('rejects a message with neither sender nor body', async () => {
    stubFetch();
    const bare = new SendGridEmailProvider({ apiKey: 'SG.test' });
    await expect(bare.send({ to: 'a@x.io', subject: 's', text: 't' })).rejects.toThrow(/no sender/);
    await expect(provider().send({ to: 'a@x.io', subject: 's' })).rejects.toThrow(/text.*html/);
  });

  it('surfaces SendGrid error details on failure', async () => {
    stubFetch(401, JSON.stringify({ errors: [{ message: 'bad key' }, { message: 'nope' }] }));
    await expect(provider().send({ to: 'a@x.io', subject: 's', text: 't' })).rejects.toThrow(
      /HTTP 401.*bad key; nope/,
    );
  });
});

describe('sendgridPlugin', () => {
  function contextWith(registry: ServiceRegistry): PluginContext {
    return {
      registry,
      config: {} as PluginContext['config'],
      logger: noopLogger,
      bus: {} as PluginContext['bus'],
      actions: {} as PluginContext['actions'],
    };
  }

  it('swaps EMAIL_SERVICE for the SendGrid provider', async () => {
    const registry = new ServiceRegistry();
    await sendgridPlugin({ apiKey: 'SG.k' }).setup(contextWith(registry));
    const provider = registry.require(EMAIL_SERVICE);
    expect(provider.name).toBe('sendgrid');
    expect(registry.has(CACHE_SERVICE)).toBe(false); // touches nothing else
  });

  it('fails setup with a clear message when no API key is available', async () => {
    vi.stubEnv('SENDGRID_API_KEY', '');
    vi.stubEnv('ION_SENDGRID_API_KEY', '');
    const registry = new ServiceRegistry();
    await expect(async () => sendgridPlugin().setup(contextWith(registry))).rejects.toThrow(
      /SENDGRID_API_KEY/,
    );
  });
});
