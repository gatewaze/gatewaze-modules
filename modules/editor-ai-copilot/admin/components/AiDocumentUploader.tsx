/**
 * Phase F — document upload + URL ingestion UI for the AI sidebar
 * pane. Renders inside <AiSidebarPane> below the prompt textarea.
 *
 * Supports drag-and-drop file uploads + paste-a-URL. Each accepted
 * doc shows filename + a remove button. Uploaded doc_ids are kept
 * in component state and passed into the generate call.
 */

import { useCallback, useState } from 'react';
import { CanvasAiService, type HostKind, type AiServiceError } from '../services/canvasAiService.js';

export interface AttachedDoc {
  doc_id: string;
  filename: string;
  source: 'upload' | 'url';
}

export interface AiDocumentUploaderProps {
  hostKind: HostKind;
  hostId: string;
  targetId: string;
  attached: ReadonlyArray<AttachedDoc>;
  onAttach: (doc: AttachedDoc) => void;
  onRemove: (docId: string) => void;
  maxDocs?: number;
}

export function AiDocumentUploader(props: AiDocumentUploaderProps) {
  const maxDocs = props.maxDocs ?? 5;
  const [tab, setTab] = useState<'file' | 'url'>('file');
  const [url, setUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<AiServiceError | null>(null);

  const atLimit = props.attached.length >= maxDocs;

  const handleFile = useCallback(
    async (file: File) => {
      if (atLimit) {
        setError({
          code: 'too_many_docs',
          message: `max ${maxDocs} documents per generation`,
          httpStatus: 400,
        });
        return;
      }
      setUploading(true);
      setError(null);
      try {
        const r = await CanvasAiService.uploadDocument({
          file,
          host_kind: props.hostKind,
          host_id: props.hostId,
          target_id: props.targetId,
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        props.onAttach({ doc_id: r.doc_id, filename: r.filename, source: 'upload' });
      } finally {
        setUploading(false);
      }
    },
    [atLimit, maxDocs, props],
  );

  const handleUrl = useCallback(async () => {
    if (!url.trim()) return;
    if (atLimit) {
      setError({
        code: 'too_many_docs',
        message: `max ${maxDocs} documents per generation`,
        httpStatus: 400,
      });
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const r = await CanvasAiService.uploadDocumentFromUrl({
        url: url.trim(),
        host_kind: props.hostKind,
        host_id: props.hostId,
        target_id: props.targetId,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      props.onAttach({ doc_id: r.doc_id, filename: r.filename, source: 'url' });
      setUrl('');
    } finally {
      setUploading(false);
    }
  }, [url, atLimit, maxDocs, props]);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  return (
    <div className="ai-doc-uploader">
      <div className="ai-doc-uploader__tabs">
        <button type="button" onClick={() => setTab('file')} disabled={tab === 'file'}>From file</button>
        <button type="button" onClick={() => setTab('url')} disabled={tab === 'url'}>From URL</button>
      </div>
      {tab === 'file' && (
        <div
          className="ai-doc-uploader__dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <label>
            <input
              type="file"
              accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
              disabled={uploading || atLimit}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <span>Drag a PDF, DOCX, Markdown, or text file — or click to pick.</span>
          </label>
        </div>
      )}
      {tab === 'url' && (
        <div className="ai-doc-uploader__urlbox">
          <input
            type="url"
            placeholder="https:// or a public Google Doc share URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={uploading || atLimit}
          />
          <button type="button" onClick={() => void handleUrl()} disabled={uploading || atLimit || !url.trim()}>
            {uploading ? 'Fetching…' : 'Attach'}
          </button>
          {url.includes('docs.google.com') && (
            <p className="ai-doc-uploader__hint">
              Looks like a Google Doc — make sure sharing is set to &ldquo;Anyone with the link&rdquo;.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="ai-doc-uploader__error">
          {error.code}: {error.message}
        </p>
      )}
      {props.attached.length > 0 && (
        <ul className="ai-doc-uploader__list">
          {props.attached.map((d) => (
            <li key={d.doc_id}>
              <span>{d.filename}</span>
              <button type="button" onClick={() => props.onRemove(d.doc_id)} aria-label={`Remove ${d.filename}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
