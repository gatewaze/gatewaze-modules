/**
 * The one interface every storage provider implements.
 *
 * A provider is where the bytes live (Supabase Storage, Cloudflare R2, any
 * S3-compatible bucket). A store is one provider plus one bucket. Callers ask
 * the registry (lib/registry.ts) for a store and never branch on the provider
 * themselves.
 *
 * Rows that point at a stored file record which provider and bucket hold it
 * (`storage_provider`, `storage_bucket`). A brand can switch the provider for
 * new files without moving a byte: old rows keep resolving from where they
 * are, new rows go to the new place.
 */

import type { Readable } from 'node:stream';

/** The provider id. 'supabase' is built in; others come from storage-<id> modules. */
export type StorageProviderId = string;

export interface HeadResult {
  ok: boolean;
  bytes: number;
  contentType: string;
}

export interface ListEntry {
  path: string;
  bytes: number;
  etag?: string;
}

/** A size to ask a provider's image resizer for. */
export interface ImageSize {
  width: number;
  height?: number;
  /** 'contain' keeps the whole picture inside the box; 'cover' fills it and crops. */
  fit?: 'contain' | 'cover';
  /** 1 to 100. */
  quality?: number;
}

export interface UrlOptions {
  /**
   * Changes the address when the file behind it changes, so a browser or a
   * cache never shows the old one. Pass the row's updated_at (or any value
   * that changes with the bytes) for files that are overwritten in place.
   */
  version?: string | number | null;
}

export interface PutOptions {
  contentType: string;
  /** Cache-Control for the stored object. Defaults to a year for immutable names. */
  cacheControl?: string;
  /** Replace an existing object at the same path. Off by default. */
  upsert?: boolean;
  /** Cut a streamed body off past this many bytes and fail the write. */
  maxBytes?: number;
}

/** What a browser needs to upload a file straight to the store. */
export interface SignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the browser must send with the PUT, exactly as given. */
  headers: Record<string, string>;
}

export interface SignUploadOptions {
  contentType: string;
  /** Pins the upload to exactly this many bytes where the provider can. */
  bytes?: number;
  expiresSeconds?: number;
}

export type Body = Buffer | Uint8Array | Readable | ReadableStream;

export interface ObjectStore {
  readonly provider: StorageProviderId;
  readonly bucket: string;
  /** True when sizedUrl returns a resized picture rather than the original. */
  readonly canResize: boolean;

  /** The address a browser loads a public object from. Never needs a request. */
  publicUrl(path: string, opts?: UrlOptions): string;
  /** A resized copy of a picture, or publicUrl when the provider cannot resize. */
  sizedUrl(path: string, size: ImageSize, opts?: UrlOptions): string;

  put(path: string, body: Body, opts: PutOptions): Promise<{ bytes: number }>;
  signUpload(path: string, opts: SignUploadOptions): Promise<SignedUpload>;
  /**
   * A time-limited address to read the object, public or not. By default it
   * is the address a browser can reach; `forServer` returns the one this
   * server reaches, which can differ for an in-cluster Supabase.
   */
  signRead(path: string, expiresSeconds: number, opts?: { forServer?: boolean }): Promise<string>;
  head(path: string): Promise<HeadResult>;
  /** Removes each path. Never throws; returns the ones that could not be removed. */
  remove(paths: string[]): Promise<{ failed: string[] }>;
  /** Objects under a folder prefix (must end in /), bounded by max. */
  list(prefix: string, max?: number): Promise<ListEntry[]>;
  /** Server-side copy within the bucket. */
  copy(from: string, to: string, opts?: { contentType?: string }): Promise<void>;
  /** The first `bytes` of an object, to check what it really is. */
  readRange(path: string, bytes: number): Promise<Buffer>;
}

/**
 * What a storage-<id> module exports from lib/provider.ts as `provider`.
 *
 * `settings` reads the provider's configuration (env first, then the module's
 * row in installed_modules) and returns null when it is not fully configured.
 */
export interface StorageProviderModule<S = unknown> {
  id: StorageProviderId;
  settings(env: Record<string, string | undefined>, moduleConfig: Record<string, unknown>): S | null;
  /** The bucket new files go to, from the settings. */
  defaultBucket(settings: S): string;
  /**
   * Every bucket an existing row may name, the default included. A row
   * naming any other bucket is refused, so a row edited by hand cannot point
   * the server's credentials at a bucket it was never meant to touch.
   */
  allowedBuckets?(settings: S): string[];
  createStore(settings: S, bucket: string): ObjectStore;
}
