# Storage

Where module files are kept. Supabase Storage is built in. Provider modules named `storage-<id>` add other places, such as `storage-r2` for Cloudflare R2.

## How It Works

Modules that keep files ask the storage registry for a store and never call a provider directly:

The registry comes from `createStorageRegistry` in `storage/lib/registry.ts`, loaded with a dynamic import (see Loading below).

```ts
const storage = createStorageRegistry({ supabase: serviceClient, logger });

// A new file: goes to the provider chosen for this purpose.
const store = await storage.storeForNew({ purpose: 'media' });
await store.put(path, bytes, { contentType });
// Record store.provider and store.bucket on the row.

// An existing file: always the store its row names.
const store = await storage.storeFor({ storage_provider: row.storage_provider, storage_bucket: row.storage_bucket });
store.publicUrl(path);
store.sizedUrl(path, { width: 640 });
```

Every store has the same operations: `publicUrl`, `sizedUrl`, `put`, `signUpload` (a URL a browser can PUT a file to), `signRead`, `head`, `remove`, `list`, `copy` and `readRange`.

### Choosing the provider for new files

First match wins:

1. env `STORAGE_PROVIDER_<PURPOSE>`, e.g. `STORAGE_PROVIDER_MEDIA=r2`
2. env `STORAGE_PROVIDER`
3. this module's `provider_<purpose>` setting, then `default_provider`
4. `supabase`

If the chosen provider's module is not enabled, or is not fully configured, new files go to Supabase and a warning is logged once. Supabase always works, and each row records where its file went.

### Existing files

A file is read from the provider and bucket its row records, and nowhere else. If that provider is switched off, reads of those rows fail rather than return a different file. So turn a provider off only after its files have been moved.

### Addresses

- Supabase: `<SUPABASE_PUBLIC_URL>/storage/v1/object/public/<bucket>/<path>`. Resized pictures use Supabase's `/render/image/` unless `STORAGE_SUPABASE_RESIZE=false`. A caller can pass `{ cdn: true }` to put the Bunny pull zone in front (`BUNNY_CDN_ENABLED`, `BUNNY_PULLZONE_URL`). It is off by default, because addresses that go into sent email should not depend on a CDN account.
- Providers: their own public address, e.g. R2's custom domain.

For a file that is overwritten under the same name, pass `{ version: row.updated_at }` to `publicUrl` and `sizedUrl`, so a browser or cache never shows the old one.

### Loading

Callers load this module with a dynamic import and fall back to their own Supabase code when it is missing, because the live module tree only holds installed modules (see host-media's `lib/storage-adapter.ts`). Keep everything here server-only. The AWS SDK must not reach an admin or portal bundle.

### Code that used to call supabase.storage.from(bucket)

`aliasedBucketStore(supabase, bucket)` in `lib/bucket-store.ts` returns the store a Supabase bucket is served from when `supabase_alias` is set, and null when it is not. On null, keep the existing supabase-js code, so a brand still on Supabase behaves exactly as before. One registry is shared per process. `downloadObject(store, path)` reads a whole file through a signed address, which is also how private buckets are read. In tests, `lib/testing.ts` has a recording store and registries with and without the alias.

A `media` path whose first folder is a private bucket (video-masters, fetch-screenshots, fetch-artifacts) is refused by the aliased media store, because those folders hold the private buckets' files.

### Admin pages

`browser/storage.ts` is the browser half: `publicStorageUrl`, `rewriteStorageUrl`, `uploadToStorage` and `removeFromStorage`. With VITE_STORAGE_PUBLIC_URL set it uploads through the API's signed PUT addresses (`/api/storage/sign-upload`, `/api/storage/delete`); without it, or when the API answers `not_enabled`, it makes the supabase-js calls pages made before. It and `lib/public-url.ts` are the only files here that browser code may import.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `default_provider` | string | No | `supabase` | The provider new files go to. |
| `provider_media` | string | No | -- | The provider for event and host media, when it should differ. |
| `supabase_alias` | string | No | -- | Serve every Supabase bucket from this provider (e.g. `r2`). |

Env `STORAGE_PROVIDER`, `STORAGE_PROVIDER_<PURPOSE>` and `STORAGE_SUPABASE_ALIAS` win over these settings.

## Moving a brand off Supabase Storage

1. Copy every Supabase bucket into the provider's bucket: `media` at the root, every other bucket under `<bucket>/`. Check every object's size and MD5.
2. Set `supabase_alias` to the provider id. From then on `registry.bucketStore(b)`, and any row that still says Supabase, read and write the provider under the prefix. Rows and paths do not change.
3. Set the brand's `STORAGE_PUBLIC_URL` (the provider's public origin) and `STORAGE_LEGACY_HOSTS` (the hosts its old Supabase addresses used: the project host, any custom Supabase domain, any CDN zone). Pages then build and rewrite addresses with the helpers in `lib/public-url.ts`.
4. Block the prefixes of private buckets on the public domain. Read their files with `signRead`.

## Writing a provider module

A provider module `storage-<id>` exports `provider` from `lib/provider.ts`, implementing `StorageProviderModule` in `lib/types.ts`:

- `id`: the provider id, which is also stored on rows.
- `settings(env, moduleConfig)`: the provider's settings, or null when not fully configured. Read env first, then the module's config, and unseal secrets with `unsealSecret`.
- `defaultBucket(settings)`: where new files go.
- `createStore(settings, bucket)`: an `ObjectStore`. S3-compatible providers can use `s3Store` from `lib/s3-store.ts`.

## Features

- `storage` -- the storage registry and the built-in Supabase provider

## Dependencies

None.
