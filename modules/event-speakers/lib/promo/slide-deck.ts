// @ts-nocheck — jszip resolved at module-host install time.

/**
 * Personalized speaker slide deck (PPTX — opens directly in Google Slides
 * and PowerPoint), v2: native, editable content styled like the speaker
 * cards instead of text baked into an image.
 *
 *   slide 1 (title):
 *     - solid card-black background + the TEXTLESS landscape card art
 *       placed undistorted (letterboxed at its true aspect, never
 *       stretched); the art keeps the SPEAKER chip, avatar bubble, wave
 *       and lockup, but no text and no date/location footer;
 *     - EDITABLE text boxes overlaid in the card's own layout/typography:
 *       name (heavy white), job title (soft white), company (accent-bright
 *       bold), talk title (italic, quoted) — positions/sizes derived from
 *       the landscape template's .nameblock CSS;
 *     - an editable social line where the footer used to sit
 *       ("@your-handle · linkedin.com/in/your-profile") for the speaker to
 *       replace with their X handle / LinkedIn URL.
 *   slides 2+ (content):
 *     - white background inside a thin accent border, with a slim
 *       card-black masthead band carrying the brand lockup, and an
 *       editable Title box below — a clean typing surface.
 *
 * The base template PPTX supplies the package skeleton (content types,
 * theme, layouts); every slide's shape tree is rewritten, which also
 * removes the old template's hard-coded logo overlays. All inserted text is
 * XML-escaped. Any structural mismatch returns null so the kit ships
 * without a deck rather than with a corrupt one.
 */

import JSZip from 'jszip';

const EMU_PER_PX = 7620; // slide width 9144000 EMU ↔ card width 1200px
const SLIDE_W = 9144000;
const SLIDE_H = 5143500;
const ART_H = 630 * EMU_PER_PX; // 4800600
const ART_Y = Math.round((SLIDE_H - ART_H) / 2); // 171450 letterbox offset

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const px = (n: number) => Math.round(n * EMU_PER_PX);

function hex(value: string | undefined, fallback: string): string {
  const v = (value ?? '').replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback;
}

let shapeId = 100;
const nextId = () => ++shapeId;

function textBox(
  x: number,
  y: number,
  w: number,
  h: number,
  paragraphs: string,
  name: string,
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

function para(
  text: string,
  opts: { sz: number; color: string; bold?: boolean; italic?: boolean; spaceBeforePts?: number; alpha?: number },
): string {
  const fill = opts.alpha
    ? `<a:solidFill><a:srgbClr val="${opts.color}"><a:alpha val="${opts.alpha * 1000}"/></a:srgbClr></a:solidFill>`
    : `<a:solidFill><a:srgbClr val="${opts.color}"/></a:solidFill>`;
  const rPr =
    `<a:rPr lang="en-US" sz="${opts.sz}"${opts.bold ? ' b="1"' : ''}${opts.italic ? ' i="1"' : ''} dirty="0">` +
    `${fill}<a:latin typeface="Red Hat Display"/><a:cs typeface="Red Hat Display"/></a:rPr>`;
  const spc = opts.spaceBeforePts ? `<a:spcBef><a:spcPts val="${opts.spaceBeforePts * 100}"/></a:spcBef>` : '';
  return `<a:p><a:pPr algn="l">${spc}<a:buNone/></a:pPr><a:r>${rPr}<a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function picture(relId: string, x: number, y: number, w: number, h: number, name: string): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${nextId()}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { fill?: string; lineColor?: string; lineWidthEmu?: number },
  name: string,
): string {
  const fill = opts.fill ? `<a:solidFill><a:srgbClr val="${opts.fill}"/></a:solidFill>` : '<a:noFill/>';
  const line = opts.lineColor
    ? `<a:ln w="${opts.lineWidthEmu ?? 12700}"><a:solidFill><a:srgbClr val="${opts.lineColor}"/></a:solidFill></a:ln>`
    : '';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

function solidBg(color: string): string {
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}

/** Replace a slide's shape tree with the given shapes, keeping the tree's
 *  group header (nvGrpSpPr + grpSpPr) intact; also (re)set the bg. */
function rebuildSlide(slideXml: string, bgXml: string, shapesXml: string): string | null {
  const treeMatch = slideXml.match(/(<p:spTree>)([\s\S]*?<\/p:grpSpPr>)([\s\S]*?)(<\/p:spTree>)/);
  if (!treeMatch) return null;
  let out = slideXml.replace(treeMatch[0], `${treeMatch[1]}${treeMatch[2]}${shapesXml}${treeMatch[4]}`);
  out = out.replace(/<p:bg>[\s\S]*?<\/p:bg>/, '');
  out = out.replace(/(<p:cSld[^>]*>)/, `$1${bgXml}`);
  return out;
}

function addImageRel(relsXml: string, relId: string, target: string): string | null {
  if (relsXml.includes(`Id="${relId}"`)) return relsXml;
  const tag = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  const out = relsXml.replace('</Relationships>', `${tag}</Relationships>`);
  return out === relsXml ? null : out;
}

export interface DeckInputs {
  /** Textless, footerless landscape card render (the title-slide art). */
  bgArtPng: Buffer;
  /** Brand lockup rasterized to PNG (white-on-transparent). */
  logoPng: Buffer | null;
  /** Logo aspect ratio (width / height); required when logoPng given. */
  logoAspect: number | null;
  accent?: string;
  accentBright?: string;
  name: string;
  jobTitle: string | null;
  company: string | null;
  talkTitle: string;
  /**
   * QR code for the speaker's LinkedIn profile, dark on white. Replaces the
   * editable social line at the bottom left of the title slide. Null when we
   * hold no LinkedIn address for this speaker, in which case the slide simply
   * omits the block rather than leaving a gap.
   */
  linkedinQrPng?: Buffer | null;
}

export async function buildSpeakerDeck(templatePptx: Buffer, inputs: DeckInputs): Promise<Buffer | null> {
  try {
    const zip = await JSZip.loadAsync(templatePptx);
    const accent = hex(inputs.accent, '0E79FD');
    const accentBright = hex(inputs.accentBright, '7DB6FF');
    const cardBlack = '020204';

    const slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
    if (slidePaths.length === 0) return null;

    zip.file('ppt/media/promoTitleBg.png', inputs.bgArtPng);
    if (inputs.logoPng) zip.file('ppt/media/promoLogo.png', inputs.logoPng);
    if (inputs.linkedinQrPng) zip.file('ppt/media/promoLinkedinQr.png', inputs.linkedinQrPng);

    for (const [index, slidePath] of slidePaths.entries()) {
      const relsPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      const slideXml = await zip.file(slidePath)?.async('string');
      let relsXml = await zip.file(relsPath)?.async('string');
      if (!slideXml || !relsXml) return null;

      let shapes = '';
      let bg = '';
      if (index === 0) {
        // ── Title slide ────────────────────────────────────────────────
        relsXml = addImageRel(relsXml, 'rIdPromoBg', '../media/promoTitleBg.png');
        if (!relsXml) return null;
        bg = solidBg(cardBlack);
        shapes += picture('rIdPromoBg', 0, ART_Y, SLIDE_W, ART_H, 'Title background');
        // Card .nameblock: left 64px, chip ~46px tall from top 168 + 24 gap.
        // Card px → pt at this slide size: 1px ≈ 0.6pt (sz is pt*100).
        const textParas =
          para(inputs.name, { sz: 3350, color: 'FFFFFF', bold: true }) +
          (inputs.jobTitle ? para(inputs.jobTitle, { sz: 1500, color: 'FFFFFF', alpha: 82, spaceBeforePts: 7 }) : '') +
          (inputs.company ? para(inputs.company, { sz: 1700, color: accentBright, bold: true, spaceBeforePts: 4 }) : '') +
          para(`“${inputs.talkTitle}”`, { sz: 1300, color: 'FFFFFF', italic: true, alpha: 75, spaceBeforePts: 8 });
        shapes += textBox(px(64), ART_Y + px(238), px(640), px(300), textParas, 'Speaker details');
        // Bottom left: the speaker's LinkedIn QR code under a short caption,
        // in place of the old editable social line. The block sits between the
        // text above and the bottom of the art, so the sizes below are what
        // fits that band. Omitted entirely when we hold no address.
        if (inputs.linkedinQrPng) {
          relsXml = addImageRel(relsXml, 'rIdPromoQr', '../media/promoLinkedinQr.png');
          if (!relsXml) return null;
          shapes += textBox(
            px(64),
            ART_Y + px(538),
            px(420),
            px(22),
            para('Connect with me on LinkedIn', { sz: 1000, color: 'FFFFFF', alpha: 70 }),
            'LinkedIn caption',
          );
          shapes += picture('rIdPromoQr', px(64), ART_Y + px(562), px(66), px(66), 'LinkedIn QR code');
        }
      } else {
        // ── Content slides ─────────────────────────────────────────────
        bg = solidBg('FFFFFF');
        const inset = 114300; // 0.125" border inset
        shapes += rect(
          inset,
          inset,
          SLIDE_W - inset * 2,
          SLIDE_H - inset * 2,
          { lineColor: accent, lineWidthEmu: 15875 }, // 1.25pt
          'Border',
        );
        const bandH = 571500; // 0.625"
        shapes += rect(inset, inset, SLIDE_W - inset * 2, bandH, { fill: cardBlack }, 'Masthead');
        if (inputs.logoPng && inputs.logoAspect) {
          relsXml = addImageRel(relsXml, 'rIdPromoLogo', '../media/promoLogo.png');
          if (!relsXml) return null;
          const logoH = 342900; // 0.375"
          const logoW = Math.round(logoH * inputs.logoAspect);
          shapes += picture('rIdPromoLogo', inset + 171450, inset + Math.round((bandH - logoH) / 2), logoW, logoH, 'Logo');
        }
        shapes += textBox(
          inset + 228600,
          inset + bandH + 171450,
          SLIDE_W - (inset + 228600) * 2,
          685800,
          para('Title', { sz: 2400, color: '111827', bold: true }),
          'Slide title',
        );
      }

      const rebuilt = rebuildSlide(slideXml, bg, shapes);
      if (!rebuilt) return null;
      zip.file(slidePath, rebuilt);
      zip.file(relsPath, relsXml);
    }

    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  } catch {
    return null;
  }
}
