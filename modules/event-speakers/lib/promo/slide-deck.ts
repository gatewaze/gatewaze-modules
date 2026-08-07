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
  /** Canonical LinkedIn URL, printed on the closing slide when known. */
  linkedinUrl?: string | null;
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
        // Card .nameblock: left 64px. The SPEAKER chip is hidden in this
        // render (hideChrome), so the name block moves up into the space it
        // occupied: chip top was 168px, and the name sat 46+24px below that.
        // Card px → pt at this slide size: 1px ≈ 0.6pt (sz is pt*100).
        const textParas =
          para(inputs.name, { sz: 3350, color: 'FFFFFF', bold: true }) +
          (inputs.jobTitle ? para(inputs.jobTitle, { sz: 1500, color: 'FFFFFF', alpha: 82, spaceBeforePts: 7 }) : '') +
          (inputs.company ? para(inputs.company, { sz: 1700, color: accentBright, bold: true, spaceBeforePts: 4 }) : '') +
          para(`“${inputs.talkTitle}”`, { sz: 1300, color: 'FFFFFF', italic: true, alpha: 75, spaceBeforePts: 8 });
        shapes += textBox(px(64), ART_Y + px(168), px(640), px(300), textParas, 'Speaker details');
        // Bottom left: the speaker's LinkedIn QR code, in place of the old
        // editable social line. No caption — the code has to be big enough to
        // scan from the back of an auditorium, and a label costs vertical room
        // it needs. Sized and placed to two rules:
        //   size  — 140px of the 1200px card, so it stays legible when the
        //           slide is projected.
        //   base  — its bottom edge lines up with the brand lockup's on the
        //           right. The lockup is `.aaif { bottom: 44px }` in the
        //           landscape card, so on the 630px-tall art that is y=586.
        // Omitted entirely when we hold no LinkedIn address for the speaker.
        if (inputs.linkedinQrPng) {
          relsXml = addImageRel(relsXml, 'rIdPromoQr', '../media/promoLinkedinQr.png');
          if (!relsXml) return null;
          const qrSize = 140;
          const qrBottom = 630 - 44; // lockup baseline in card px
          shapes += picture(
            'rIdPromoQr',
            px(64),
            ART_Y + px(qrBottom - qrSize),
            px(qrSize),
            px(qrSize),
            'LinkedIn QR code',
          );
        }
      } else {
        // ── Content slides, and the closing "Connect With Me" slide ─────
        // Both share the same chrome: white page inside a thin accent
        // border, with a card-black masthead band carrying the lockup.
        const isConnectSlide = slidePaths.length > 2 && index === slidePaths.length - 1;
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
        const bodyX = inset + 228600;
        const titleY = inset + bandH + 171450;
        shapes += textBox(
          bodyX,
          titleY,
          SLIDE_W - bodyX * 2,
          685800,
          para(isConnectSlide ? 'Connect With Me' : 'Title', { sz: 2400, color: '111827', bold: true }),
          'Slide title',
        );

        if (!isConnectSlide) {
          // Body copy under the title. This slide is the one speakers
          // duplicate to build the rest of their talk, so it carries real
          // text rather than an empty box: the sizes, colour and spacing
          // here are the style they inherit on every slide they add.
          const bodyTop = titleY + 685800;
          shapes += textBox(
            bodyX,
            bodyTop,
            SLIDE_W - bodyX * 2,
            SLIDE_H - inset - 228600 - bodyTop,
            para('Body text. Replace this with your own words, and duplicate this slide for the rest of your talk.', {
              sz: 1600,
              color: '374151',
            }) +
              para('•  A short point, one line where you can', { sz: 1600, color: '374151', spaceBeforePts: 12 }) +
              para('•  Another point, kept to the same length', { sz: 1600, color: '374151', spaceBeforePts: 6 }) +
              para('•  A third, so the spacing is set for you', { sz: 1600, color: '374151', spaceBeforePts: 6 }),
            'Body',
          );
        }

        if (isConnectSlide) {
          // Big QR on the right, the speaker's own links on the left. The
          // code is sized for someone reading it from the back of a room,
          // which is the whole point of repeating it at the end of the talk.
          const qrSize = 2377440; // 2.6"
          const qrX = SLIDE_W - inset - 228600 - qrSize;
          const bodyTop = titleY + 685800;
          const bodyBottom = SLIDE_H - inset - 228600;
          const qrY = bodyTop + Math.round((bodyBottom - bodyTop - qrSize) / 2);
          if (inputs.linkedinQrPng) {
            relsXml = addImageRel(relsXml, 'rIdPromoQrEnd', '../media/promoLinkedinQr.png');
            if (!relsXml) return null;
            shapes += picture('rIdPromoQrEnd', qrX, qrY, qrSize, qrSize, 'LinkedIn QR code');
          }

          // Editable lines. LinkedIn is filled in when we know it; the rest
          // are placeholders for the speaker to replace with their own.
          const linkLine = (label: string, value: string, first = false) =>
            para(label, { sz: 1200, color: '6B7280', bold: true, spaceBeforePts: first ? 0 : 14 }) +
            para(value, { sz: 1600, color: '111827', spaceBeforePts: 2 });
          const links =
            linkLine('LINKEDIN', inputs.linkedinUrl ?? 'linkedin.com/in/your-profile', true) +
            linkLine('X', '@your-handle') +
            linkLine('WEBSITE', 'your-site.com') +
            linkLine('EMAIL', 'you@example.com');
          shapes += textBox(
            bodyX,
            bodyTop,
            qrX - bodyX - 228600,
            bodyBottom - bodyTop,
            links,
            'Connect details',
          );
        }
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
