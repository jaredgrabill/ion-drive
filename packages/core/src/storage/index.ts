/**
 * Storage module barrel — the {@link StorageProvider} port, the default
 * filesystem adapter, and the registry token used to resolve/replace it.
 */

export { LocalStorage } from './local-storage.js';
export {
  normalizeStorageKey,
  STORAGE_SERVICE,
  StorageError,
} from './storage-provider.js';
export type {
  StorageListOptions,
  StorageObject,
  StorageObjectInfo,
  StoragePutOptions,
  StorageProvider,
  StorageSignedUrlOptions,
} from './storage-provider.js';
