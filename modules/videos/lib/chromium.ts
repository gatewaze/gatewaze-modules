// @ts-nocheck — puppeteer-core is resolved at module-host install time.

/**
 * Render a self-contained HTML page to a PNG with the worker image's pinned
 * Chromium. Same launch recipe as event-speakers' card renderer, including
 * the single-process fallback on linux/arm64 containers where the
 * multi-process compositor never produces a frame.
 *
 * Pages given to this are the module's own templates with data URIs for
 * every asset, so no network access happens during a render and nothing an
 * editor typed reaches the page unescaped.
 */

function chromiumExecutablePath(): string {
  return process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || '/usr/bin/chromium';
}

export async function renderHtmlToPng(html: string, width: number, height: number, scale = 1): Promise<Buffer> {
  const puppeteer = (await import('puppeteer-core')).default;
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad', '--force-color-profile=srgb',
    '--hide-scrollbars',
  ];
  if (process.platform === 'linux' && process.arch === 'arm64') args.push('--single-process', '--no-zygote');
  // The browser gets a bare environment, not the worker's: the service-role
  // key and the bucket secret have no business in a renderer process. And
  // nothing but data: URIs may load; the page is self-contained by design.
  const browser = await puppeteer.launch({
    executablePath: chromiumExecutablePath(), headless: true, args,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp', ...(process.env.LANG ? { LANG: process.env.LANG } : {}) },
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = r.url();
      if (u.startsWith('data:') || u === 'about:blank') void r.continue();
      else void r.abort();
    });
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Fonts are data URIs, but the face still has to be decoded before the shot.
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
    return Buffer.from(shot);
  } finally {
    await browser.close().catch(() => {});
  }
}
