/**
 * @module @ion-drive/plugin-storage-s3
 *
 * Ion Drive plugin swapping the platform's blob store for an S3-compatible
 * backend (AWS S3, MinIO, Cloudflare R2, …).
 *
 * Usage — programmatic:
 * ```ts
 * import { s3StoragePlugin } from '@ion-drive/plugin-storage-s3';
 * await createServer(config, {
 *   plugins: [s3StoragePlugin({ bucket: 'my-app', endpoint: 'http://localhost:9000' })],
 * });
 * ```
 * or via env: `ION_PLUGINS=@ion-drive/plugin-storage-s3` with `ION_S3_BUCKET`
 * (required), and optionally `ION_S3_REGION`, `ION_S3_ENDPOINT` (MinIO/R2),
 * `ION_S3_FORCE_PATH_STYLE`, `ION_S3_KEY_PREFIX`, and
 * `ION_S3_ACCESS_KEY_ID`/`ION_S3_SECRET_ACCESS_KEY` (omit both to use the AWS
 * SDK's default credential chain — instance roles, `AWS_*` env, etc.).
 */

import { S3Client } from '@aws-sdk/client-s3';
import { type IonPlugin, STORAGE_SERVICE, definePlugin } from '@ion-drive/core';
import { S3Storage, type S3StorageOptions } from './s3-storage.js';

export { S3Storage } from './s3-storage.js';
export type { PresignFn, S3ClientLike, S3StorageOptions } from './s3-storage.js';

export interface S3StoragePluginOptions extends Partial<Omit<S3StorageOptions, 'presign'>> {
  /** AWS region (default `us-east-1` — MinIO/R2 don't care). */
  region?: string;
  /** Custom endpoint for S3-compatible services (MinIO, R2). */
  endpoint?: string;
  /** Path-style addressing — required by MinIO. Default: on when `endpoint` is set. */
  forcePathStyle?: boolean;
  /** Static credentials. Omit to use the SDK's default credential chain. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

/** Creates the plugin. Options fall back to `ION_S3_*` environment variables. */
export function s3StoragePlugin(options: S3StoragePluginOptions = {}): IonPlugin {
  return definePlugin({
    name: 's3-storage',
    setup(ctx) {
      const bucket = options.bucket ?? process.env.ION_S3_BUCKET;
      if (!bucket) {
        throw new Error(
          'S3 bucket missing — set ION_S3_BUCKET or pass s3StoragePlugin({ bucket })',
        );
      }
      const endpoint = options.endpoint ?? process.env.ION_S3_ENDPOINT;
      const accessKeyId = options.accessKeyId ?? process.env.ION_S3_ACCESS_KEY_ID;
      const secretAccessKey = options.secretAccessKey ?? process.env.ION_S3_SECRET_ACCESS_KEY;

      const client = new S3Client({
        region: options.region ?? process.env.ION_S3_REGION ?? 'us-east-1',
        endpoint,
        forcePathStyle:
          options.forcePathStyle ??
          envFlag(process.env.ION_S3_FORCE_PATH_STYLE, endpoint !== undefined),
        credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      });

      const storage = new S3Storage(client, {
        bucket,
        keyPrefix: options.keyPrefix ?? process.env.ION_S3_KEY_PREFIX ?? '',
      });
      ctx.registry.set(STORAGE_SERVICE, storage);
      ctx.logger.info('Storage swapped to S3', {
        bucket,
        endpoint: endpoint ?? '(aws)',
      });
    },
  });
}

/** Env-driven default export for `ION_PLUGINS=@ion-drive/plugin-storage-s3`. */
export default s3StoragePlugin();
