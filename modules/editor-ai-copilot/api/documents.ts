/**
 * POST /api/admin/modules/editor-ai-copilot/documents
 *
 * Phase F. Accepts file uploads (multipart/form-data) OR public URLs
 * (application/json with `url` field). Parses, stores parsed text in
 * canvas_ai_documents with a 1-hour TTL, returns `doc_id`.
 *
 * Per spec-canvas-ai-copilot.md §4.1.1.
 */

import type { Response } from 'express';
import multer from 'multer';
import { canvasAiConfig } from '../lib/canvas-ai-config.js';
import { checkDocumentRateLimit } from '../lib/rate-limiter.js';
import { safeFetchUrl, UrlFetchError } from './url-fetcher.js';
import { parseDocument } from './parsers/dispatch.js';
import { getHostAdapter } from '../lib/host-adapter-registry.js';
import type { HostKind } from '../lib/types.js';

// Structural request shape — avoiding `extends express.Request` because
// multer's bundled @types/express version sometimes resolves to a
// different express-serve-static-core than the one this module pulls in,
// triggering spurious Request<…> mismatches. We only need a handful of
// fields here, so type them directly.
interface RequestWithUser {
  userId?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  // multer injects this on the request after `upload()` resolves.
  file?: { buffer: Buffer; mimetype: string; originalname: string };
}

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface CreateDocumentsRouteDeps {
  supabase: SupabaseLike;
  logger: { warn: (msg: string, fields?: Record<string, unknown>) => void; info: (msg: string, fields?: Record<string, unknown>) => void };
}

interface RequestBody {
  url?: string;
  host_kind?: string;
  host_id?: string;
  target_id?: string;
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

export function createDocumentsRoute(deps: CreateDocumentsRouteDeps) {
  // Multer in memory — we don't persist the raw file to disk, only the
  // parsed text. Size limit set from canvasAiConfig.
  const upload = multer({
    limits: { fileSize: canvasAiConfig.maxDocUploadBytes, files: 1 },
    storage: multer.memoryStorage(),
  }).single('file');

  return function documentsHandler(req: RequestWithUser, res: Response): void {
    if (!canvasAiConfig.enabled) {
      sendError(res, 503, 'ai_provider_unavailable', 'editor-ai-copilot disabled');
      return;
    }
    const userId = req.userId;
    if (!userId) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return;
    }

    // Document-upload rate limit (separate from generate quota).
    const rate = checkDocumentRateLimit(userId);
    if (!rate.ok) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      sendError(res, 429, 'rate_limited', 'document upload rate limit exceeded', { retry_after_seconds: rate.retryAfterSec });
      return;
    }

    const rawCt = req.headers['content-type'];
    const contentType = (Array.isArray(rawCt) ? rawCt[0] ?? '' : rawCt ?? '').toLowerCase();

    if (contentType.startsWith('multipart/form-data')) {
      // File upload path. We cast req/res to `never` for the multer
      // call because multer's typings reference its own bundled
      // express-serve-static-core; the structural cast is safe because
      // multer only reads request fields it expects to be present.
      upload(req as never, res as never, async (multerErr: unknown) => {
        if (multerErr) {
          const msg = multerErr instanceof Error ? multerErr.message : String(multerErr);
          if (msg.includes('File too large')) {
            sendError(res, 413, 'document_too_large', msg);
            return;
          }
          sendError(res, 400, 'invalid_input', msg);
          return;
        }
        const body = req.body as RequestBody;
        const hostKind = body.host_kind as HostKind | undefined;
        const hostId = body.host_id;
        const targetId = body.target_id;
        if (!hostKind || !hostId || !targetId) {
          sendError(res, 400, 'invalid_input', 'host_kind, host_id, and target_id are required');
          return;
        }
        if (!getHostAdapter(hostKind)) {
          sendError(res, 400, 'invalid_input', `unknown host_kind: ${hostKind}`);
          return;
        }
        const file = req.file;
        if (!file) {
          sendError(res, 400, 'invalid_input', 'file is required');
          return;
        }
        await handleParsed(deps, res, {
          userId,
          hostKind,
          hostId,
          targetId,
          source: 'upload',
          filename: file.originalname,
          sourceUrl: null,
          mimeType: file.mimetype,
          body: file.buffer,
        });
      });
      return;
    }

    if (contentType.startsWith('application/json')) {
      // URL fetch path.
      void (async () => {
        const body = req.body as RequestBody;
        if (!body.url) {
          sendError(res, 400, 'invalid_input', 'url is required');
          return;
        }
        const hostKind = body.host_kind as HostKind | undefined;
        const hostId = body.host_id;
        const targetId = body.target_id;
        if (!hostKind || !hostId || !targetId) {
          sendError(res, 400, 'invalid_input', 'host_kind, host_id, and target_id are required');
          return;
        }
        if (!getHostAdapter(hostKind)) {
          sendError(res, 400, 'invalid_input', `unknown host_kind: ${hostKind}`);
          return;
        }
        const fetched = await safeFetchUrl(body.url);
        if (fetched instanceof UrlFetchError) {
          const statusByCode: Record<string, number> = {
            document_url_blocked: 422,
            document_not_public: 422,
            document_too_large: 413,
            document_fetch_failed: 502,
            document_fetch_timeout: 504,
          };
          sendError(res, statusByCode[fetched.code] ?? 502, fetched.code, fetched.message, fetched.details);
          return;
        }
        await handleParsed(deps, res, {
          userId,
          hostKind,
          hostId,
          targetId,
          source: 'url',
          filename: deriveFilenameFromUrl(fetched.finalUrl),
          sourceUrl: fetched.finalUrl,
          mimeType: fetched.contentType,
          body: fetched.body,
        });
      })();
      return;
    }

    sendError(res, 400, 'invalid_input', `unsupported Content-Type: ${contentType}`);
  };
}

interface HandleParsedArgs {
  userId: string;
  hostKind: HostKind;
  hostId: string;
  targetId: string;
  source: 'upload' | 'url';
  filename: string;
  sourceUrl: string | null;
  mimeType: string;
  body: Buffer;
}

async function handleParsed(
  deps: CreateDocumentsRouteDeps,
  res: Response,
  args: HandleParsedArgs,
): Promise<void> {
  const parsed = await parseDocument(args.body, args.mimeType, {
    filename: args.filename,
    ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
  });
  if (!parsed.ok) {
    if (parsed.reason.startsWith('document_unsupported_type')) {
      sendError(res, 400, 'document_unsupported_type', parsed.reason);
      return;
    }
    sendError(res, 422, 'document_parse_failed', parsed.reason);
    return;
  }

  const warnings = [...parsed.warnings];
  let text = parsed.text;
  if (text.length > canvasAiConfig.maxDocChars) {
    warnings.push(`document_truncated: cut to ${canvasAiConfig.maxDocChars} chars`);
    text = text.slice(0, canvasAiConfig.maxDocChars) + '\n[truncated]';
  }

  const expiresAt = new Date(Date.now() + canvasAiConfig.docTtlMs).toISOString();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insert = await (deps.supabase.from('canvas_ai_documents') as any)
      .insert({
        user_id: args.userId,
        host_kind: args.hostKind,
        host_id: args.hostId,
        target_id: args.targetId,
        source: args.source,
        filename: args.filename,
        source_url: args.sourceUrl,
        mime_type: args.mimeType,
        extracted_text: text,
        extracted_chars: text.length,
        byte_size: args.body.byteLength,
        warnings,
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (insert.error) {
      sendError(res, 500, 'internal_error', insert.error.message ?? 'insert failed');
      return;
    }
    const docId = (insert.data as { id: string }).id;
    res.status(201).json({
      doc_id: docId,
      filename: args.filename,
      source: args.source,
      extracted_chars: text.length,
      extracted_tokens_approx: Math.ceil(text.length / 4),
      warnings,
      expires_at: expiresAt,
    });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

function deriveFilenameFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    // Google Doc export URLs always end in /export(?format=txt|/txt)
    if (url.host === 'docs.google.com' && url.pathname.includes('/export')) {
      const idMatch = url.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
      return `google-doc-${idMatch?.[1] ?? 'unknown'}.txt`;
    }
    const lastSegment = url.pathname.split('/').filter(Boolean).pop();
    if (lastSegment && lastSegment.includes('.')) return lastSegment;
    return `${url.hostname}.html`;
  } catch {
    return 'untitled';
  }
}
