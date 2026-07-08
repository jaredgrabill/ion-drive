/**
 * Unit tests for S3Storage against a fake `send()`: command construction, key
 * prefixing, missing-object mapping, list pagination, and signed URLs. No
 * network, no real SDK client.
 */

import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { STORAGE_SERVICE, ServiceRegistry, StorageError } from '@ion-drive/core';
import { describe, expect, it, vi } from 'vitest';
import { s3StoragePlugin } from './index.js';
import { type S3ClientLike, S3Storage } from './s3-storage.js';

/** A fake client scripted per command class name. */
function fakeClient(script: Record<string, (input: Record<string, unknown>) => unknown>) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client: S3ClientLike = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      const handler = script[name];
      if (!handler) throw new Error(`Unscripted command: ${name}`);
      return handler(command.input);
    },
  };
  return { client, calls };
}

const notFound = () => {
  const err = new Error('not found');
  err.name = 'NotFound';
  throw err;
};

describe('S3Storage', () => {
  it('puts a buffer with prefix and content type', async () => {
    const { client, calls } = fakeClient({ [PutObjectCommand.name]: () => ({}) });
    const storage = new S3Storage(client, { bucket: 'b', keyPrefix: 'app/' });

    const info = await storage.put('docs/a.txt', Buffer.from('hello'), {
      contentType: 'text/plain',
    });
    expect(info).toMatchObject({ key: 'docs/a.txt', size: 5, contentType: 'text/plain' });
    expect(calls[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: { Bucket: 'b', Key: 'app/docs/a.txt', ContentType: 'text/plain' },
    });
  });

  it('rejects traversal keys before any request', async () => {
    const { client, calls } = fakeClient({});
    const storage = new S3Storage(client, { bucket: 'b' });
    await expect(storage.put('../x', Buffer.from(''))).rejects.toThrow(StorageError);
    expect(calls).toHaveLength(0);
  });

  it('gets an object and maps metadata; missing → undefined', async () => {
    const body = Readable.from([Buffer.from('data')]);
    const { client } = fakeClient({
      [GetObjectCommand.name]: (input) =>
        input.Key === 'have.txt'
          ? { Body: body, ContentLength: 4, ContentType: 'text/plain' }
          : notFound(),
    });
    const storage = new S3Storage(client, { bucket: 'b' });

    const object = await storage.get('have.txt');
    expect(object?.info).toMatchObject({ key: 'have.txt', size: 4, contentType: 'text/plain' });
    expect(object?.body).toBe(body);
    expect(await storage.get('missing.txt')).toBeUndefined();
  });

  it('delete probes existence first', async () => {
    const existing = new Set(['app/x.txt']);
    const { client, calls } = fakeClient({
      [HeadObjectCommand.name]: (input) =>
        existing.has(input.Key as string) ? { ContentLength: 1 } : notFound(),
      [DeleteObjectCommand.name]: (input) => {
        existing.delete(input.Key as string);
        return {};
      },
    });
    const storage = new S3Storage(client, { bucket: 'b', keyPrefix: 'app/' });

    expect(await storage.delete('x.txt')).toBe(true);
    expect(await storage.delete('x.txt')).toBe(false);
    expect(calls.filter((c) => c.name === 'DeleteObjectCommand')).toHaveLength(1);
  });

  it('lists across pages, strips the prefix, and honors the limit', async () => {
    let page = 0;
    const { client, calls } = fakeClient({
      [ListObjectsV2Command.name]: () => {
        page += 1;
        return page === 1
          ? {
              Contents: [
                { Key: 'app/a.txt', Size: 1 },
                { Key: 'app/b.txt', Size: 2 },
              ],
              IsTruncated: true,
              NextContinuationToken: 'tok',
            }
          : { Contents: [{ Key: 'app/c.txt', Size: 3 }], IsTruncated: false };
      },
    });
    const storage = new S3Storage(client, { bucket: 'b', keyPrefix: 'app/' });

    const all = await storage.list({ prefix: 'a' });
    expect(all.map((o) => o.key)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(calls[0]?.input.Prefix).toBe('app/a');

    page = 0;
    const limited = await storage.list({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('delegates signed URLs to the presigner', async () => {
    const { client } = fakeClient({});
    const presign = vi.fn(async () => 'https://signed.example/x');
    const storage = new S3Storage(client, { bucket: 'b', keyPrefix: 'app/', presign });

    const url = await storage.getSignedUrl('x.txt', { expiresInSeconds: 60 });
    expect(url).toBe('https://signed.example/x');
    const [, command, options] = presign.mock.calls[0] as unknown as [
      unknown,
      GetObjectCommand,
      { expiresIn: number },
    ];
    expect(command.input).toMatchObject({ Bucket: 'b', Key: 'app/x.txt' });
    expect(options.expiresIn).toBe(60);
  });
});

describe('s3StoragePlugin', () => {
  const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopLogger,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test logger
  } as any;

  it('registers the provider under STORAGE_SERVICE', async () => {
    const registry = new ServiceRegistry();
    await s3StoragePlugin({ bucket: 'bkt', endpoint: 'http://localhost:9000' }).setup({
      registry,
      config: {} as never,
      logger: noopLogger,
      bus: {} as never,
      actions: {} as never,
    });
    expect(registry.require(STORAGE_SERVICE).name).toBe('s3');
  });

  it('fails setup without a bucket', async () => {
    vi.stubEnv('ION_S3_BUCKET', '');
    const registry = new ServiceRegistry();
    await expect(async () =>
      s3StoragePlugin().setup({
        registry,
        config: {} as never,
        logger: noopLogger,
        bus: {} as never,
        actions: {} as never,
      }),
    ).rejects.toThrow(/ION_S3_BUCKET/);
    vi.unstubAllEnvs();
  });
});
