/**
 * Badge Generation Service
 * Generates badge images for printing and digital display
 */

import { createCanvas, loadImage, registerFont } from 'canvas';
import QRCode from 'qrcode';
import { generateQrCodeUrl, EmbeddedMemberData } from './qrCode';

export interface PersonProfile {
  qrCodeId: string;
  fullName: string;
  company?: string;
  jobTitle?: string;
  avatarUrl?: string;
}

export interface EventInfo {
  eventTitle: string;
  eventLogo?: string;
  eventStart?: string;
  eventEnd?: string;
}

export interface BadgeTemplate {
  width: number;  // pixels
  height: number; // pixels
  backgroundColor: string;
  primaryColor: string;
  secondaryColor: string;
  includeQr: boolean;
  includePhoto: boolean;
  includeCompany: boolean;
  includeTitle: boolean;
  logoUrl?: string;
  backgroundImageUrl?: string;
}

/**
 * Default badge template for Brother QL-820NWB (62mm x 100mm at 300 DPI)
 */
export const DEFAULT_BADGE_TEMPLATE: BadgeTemplate = {
  width: 730,   // 62mm at 300 DPI
  height: 1181, // 100mm at 300 DPI
  backgroundColor: '#FFFFFF',
  primaryColor: '#000000',
  secondaryColor: '#666666',
  includeQr: true,
  includePhoto: true,
  includeCompany: true,
  includeTitle: true,
};

/**
 * Generate a badge image as a Buffer
 */
export async function generateBadgeImage(
  member: PersonProfile,
  event: EventInfo,
  template: Partial<BadgeTemplate> = {},
  qrToken?: string
): Promise<Buffer> {
  const config = { ...DEFAULT_BADGE_TEMPLATE, ...template };
  const { width, height } = config;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  if (config.backgroundImageUrl) {
    try {
      const bgImage = await loadImage(config.backgroundImageUrl);
      ctx.drawImage(bgImage, 0, 0, width, height);
    } catch (error) {
      // Fallback to solid color if image fails
      ctx.fillStyle = config.backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }
  } else {
    ctx.fillStyle = config.backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }

  // Event Logo (top)
  if (config.logoUrl || event.eventLogo) {
    try {
      const logo = await loadImage(config.logoUrl || event.eventLogo!);
      const logoHeight = 150;
      const logoWidth = (logo.width / logo.height) * logoHeight;
      const logoX = (width - logoWidth) / 2;
      ctx.drawImage(logo, logoX, 40, logoWidth, logoHeight);
    } catch (error) {
      console.error('Failed to load event logo:', error);
    }
  }

  // Member Avatar
  let currentY = 220;
  if (config.includePhoto && member.avatarUrl) {
    try {
      const avatar = await loadImage(member.avatarUrl);
      const avatarSize = 200;
      const avatarX = (width - avatarSize) / 2;

      // Draw circular avatar
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize / 2, currentY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatar, avatarX, currentY, avatarSize, avatarSize);
      ctx.restore();

      currentY += avatarSize + 30;
    } catch (error) {
      console.error('Failed to load avatar:', error);
      currentY += 50; // Skip avatar space
    }
  } else {
    currentY += 50;
  }

  // Member Name
  ctx.fillStyle = config.primaryColor;
  ctx.font = 'bold 48px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const nameLines = wrapText(ctx, member.fullName, width - 80);
  nameLines.forEach((line, index) => {
    ctx.fillText(line, width / 2, currentY + (index * 55));
  });
  currentY += nameLines.length * 55 + 20;

  // Company
  if (config.includeCompany && member.company) {
    ctx.font = '36px Arial';
    ctx.fillStyle = config.secondaryColor;
    const companyLines = wrapText(ctx, member.company, width - 80);
    companyLines.forEach((line, index) => {
      ctx.fillText(line, width / 2, currentY + (index * 42));
    });
    currentY += companyLines.length * 42 + 15;
  }

  // Job Title
  if (config.includeTitle && member.jobTitle) {
    ctx.font = '30px Arial';
    ctx.fillStyle = config.secondaryColor;
    const titleLines = wrapText(ctx, member.jobTitle, width - 80);
    titleLines.forEach((line, index) => {
      ctx.fillText(line, width / 2, currentY + (index * 38));
    });
    currentY += titleLines.length * 38 + 30;
  }

  // QR Code
  if (config.includeQr) {
    // Embed member data in QR code for offline scanning
    const embeddedData: EmbeddedMemberData = {
      n: member.fullName,
      ...(member.company && { c: member.company }),
      ...(member.jobTitle && { t: member.jobTitle }),
    };
    const qrUrl = generateQrCodeUrl(member.qrCodeId, qrToken, embeddedData);
    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: {
        dark: config.primaryColor,
        light: config.backgroundColor,
      },
    });

    const qrImage = await loadImage(qrDataUrl);
    const qrSize = 400;
    const qrX = (width - qrSize) / 2;
    ctx.drawImage(qrImage, qrX, currentY, qrSize, qrSize);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Wrap text to fit within a specified width
 */
function wrapText(ctx: any, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine + (currentLine ? ' ' : '') + word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Generate a PDF containing a badge (for email/download)
 */
export async function generateBadgePdf(
  member: PersonProfile,
  event: EventInfo,
  template: Partial<BadgeTemplate> = {},
  qrToken?: string
): Promise<Buffer> {
  const PDFDocument = require('pdfkit');

  return new Promise(async (resolve, reject) => {
    try {
      const badgeImage = await generateBadgeImage(member, event, template, qrToken);

      const doc = new PDFDocument({
        size: [176, 283], // 62mm x 100mm in points (1mm = 2.83465 points)
        margin: 0,
      });

      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Add badge image
      doc.image(badgeImage, 0, 0, {
        width: 176,
        height: 283,
      });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
