import type { CourseSheet } from './cateringExport';

/**
 * Renders the venue's meal-selection sheets to a PDF. Kept free of any data
 * access so the layout — pagination, truncation, character encoding — can be
 * exercised directly.
 */

/** Placeholder for a seated guest with no answer recorded for a course. */
export const NO_CHOICE = 'No selection recorded';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 46;

/** Drop characters WinAnsi can't encode, so one odd glyph can't fail the export. */
function pdfSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
}

function fit(text: string, font: any, size: number, maxWidth: number): string {
  let out = pdfSafe(text);
  if (font.widthOfTextAtSize(out, size) <= maxWidth) return out;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out.trimEnd()}...`;
}

/** The PDF bytes. Split from the download so the layout can be exercised in tests. */
export async function buildCateringPdfBytes(input: {
  sheets: CourseSheet[];
  title: string;
  subtitle: string;
}): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.12, 0.16, 0.2);
  const muted = rgb(0.45, 0.5, 0.55);
  const rule = rgb(0.82, 0.85, 0.88);
  const bandFill = rgb(0.94, 0.96, 0.97);

  for (const sheet of input.sheets) {
    let page = pdf.addPage([A4.width, A4.height]);
    let y = A4.height - MARGIN;
    const contentWidth = A4.width - MARGIN * 2;
    let pageIndex = 1;

    const header = (continued: boolean) => {
      page.drawText(pdfSafe(input.title), { x: MARGIN, y, size: 15, font: bold, color: ink });
      y -= 17;
      page.drawText(fit(input.subtitle, regular, 10, contentWidth), {
        x: MARGIN, y, size: 10, font: regular, color: muted,
      });
      y -= 26;
      page.drawText(pdfSafe(continued ? `${sheet.label} (continued)` : sheet.label), {
        x: MARGIN, y, size: 20, font: bold, color: ink,
      });
      y -= 10;
      page.drawLine({
        start: { x: MARGIN, y }, end: { x: A4.width - MARGIN, y },
        thickness: 1, color: rule,
      });
      y -= 20;
    };

    const newPage = () => {
      page = pdf.addPage([A4.width, A4.height]);
      pageIndex += 1;
      y = A4.height - MARGIN;
      header(true);
    };

    const ensure = (needed: number) => {
      if (y - needed < MARGIN + 24) newPage();
    };

    header(false);

    // Kitchen totals
    page.drawText('Totals', { x: MARGIN, y, size: 11, font: bold, color: ink });
    y -= 15;
    for (const [choice, count] of sheet.totals) {
      ensure(14);
      page.drawText(fit(choice, regular, 10, contentWidth - 46), {
        x: MARGIN + 10, y, size: 10, font: regular, color: ink,
      });
      page.drawText(String(count), {
        x: A4.width - MARGIN - bold.widthOfTextAtSize(String(count), 10),
        y, size: 10, font: bold, color: ink,
      });
      y -= 14;
    }
    y -= 6;
    page.drawText(`${sheet.rows.length} seated${sheet.missing > 0 ? ` · ${sheet.missing} with no selection` : ''}`, {
      x: MARGIN, y, size: 9, font: regular, color: muted,
    });
    y -= 22;

    // Per-table listing
    let currentTable: string | null = null;
    for (const row of sheet.rows) {
      if (row.tableLabel !== currentTable) {
        ensure(46);
        currentTable = row.tableLabel;
        const seatedHere = sheet.rows.filter((r) => r.tableLabel === currentTable).length;
        page.drawRectangle({
          x: MARGIN - 4, y: y - 4, width: contentWidth + 8, height: 20, color: bandFill,
        });
        page.drawText(fit(row.tableLabel, bold, 12, contentWidth - 70), {
          x: MARGIN, y: y + 2, size: 12, font: bold, color: ink,
        });
        const countLabel = `${seatedHere} seated`;
        page.drawText(countLabel, {
          x: A4.width - MARGIN - regular.widthOfTextAtSize(countLabel, 9),
          y: y + 3, size: 9, font: regular, color: muted,
        });
        y -= 24;
      }

      ensure(15);
      const seatLabel = `${row.seatNumber}.`;
      page.drawText(seatLabel, { x: MARGIN + 6, y, size: 10, font: regular, color: muted });
      page.drawText(fit(row.guestName, regular, 10, 190), {
        x: MARGIN + 26, y, size: 10, font: regular, color: ink,
      });
      const choiceX = MARGIN + 232;
      page.drawText(fit(row.choice, bold, 10, A4.width - MARGIN - choiceX), {
        x: choiceX, y, size: 10, font: bold,
        color: row.choice === NO_CHOICE ? muted : ink,
      });
      y -= 15;
    }

    void pageIndex;
  }

  // Page numbers, once the total is known.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} of ${pages.length}`;
    p.drawText(label, {
      x: A4.width - MARGIN - regular.widthOfTextAtSize(label, 8),
      y: MARGIN - 16, size: 8, font: regular, color: muted,
    });
  });

  return await pdf.save();
}

export async function downloadCateringPdf(input: {
  sheets: CourseSheet[];
  title: string;
  subtitle: string;
  filename: string;
}): Promise<void> {
  const bytes = await buildCateringPdfBytes(input);
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = input.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
