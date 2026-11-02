# Storage Provider: Cloudflare R2

Keeps new files in a Cloudflare R2 bucket. Browsers load them from the bucket's custom domain, and resized pictures come from Cloudflare Image Transformations on that domain, so nothing is resized ahead of time. R2 charges nothing for downloads.

## How It Works

R2 speaks the S3 protocol, so this module points the storage module's S3 store at `https://<account>.r2.cloudflarestorage.com`. Files already in Supabase stay there and keep working; only new files go to R2.

## Setting it up

1. In Cloudflare, create the R2 bucket.
2. Connect a custom domain to the bucket (R2, bucket, Settings, Custom Domains), e.g. `media.example.com`. The domain's zone must be on the same Cloudflare account.
3. Create an R2 API token with Object Read & Write on that bucket only. Cloudflare shows an Access Key ID and a Secret Access Key once.
4. Add CORS rules to the bucket, so browsers can upload to it and draw its pictures into a canvas:

   ```json
   [{
     "AllowedOrigins": ["https://admin.example.com", "https://example.com"],
     "AllowedMethods": ["GET", "HEAD", "PUT"],
     "AllowedHeaders": ["content-type"],
     "MaxAgeSeconds": 3600
   }]
   ```

5. For resized pictures, turn on Images, Transformations for the custom domain's zone, then set `R2_IMAGE_RESIZING=true`.
6. Enable this module, fill in the settings, then set the storage module's `default_provider` (or `provider_media`, or env `STORAGE_PROVIDER_MEDIA`) to `r2`.

Do not switch a purpose to R2 until every module that writes files for it uses the storage module. A module that still writes to Supabase on its own would put a row's variants in a different place from its original.

## Configuration

Each setting can also be given as an env var of the same name, which wins.

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `R2_ACCOUNT_ID` | string | Yes | -- | Cloudflare account id (32 hex characters) |
| `R2_BUCKET` | string | Yes | -- | The bucket new files go to |
| `R2_ACCESS_KEY_ID` | secret | Yes | -- | Access Key ID of the R2 API token (sealed at rest) |
| `R2_SECRET_ACCESS_KEY` | secret | Yes | -- | Secret Access Key of the R2 API token (sealed at rest) |
| `R2_PUBLIC_URL` | string | Yes | -- | The bucket's custom domain, `https://...`, no path |
| `R2_IMAGE_RESIZING` | boolean | No | `false` | Resize pictures with Cloudflare Image Transformations |
| `R2_JURISDICTION` | select | No | -- | `eu` or `fedramp`, only for a bucket created with one |

## Costs

As Cloudflare lists them: storage is $0.015 per GB a month after the first 10 GB, downloads are free, and image transformations are free for 5,000 unique transformations a month, then $0.50 per 1,000. Each picture and size counts once per 30 days.

## Features

- `storage-r2` -- Cloudflare R2 as a storage provider

## Dependencies

- **storage** -- the storage registry this provider plugs into
