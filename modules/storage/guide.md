# Storage

Where module files are kept. Supabase Storage is built in. Provider modules named `storage-<id>` add other places, such as `storage-r2` for Cloudflare R2.

## How It Works

Modules that keep files ask the storage registry for a store and never call a provider directly:

```ts
import { createStorageRegistry } from '../../storage/lib/registry.js';

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

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `default_provider` | string | No | `supabase` | The provider new files go to. |
| `provider_media` | string | No | -- | The provider for event and host media, when it should differ. |

Env `STORAGE_PROVIDER` and `STORAGE_PROVIDER_<PURPOSE>` win over these settings.

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
