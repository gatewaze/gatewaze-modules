/**
 * Renders a seating plan to a bitmap and, from there, to a PNG or a PDF.
 *
 * The plan is drawn straight onto a 2D canvas rather than screenshotting the
 * DOM: the same geometry helpers drive the editor and the export, so what you
 * arrange is what comes out, at whatever resolution you ask for.
 */

import { usableSeats, usableSeatCount, SEAT_SIZE } from './seatGeometry';
import { seatKey, type SeatNumberMap } from './seatNumbering';
import type { SeatingPlan, SeatingTable, SeatingAssignment } from './seatingService';

export interface ExportInput {
  plan: SeatingPlan;
  tables: SeatingTable[];
  assignments: SeatingAssignment[];
  /** Display name for each seated guest, keyed by assignment id. */
  namesByAssignment: Map<string, string>;
  /** Already-rendered floor plan, or null to export on plain paper. */
  background: CanvasImageSource | null;
  title: string;
  /** Seat numbers as guests and the venue see them. */
  seatNumbers: SeatNumberMap;
  /**
   * 'names' is the working plan. 'numbers' is the one the venue gets: the seat
   * number leads, because on the day it is the only thing that identifies a
   * place — the tables are covered and pushed together.
   */
  seatLabels?: 'names' | 'numbers';
}

const INK = '#1f2933';
const MUTED = '#7b8794';
const TABLE_FILL = '#f4f6f8';
const TABLE_STROKE = '#9aa5b1';
const SEAT_EMPTY = '#ffffff';
const SEAT_FILLED = '#dbeafe';
const SEAT_STROKE = '#7b8794';

function drawTable(ctx: CanvasRenderingContext2D, table: SeatingTable) {
  ctx.save();
  ctx.translate(table.x, table.y);
  ctx.rotate((table.rotation * Math.PI) / 180);
  ctx.fillStyle = table.colour || TABLE_FILL;
  ctx.strokeStyle = TABLE_STROKE;
  ctx.lineWidth = 2;

  if (table.shape === 'round') {
    ctx.beginPath();
    ctx.arc(0, 0, table.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    const radius = 8;
    const w = table.width;
    const h = table.height;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, radius);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // Label sits upright at the table centre regardless of table rotation.
  ctx.fillStyle = INK;
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(table.label, table.x, table.y);
}

/** First name plus a surname initial, for the tight label under a seat number. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 9);
  return `${parts[0].slice(0, 8)} ${parts[parts.length - 1].charAt(0)}`;
}

/** Split a name so long ones stay inside the seat chip. */
function nameLines(name: string): string[] {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return [name.slice(0, 14)];
  const first = parts[0];
  const rest = parts.slice(1).join(' ');
  return [first.slice(0, 14), rest.slice(0, 14)];
}

export function renderPlanToCanvas(input: ExportInput, scale = 2): HTMLCanvasElement {
  const {
    plan, tables, assignments, namesByAssignment, background, title,
    seatNumbers, seatLabels = 'names',
  } = input;
  const headerHeight = 70;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(plan.canvas_width * scale);
  canvas.height = Math.round((plan.canvas_height + headerHeight) * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create an export canvas');

  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.canvas_width, plan.canvas_height + headerHeight);

  // Header
  ctx.fillStyle = INK;
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, 24, 42);
  const seated = assignments.length;
  const seats = tables.reduce((sum, t) => sum + usableSeatCount(t), 0);
  ctx.fillStyle = MUTED;
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText(`${tables.length} tables · ${seated} of ${seats} seats filled`, 24, 62);

  ctx.save();
  ctx.translate(0, headerHeight);

  if (background && !plan.background_hidden) {
    ctx.globalAlpha = 0.5;
    ctx.drawImage(background, 0, 0, plan.canvas_width, plan.canvas_height);
    ctx.globalAlpha = 1;
  }

  const byTable = new Map<string, Map<number, string>>();
  for (const assignment of assignments) {
    const name = namesByAssignment.get(assignment.id);
    if (!name) continue;
    if (!byTable.has(assignment.table_id)) byTable.set(assignment.table_id, new Map());
    byTable.get(assignment.table_id)!.set(assignment.seat_index, name);
  }

  for (const table of tables) {
    drawTable(ctx, table);

    const occupants = byTable.get(table.id);
    for (const seat of usableSeats(table)) {
      const name = occupants?.get(seat.index);
      ctx.beginPath();
      ctx.arc(seat.x, seat.y, SEAT_SIZE / 2, 0, Math.PI * 2);
      ctx.fillStyle = name ? SEAT_FILLED : SEAT_EMPTY;
      ctx.fill();
      ctx.strokeStyle = SEAT_STROKE;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const number = seatNumbers.get(seatKey(table.id, seat.index)) ?? seat.displayNumber;

      if (seatLabels === 'numbers') {
        // The number is what the meal sheet is keyed on, so it leads; the
        // name goes underneath as a cross-check where there is room.
        ctx.fillStyle = INK;
        ctx.font = '700 15px system-ui, sans-serif';
        ctx.fillText(String(number), seat.x, name ? seat.y - 5 : seat.y);
        if (name) {
          ctx.fillStyle = MUTED;
          ctx.font = '8px system-ui, sans-serif';
          ctx.fillText(shortName(name), seat.x, seat.y + 8);
        }
      } else if (name) {
        ctx.fillStyle = INK;
        ctx.font = '600 11px system-ui, sans-serif';
        const lines = nameLines(name);
        lines.forEach((line, i) => {
          ctx.fillText(line, seat.x, seat.y - (lines.length - 1) * 6 + i * 12);
        });
      } else {
        ctx.fillStyle = MUTED;
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(String(number), seat.x, seat.y);
      }
    }
  }

  ctx.restore();
  return canvas;
}

export function downloadCanvasAsPng(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filename);
    URL.revokeObjectURL(url);
  }, 'image/png');
}

export async function downloadCanvasAsPdf(canvas: HTMLCanvasElement, filename: string) {
  const { PDFDocument } = await import('pdf-lib');
  const pngBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Could not encode the plan image')); return; }
      blob.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });

  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(pngBytes);
  // A3 landscape, with the plan fitted inside a small margin.
  const pageWidth = 1190.55;
  const pageHeight = 841.89;
  const margin = 24;
  const page = pdf.addPage([pageWidth, pageHeight]);
  const fit = Math.min(
    (pageWidth - margin * 2) / image.width,
    (pageHeight - margin * 2) / image.height,
  );
  const drawWidth = image.width * fit;
  const drawHeight = image.height * fit;
  page.drawImage(image, {
    x: (pageWidth - drawWidth) / 2,
    y: (pageHeight - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  });

  const bytes = await pdf.save();
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Filesystem-safe filename stem built from the plan name. */
export function planFilename(name: string, extension: string): string {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${stem || 'seating-plan'}.${extension}`;
}
