// @ts-nocheck — jszip resolved at module-host install time.

/**
 * Personalized speaker slide deck (PPTX — opens directly in Google Slides
 * and PowerPoint). Takes the event's plain deck template
 * (templates/speaker-deck-template.pptx, overridable from the template
 * repo) and, for one speaker:
 *
 *   slide 1 — full-bleed background set to the promo kit's branded
 *             landscape card (the 16:9-ish title art);
 *   slide 2 — title becomes the talk title, with a smaller
 *             "Speaker — role, company" line beneath it;
 *   slide 3+ — untouched (the speaker's own content placeholders).
 *
 * PPTX is zip+OOXML, so this is targeted string surgery with JSZip — no
 * external services or Google credentials. All inserted values are
 * XML-escaped. Any structural mismatch with the template returns null so
 * the kit ships without a deck rather than with a corrupt one.
 */

import JSZip from 'jszip';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const BG_REL_ID = 'rIdPromoTitleBg';

export interface DeckInputs {
  titleCardPng: Buffer;
  talkTitle: string;
  speakerLine: string;
}

export async function buildSpeakerDeck(templatePptx: Buffer, inputs: DeckInputs): Promise<Buffer | null> {
  try {
    const zip = await JSZip.loadAsync(templatePptx);

    const slide1Path = 'ppt/slides/slide1.xml';
    const slide1RelsPath = 'ppt/slides/_rels/slide1.xml.rels';
    const slide2Path = 'ppt/slides/slide2.xml';
    const slide1 = await zip.file(slide1Path)?.async('string');
    const slide1Rels = await zip.file(slide1RelsPath)?.async('string');
    const slide2 = await zip.file(slide2Path)?.async('string');
    if (!slide1 || !slide1Rels || !slide2) return null;

    // ── slide 1: branded background ───────────────────────────────────────
    zip.file('ppt/media/promoTitleBg.png', inputs.titleCardPng);
    if (!slide1Rels.includes(BG_REL_ID)) {
      const relTag = `<Relationship Id="${BG_REL_ID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/promoTitleBg.png"/>`;
      const patchedRels = slide1Rels.replace('</Relationships>', `${relTag}</Relationships>`);
      if (patchedRels === slide1Rels) return null;
      zip.file(slide1RelsPath, patchedRels);
    }
    const bgXml =
      `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${BG_REL_ID}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
    let patchedSlide1 = slide1;
    if (!patchedSlide1.includes('<p:bg>')) {
      // <p:bg> must be the first child of <p:cSld>.
      patchedSlide1 = patchedSlide1.replace(/(<p:cSld[^>]*>)/, `$1${bgXml}`);
      if (patchedSlide1 === slide1) return null;
      zip.file(slide1Path, patchedSlide1);
    }

    // ── slide 2: talk title + speaker line ────────────────────────────────
    const titleRun = `<a:r><a:t>${escapeXml(inputs.talkTitle)}</a:t></a:r>`;
    let patchedSlide2 = slide2.replace('<a:r><a:t></a:t></a:r>', titleRun);
    if (patchedSlide2 === slide2) return null;
    const speakerPara =
      `<a:p><a:pPr indent="0" lvl="0" marL="0" rtl="0" algn="l"><a:buNone/></a:pPr>` +
      `<a:r><a:rPr sz="1600" i="0" b="0"/><a:t>${escapeXml(inputs.speakerLine)}</a:t></a:r><a:endParaRPr sz="1600"/></a:p>`;
    patchedSlide2 = patchedSlide2.replace('</p:txBody>', `${speakerPara}</p:txBody>`);
    zip.file(slide2Path, patchedSlide2);

    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  } catch {
    return null;
  }
}
