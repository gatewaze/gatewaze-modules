import {
  CARD_WIDTH_PT,
  CARD_HEIGHT_PT,
  fontAssetPublicUrl,
  resolvePlaceCardVariable,
  type FontAsset,
  type PlaceCard,
  type PlaceCardField,
} from './placeCards';

/**
 * Renders place cards to a print-ready PDF. Each page is one flat card
 * (83 x 108mm). When the template has inside fields, every card becomes an
 * outside page followed by an inside page, so duplex printing ("flip on long
 * edge") puts each card's meal choices on its own reverse — a card with no
 * recorded choices still gets its blank inside page, or the pairing would
 * slip for every card after it.
 */

/**
 * Word-wrap that preserves explicit newlines — meal.choices is one line per
 * course. Words longer than the width go on their own line, matching the
 * invites PDF generator.
 */
export function wrapLines(
  text: string,
  maxWidth: number | undefined,
  measureWidth: (s: string) => number,
): string[] {
  const paragraphs = text.split(/\r?\n/);
  if (!maxWidth || maxWidth <= 0) return paragraphs;

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (measureWidth(trial) <= maxWidth) {
        line = trial;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Swap typographic characters for WinAnsi-safe ones and drop the rest, for
 * text drawn with the built-in Helvetica. Uploaded fonts go through fontkit
 * and keep the original text.
 */
function winAnsiSafe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF]/g, '');
}

function parseColor(hex: string, rgbFn: typeof import('pdf-lib').rgb) {
  const clean = (hex || '#000000').replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return rgbFn(
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0,
  );
}

export async function buildPlaceCardPdfBytes(input: {
  fields: PlaceCardField[];
  cards: PlaceCard[];
  fontAssets: FontAsset[];
  /** Background PDF (page 1 = outside, page 2 = inside), e.g. a Canva export. */
  backgroundUrl?: string | null;
}): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  const fontkitModule = await import('@pdf-lib/fontkit');
  const fontkit = fontkitModule.default || fontkitModule;
  const { PDFDocument, StandardFonts, rgb, degrees } = pdfLib;

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);

  // Embed the background's faces once; drawn scaled to the exact card size on
  // every page, so a Canva export a point or two off 83 x 108mm still lines
  // up with the field coordinates.
  let bgOutside: Awaited<ReturnType<typeof pdf.embedPage>> | null = null;
  let bgInside: Awaited<ReturnType<typeof pdf.embedPage>> | null = null;
  if (input.backgroundUrl) {
    try {
      const bgBytes = await fetch(input.backgroundUrl).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      const bgDoc = await PDFDocument.load(bgBytes);
      const indices = bgDoc.getPageCount() >= 2 ? [0, 1] : [0];
      const embedded = await pdf.embedPdf(bgDoc, indices);
      bgOutside = embedded[0] || null;
      bgInside = embedded[1] || null;
    } catch (err) {
      console.warn('[event-seating] Failed to load the card background:', err);
    }
  }
  const drawBackground = (page: ReturnType<typeof pdf.addPage>, bg: typeof bgOutside) => {
    if (!bg) return;
    page.drawPage(bg, { x: 0, y: 0, width: CARD_WIDTH_PT, height: CARD_HEIGHT_PT });
  };

  // Only fetch fonts the template actually uses.
  const usedFontIds = new Set(
    input.fields.map((f) => f.fontAssetId).filter((id): id is string => !!id),
  );
  const fontCache = new Map<string, typeof helvetica>();
  for (const asset of input.fontAssets) {
    if (!usedFontIds.has(asset.id)) continue;
    try {
      const bytes = await fetch(fontAssetPublicUrl(asset)).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      fontCache.set(asset.id, await pdf.embedFont(new Uint8Array(bytes)));
    } catch (err) {
      console.warn(`[event-seating] Failed to load font ${asset.filename}:`, err);
    }
  }

  const outsideFields = input.fields.filter((f) => f.face !== 'inside');
  const insideFields = input.fields.filter((f) => f.face === 'inside');
  const hasInside = insideFields.length > 0 || bgInside !== null;

  const drawFace = (page: ReturnType<typeof pdf.addPage>, fields: PlaceCardField[], card: PlaceCard) => {
    for (const field of fields) {
      const resolved = field.text !== undefined
        ? field.text
        : resolvePlaceCardVariable(field.variable || '', card.context);
      if (!resolved) continue;

      const font = field.fontAssetId ? (fontCache.get(field.fontAssetId) || helvetica) : helvetica;
      const rawText = font === helvetica ? winAnsiSafe(resolved) : resolved;
      if (!rawText.trim()) continue;

      const fontSize = field.fontSize || 12;
      const lineHeight = field.lineHeight ?? 1;
      const color = parseColor(field.color || '#000000', rgb);

      const lines = wrapLines(rawText, field.maxWidth, (s) => font.widthOfTextAtSize(s, fontSize));

      const anchorX = field.x || 0;
      const anchorY = field.y || 0;
      const rotationDeg = field.rotation || 0;
      const rad = (rotationDeg * Math.PI) / 180;
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (!line) continue;
        const lineWidth = font.widthOfTextAtSize(line, fontSize);

        // Local (unrotated) offset of this line's left-baseline from the
        // anchor, then rotated around the anchor — same maths as the
        // invites PDF generator, so a field behaves identically here.
        let localX = 0;
        if (field.align === 'center') localX = -lineWidth / 2;
        else if (field.align === 'right') localX = -lineWidth;
        const localY = -li * fontSize * lineHeight;

        const rotatedX = localX * cosA - localY * sinA;
        const rotatedY = localX * sinA + localY * cosA;

        try {
          page.drawText(line, {
            x: anchorX + rotatedX,
            y: anchorY + rotatedY,
            size: fontSize,
            font,
            color,
            ...(rotationDeg ? { rotate: degrees(rotationDeg) } : {}),
          });
        } catch (err) {
          // One unencodable glyph must not sink the whole batch.
          console.warn('[event-seating] Skipped a place-card line:', err);
        }
      }
    }
  };

  for (const card of input.cards) {
    const outsidePage = pdf.addPage([CARD_WIDTH_PT, CARD_HEIGHT_PT]);
    drawBackground(outsidePage, bgOutside);
    drawFace(outsidePage, outsideFields, card);
    if (hasInside) {
      const insidePage = pdf.addPage([CARD_WIDTH_PT, CARD_HEIGHT_PT]);
      drawBackground(insidePage, bgInside);
      drawFace(insidePage, insideFields, card);
    }
  }

  return await pdf.save();
}

export async function downloadPlaceCardPdf(input: {
  fields: PlaceCardField[];
  cards: PlaceCard[];
  fontAssets: FontAsset[];
  backgroundUrl?: string | null;
  filename: string;
}): Promise<void> {
  const bytes = await buildPlaceCardPdfBytes(input);
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = input.filename;
  link.click();
  URL.revokeObjectURL(url);
}
