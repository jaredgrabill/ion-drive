# @ion-drive/plugin-storage-s3

S3-compatible blob storage for [Ion Drive](https://github.com/jaredgrabill/ion-drive) —
swaps the platform's `StorageProvider` port (filesystem `LocalStorage` by
default) for AWS S3, MinIO, Cloudflare R2, or any S3-compatible endpoint,
including pre-signed download URLs.

## Install

```bash
npm install @ion-drive/plugin-storage-s3
```

Programmatic (recommended — your `server.ts` composition root):

```ts
import { createServer, loadConfig } from '@ion-drive/core';
import { s3StoragePlugin } from '@ion-drive/plugin-storage-s3';

const server = await createServer(loadConfig(), {
  plugins: [
    s3StoragePlugin({
      bucket: 'my-app',
      endpoint: 'http://localhost:9000', // MinIO/R2; omit for AWS
    }),
  ],
});
```

Or via environment: `ION_PLUGINS=@ion-drive/plugin-storage-s3`.

## Configuration

| Option | Env fallback | Notes |
|---|---|---|
| `bucket` | `ION_S3_BUCKET` | Required |
| `region` | `ION_S3_REGION` | Default `us-east-1` (MinIO/R2 don't care) |
| `endpoint` | `ION_S3_ENDPOINT` | For S3-compatible services |
| `forcePathStyle` | `ION_S3_FORCE_PATH_STYLE` | Defaults **on** when `endpoint` is set (MinIO needs it) |
| `accessKeyId` / `secretAccessKey` | `ION_S3_ACCESS_KEY_ID` / `ION_S3_SECRET_ACCESS_KEY` | Omit both to use the AWS default credential chain (instance roles, `AWS_*` env) |
| `keyPrefix` | `ION_S3_KEY_PREFIX` | Namespace inside the bucket |

Local development target: the repo's `docker/docker-compose.yml` ships a
commented-out MinIO service.

## License

Apache-2.0 © IonShift Technologies LLC
