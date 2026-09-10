import { useEffect, useState } from 'react';
import { getAssetPublicUrl, type SeatingAsset } from './seatingService';

/**
 * Resolves a floor plan asset to something both the canvas preview and the
 * export can draw. Images load directly; PDFs have their first page rendered
 * to an offscreen canvas via pdf.js, which is the same approach the invite
 * template editor uses.
 */
export function useBackgroundImage(asset: SeatingAsset | null) {
  const [image, setImage] = useState<CanvasImageSource | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);

  useEffect(() => {
    if (!asset) {
      setImage(null);
      setDataUrl(null);
      setNaturalRatio(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const url = getAssetPublicUrl(asset);

    (async () => {
      try {
        if (asset.mime_type === 'application/pdf') {
          const pdfjsLib: any = await import('pdfjs-dist');
          if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
            // Loaded from CDN to avoid Vite worker-loader issues when this
            // module is resolved from an external module directory.
            pdfjsLib.GlobalWorkerOptions.workerSrc =
              `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
          }
          const pdf = await pdfjsLib.getDocument(url).promise;
          const page = await pdf.getPage(1);
          const base = page.getViewport({ scale: 1 });
          // Render at a fixed width so the bitmap is sharp when scaled up for
          // the PDF export but never unreasonably large.
          const renderScale = 1600 / base.width;
          const viewport = page.getViewport({ scale: renderScale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('No 2D context available');
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          setImage(canvas);
          setDataUrl(canvas.toDataURL('image/png'));
          setNaturalRatio(base.width / base.height);
        } else {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = url;
          await img.decode();
          if (cancelled) return;
          setImage(img);
          setDataUrl(url);
          setNaturalRatio(img.naturalWidth / img.naturalHeight);
        }
      } catch (err) {
        console.error('[event-seating] Failed to load floor plan:', err);
        if (!cancelled) {
          setImage(null);
          setDataUrl(null);
          setNaturalRatio(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [asset]);

  return { image, dataUrl, loading, naturalRatio };
}
