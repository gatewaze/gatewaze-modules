/**
 * Google Doc Fetcher
 * Fetches a Google Doc via the Docs API v1 and converts the flat structural
 * elements into a nested section tree based on heading levels.
 */

import { getGoogleAuth, hasOAuthConfig, getApiKey } from './google-auth.ts';

const DOCS_API_BASE = 'https://docs.googleapis.com/v1/documents';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';
const DOCS_EXPORT_BASE = 'https://docs.google.com/document/d';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocSection {
  heading: string;
  headingLevel: number;
  paragraphs: DocParagraph[];
  subsections: DocSection[];
}

export interface DocParagraph {
  text: string;
  links: Array<{ text: string; url: string }>;
  formatting: { bold: boolean; italic: boolean };
  listType?: 'bullet' | 'numbered';
  images?: Array<{ objectId: string; contentUri: string; alt?: string }>;
}

export interface FetchedDoc {
  title: string;
  sections: DocSection[];
  inlineImages: Map<string, { contentUri: string; mimeType: string }>;
  textSizeBytes: number;
  /** Raw HTML from public export — set when using the HTML fallback path */
  rawHtml?: string;
}

// ---------------------------------------------------------------------------
// Heading level mapping
// ---------------------------------------------------------------------------

const HEADING_MAP: Record<string, number> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

// ---------------------------------------------------------------------------
// Core fetcher
// ---------------------------------------------------------------------------

export async function fetchGoogleDoc(docId: string): Promise<FetchedDoc> {
  // Try the structured Docs API first (requires auth)
  const hasAuth = hasOAuthConfig() || !!getApiKey();

  if (hasAuth) {
    try {
      const auth = await getGoogleAuth();
      const params = new URLSearchParams(auth.queryParams);
      const url = `${DOCS_API_BASE}/${docId}${params.toString() ? '?' + params : ''}`;

      const response = await fetch(url, { headers: auth.headers });

      if (response.ok) {
        const doc = await response.json();
        return parseGoogleDoc(doc);
      }

      // If 401/403, fall through to public export
      if (response.status !== 401 && response.status !== 403) {
        if (response.status === 404) throw new Error(`Google Doc not found: ${docId}`);
        throw new Error(`Google Docs API error (${response.status}): ${await response.text()}`);
      }
      console.log('[gdoc-import] Docs API auth failed, falling back to public HTML export');
    } catch (err) {
      if ((err as Error).message?.includes('not found')) throw err;
      console.log('[gdoc-import] Docs API failed, trying public export:', (err as Error).message);
    }
  }

  // Fallback: fetch the publicly shared doc as HTML (no auth needed)
  return fetchPublicDocAsHtml(docId);
}

/**
 * Fetch a publicly shared Google Doc via the /export?format=html endpoint.
 * This works without any API key or OAuth for docs with "Anyone with the link" sharing.
 */
async function fetchPublicDocAsHtml(docId: string): Promise<FetchedDoc> {
  const exportUrl = `${DOCS_EXPORT_BASE}/${docId}/export?format=html`;

  const response = await fetch(exportUrl, {
    redirect: 'follow',
  });

  if (!response.ok) {
    if (response.status === 404) throw new Error(`Google Doc not found: ${docId}`);
    if (response.status === 401 || response.status === 403) {
      throw new Error('This Google Doc is not publicly shared. Either share the doc with "Anyone with the link" or configure Google OAuth credentials.');
    }
    throw new Error(`Google Doc export failed (${response.status})`);
  }

  const html = await response.text();
  const doc = parseGoogleDocHtml(html);
  // Attach raw HTML so the caller can pass it directly to the AI
  // when the section tree parsing doesn't produce good results
  doc.rawHtml = html;
  return doc;
}

/**
 * Parse exported Google Doc HTML into our section tree structure.
 * Google's HTML export preserves headings, paragraphs, links, lists, and basic formatting.
 */
function parseGoogleDocHtml(html: string): FetchedDoc {
  // Extract title from <title> tag
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  // Extract body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  interface FlatItem {
    headingLevel: number;
    heading: string;
    paragraph: DocParagraph;
  }

  const flatParagraphs: FlatItem[] = [];
  let totalTextSize = 0;

  // Parse HTML elements — headings and paragraphs
  // Google Doc HTML uses <h1>-<h6> for headings and <p> for text
  const elementRegex = /<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;

  while ((match = elementRegex.exec(body)) !== null) {
    const [, tagName, innerHtml] = match;
    const tag = tagName.toLowerCase();

    // Extract text content (strip inner tags for plain text)
    const plainText = innerHtml.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    if (!plainText) continue;

    totalTextSize += plainText.length;

    // Extract links
    const links: Array<{ text: string; url: string }> = [];
    const linkRegex = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(innerHtml)) !== null) {
      const url = linkMatch[1].replace(/&amp;/g, '&');
      const linkText = linkMatch[2].replace(/<[^>]+>/g, '').trim();
      if (url && linkText) links.push({ text: linkText, url });
    }

    // Detect formatting
    const hasBold = /<(b|strong)[^>]*>/i.test(innerHtml);
    const hasItalic = /<(i|em)[^>]*>/i.test(innerHtml);

    const headingLevel = tag.startsWith('h') ? parseInt(tag[1]) : 0;

    flatParagraphs.push({
      headingLevel,
      heading: headingLevel > 0 ? plainText : '',
      paragraph: {
        text: plainText,
        links,
        formatting: { bold: hasBold, italic: hasItalic },
        listType: tag === 'li' ? 'bullet' : undefined,
      },
    });
  }

  const sections = buildSectionTree(flatParagraphs);

  return {
    title,
    sections,
    inlineImages: new Map(), // HTML export embeds images as base64 — skip for now
    textSizeBytes: totalTextSize,
  };
}

/**
 * List all Google Docs in a Drive folder.
 */
export async function listDocsInFolder(folderId: string): Promise<Array<{ id: string; name: string; createdTime: string }>> {
  const auth = await getGoogleAuth();
  const docs: Array<{ id: string; name: string; createdTime: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: 'nextPageToken,files(id,name,createdTime)',
      orderBy: 'name',
      pageSize: '100',
      ...auth.queryParams,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(`${DRIVE_API_BASE}?${params}`, {
      headers: auth.headers,
    });

    if (!response.ok) {
      throw new Error(`Google Drive API error (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    docs.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return docs;
}

// ---------------------------------------------------------------------------
// Parser: Google Docs JSON → section tree
// ---------------------------------------------------------------------------

function parseGoogleDoc(doc: any): FetchedDoc {
  const content: any[] = doc.body?.content || [];
  const inlineObjects: Record<string, any> = doc.inlineObjects || {};

  // Build image map
  const inlineImages = new Map<string, { contentUri: string; mimeType: string }>();
  for (const [objectId, obj] of Object.entries(inlineObjects)) {
    const props = (obj as any)?.inlineObjectProperties?.embeddedObject;
    if (props?.imageProperties?.contentUri) {
      inlineImages.set(objectId, {
        contentUri: props.imageProperties.contentUri,
        mimeType: props.imageProperties.sourceUri ? 'image/png' : 'image/png',
      });
    }
  }

  // Flatten structural elements into paragraphs with heading info
  interface FlatParagraph {
    headingLevel: number; // 0 = normal text
    heading: string;
    paragraph: DocParagraph;
  }

  const flatParagraphs: FlatParagraph[] = [];
  let totalTextSize = 0;

  for (const element of content) {
    if (!element.paragraph) continue;

    const para = element.paragraph;
    const namedStyle = para.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
    const headingLevel = HEADING_MAP[namedStyle] || 0;

    // Extract text runs
    const runs: any[] = para.elements || [];
    let fullText = '';
    const links: Array<{ text: string; url: string }> = [];
    const images: Array<{ objectId: string; contentUri: string; alt?: string }> = [];
    let hasBold = false;
    let hasItalic = false;

    for (const run of runs) {
      if (run.textRun) {
        const text = run.textRun.content || '';
        fullText += text;
        totalTextSize += text.length;

        const style = run.textRun.textStyle || {};
        if (style.bold) hasBold = true;
        if (style.italic) hasItalic = true;

        if (style.link?.url) {
          links.push({ text: text.trim(), url: style.link.url });
        }
      }

      if (run.inlineObjectElement) {
        const objectId = run.inlineObjectElement.inlineObjectId;
        const imageData = inlineImages.get(objectId);
        if (imageData) {
          images.push({
            objectId,
            contentUri: imageData.contentUri,
          });
        }
      }
    }

    // Determine list type
    let listType: 'bullet' | 'numbered' | undefined;
    if (para.bullet) {
      // Google Docs uses nestingLevel and glyphType for lists
      const glyph = para.bullet.listProperties?.nestingLevels?.[0]?.glyphType;
      listType = glyph && /DECIMAL|ALPHA|ROMAN/i.test(glyph) ? 'numbered' : 'bullet';
    }

    const trimmedText = fullText.trim();
    if (!trimmedText && images.length === 0) continue;

    flatParagraphs.push({
      headingLevel,
      heading: headingLevel > 0 ? trimmedText : '',
      paragraph: {
        text: trimmedText,
        links,
        formatting: { bold: hasBold, italic: hasItalic },
        listType,
        images: images.length > 0 ? images : undefined,
      },
    });
  }

  // Build nested section tree
  const sections = buildSectionTree(flatParagraphs);

  return {
    title: doc.title || 'Untitled',
    sections,
    inlineImages,
    textSizeBytes: totalTextSize,
  };
}

function buildSectionTree(flatParagraphs: Array<{ headingLevel: number; heading: string; paragraph: DocParagraph }>): DocSection[] {
  const root: DocSection = { heading: '', headingLevel: 0, paragraphs: [], subsections: [] };
  const stack: DocSection[] = [root];

  for (const item of flatParagraphs) {
    if (item.headingLevel > 0) {
      // Pop stack until we find a parent with lower heading level
      while (stack.length > 1 && stack[stack.length - 1].headingLevel >= item.headingLevel) {
        stack.pop();
      }

      const section: DocSection = {
        heading: item.heading,
        headingLevel: item.headingLevel,
        paragraphs: [],
        subsections: [],
      };

      stack[stack.length - 1].subsections.push(section);
      stack.push(section);
    } else {
      // Regular paragraph — add to current section
      stack[stack.length - 1].paragraphs.push(item.paragraph);
    }
  }

  // If there are top-level paragraphs before any heading, include them
  if (root.paragraphs.length > 0) {
    return [
      { heading: 'Introduction', headingLevel: 1, paragraphs: root.paragraphs, subsections: [] },
      ...root.subsections,
    ];
  }

  return root.subsections;
}
