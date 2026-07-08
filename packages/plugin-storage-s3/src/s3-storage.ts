/**
 * S3-compatible {@link StorageProvider} — replaces core's filesystem
 * LocalStorage with AWS S3, MinIO, Cloudflare R2, or any S3-compatible
 * endpoint. Uses the official AWS SDK v3 (an infrastructure plugin is exactly
 * where a vendor SDK belongs — ADR-018's "sealed npm plugin" tier):
 * `PutObject` for byte payloads, multipart `Upload` for streams of unknown
 * length, and the request presigner for {@link getSignedUrl}.
 *
 * All object keys are validated by core's `normalizeStorageKey` and then
 * namespaced under an optional key prefix, so one bucket can host several
 * deployments.
 */

import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl as presignUrl } from '@aws-sdk/s3-request-presigner';
import {
  type StorageListOptions,
  type StorageObject,
  type StorageObjectInfo,
  type StorageProvider,
  type StoragePutOptions,
  type StorageSignedUrlOptions,
  normalizeStorageKey,
} from '@ion-drive/core';

const DEFAULT_LIST_LIMIT = 1000;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;

/** The command surface used — lets tests inject a fake client. */
export interface S3ClientLike {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the SDK's own generic send()
  send(command: any): Promise<any>;
}

/** Signature of the presigner, injectable for tests. */
export type PresignFn = (
  client: S3ClientLike,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface S3StorageOptions {
  bucket: string;
  /** Key prefix inside the bucket (e.g. `ion/`). Default: none. */
  keyPrefix?: string;
  /** Injectable presigner (tests). Defaults to the AWS presigner. */
  presign?: PresignFn;
}

export class S3Storage implements StorageProvider {
  readonly name = 's3';

  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly presign: PresignFn;

  constructor(
    private readonly client: S3ClientLike,
    options: S3StorageOptions,
  ) {
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? '';
    this.presign = options.presign ?? ((c, cmd, o) => presignUrl(c as S3Client, cmd, o));
  }

  async put(
    key: string,
    data: Uint8Array | Readable,
    options?: StoragePutOptions,
  ): Promise<StorageObjectInfo> {
    const normalized = normalizeStorageKey(key);
    const remoteKey = this.keyPrefix + normalized;

    if (data instanceof Uint8Array) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: remoteKey,
          Body: data,
          ContentType: options?.contentType,
        }),
      );
      return {
        key: normalized,
        size: data.byteLength,
        contentType: options?.contentType,
        lastModified: new Date(),
      };
    }

    // Streams have unknown length — multipart Upload handles the chunking.
    const upload = new Upload({
      client: this.client as S3Client,
      params: {
        Bucket: this.bucket,
        Key: remoteKey,
        Body: data,
        ContentType: options?.contentType,
      },
    });
    await upload.done();
    const info = await this.head(normalized);
    return info ?? { key: normalized, size: 0, contentType: options?.contentType };
  }

  async get(key: string): Promise<StorageObject | undefined> {
    const normalized = normalizeStorageKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.keyPrefix + normalized }),
      );
      return {
        info: {
          key: normalized,
          size: response.ContentLength ?? 0,
          contentType: response.ContentType,
          lastModified: response.LastModified,
        },
        body: response.Body as Readable,
      };
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }

  async head(key: string): Promise<StorageObjectInfo | undefined> {
    const normalized = normalizeStorageKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyPrefix + normalized }),
      );
      return {
        key: normalized,
        size: response.ContentLength ?? 0,
        contentType: response.ContentType,
        lastModified: response.LastModified,
      };
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const normalized = normalizeStorageKey(key);
    // S3's DeleteObject is silent about prior existence — probe first so the
    // port's "returns whether it existed" contract holds.
    const existed = (await this.head(normalized)) !== undefined;
    if (!existed) return false;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyPrefix + normalized }),
    );
    return true;
  }

  async list(options?: StorageListOptions): Promise<StorageObjectInfo[]> {
    const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
    const prefix = this.keyPrefix + (options?.prefix?.replace(/^\/+/, '') ?? '');
    const results: StorageObjectInfo[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix || undefined,
          MaxKeys: Math.min(limit - results.length, 1000),
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (!item.Key) continue;
        results.push({
          key: item.Key.slice(this.keyPrefix.length),
          size: item.Size ?? 0,
          lastModified: item.LastModified,
        });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken && results.length < limit);

    return results.slice(0, limit);
  }

  async getSignedUrl(key: string, options?: StorageSignedUrlOptions): Promise<string> {
    const normalized = normalizeStorageKey(key);
    return this.presign(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.keyPrefix + normalized }),
      { expiresIn: options?.expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS },
    );
  }
}

/** Whether an SDK error means "object/bucket key not found". */
function isMissing(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: string }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
