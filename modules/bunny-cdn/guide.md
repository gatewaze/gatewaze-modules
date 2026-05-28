# Bunny CDN Module

Optimized image delivery for Supabase Storage via Bunny.net CDN pull zones.

## Setup

### 1. Create a Bunny CDN Pull Zone

1. Sign up at [bunny.net](https://bunny.net) and go to the dashboard.
2. Navigate to **CDN > Pull Zones** and click **Add Pull Zone**.
3. Set the **Origin URL** to your Supabase storage endpoint:
   ```
   https://<project-ref>.supabase.co/storage/v1
   ```
4. Choose a pull zone hostname (e.g., `myproject.b-cdn.net`) or add a custom domain.
5. Under **Optimizer**, enable **Bunny Optimizer** for automatic image processing (WebP/AVIF conversion, resizing).

### 2. Install and Configure the Module

1. In the Gatewaze admin, go to **Settings > Modules** and install **Bunny CDN**.
2. Enter your pull zone URL (e.g., `https://myproject.b-cdn.net`).
3. The module is enabled by default. Toggle **BUNNY_CDN_ENABLED** to disable without removing the configuration.

### 3. How It Works

When the module is enabled, image URLs are automatically rewritten:

- **Before:** `https://<project>.supabase.co/storage/v1/object/public/photos/image.jpg`
- **After:** `https://myproject.b-cdn.net/object/public/photos/image.jpg?width=800&quality=80`

Key behaviors:

- `/render/image/public/` paths are converted to `/object/public/` so the original image is fetched, and Bunny CDN handles all transformations instead of Supabase imgproxy.
- Resize parameters (`width`, `height`, `quality`, `aspect_ratio`) are passed as query strings to Bunny's optimizer.
- If the pull zone URL is missing or the module is disabled, the original Supabase URL is returned unchanged.
- No application code changes are required -- components that call `getBunnyImageUrl()` or `getBunnyCDNUrl()` will automatically route through the CDN when enabled.

### Cost Savings

Supabase's built-in image transformations count against your project's transformation quota. By routing through Bunny CDN, all resizing and format conversion happens at the CDN edge, keeping your Supabase usage low while improving global delivery speed.
