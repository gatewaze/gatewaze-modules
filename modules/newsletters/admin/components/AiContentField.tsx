import { useState, useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { SparklesIcon, ComputerDesktopIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { supabase } from '@/lib/supabase';
import { getSupabaseConfig } from '@/config/brands';

/**
 * Optional cosmetic config from the block template's x-ai-config.
 * Helix connection details (URL, API key, project ID) live exclusively
 * in the newsletters module config and stay server-side — see the
 * helix-task-create / helix-task-embed-url / newsletter-helix-output-sync
 * edge functions.
 */
interface AiConfig {
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
}

interface AiContentFieldProps {
  fieldName: string;
  fieldSchema: {
    title?: string;
    'x-ai-config'?: AiConfig;
  };
  content: Record<string, unknown>;
  /** Block ID — used to persist the helix task_id to the DB the moment
   *  the agent task is created, so the user doesn't have to click "Save
   *  Edition" mid-research just to keep the link to the Helix task. */
  blockId?: string;
  /** Per-newsletter overrides. `helix_project_id` here takes precedence
   *  over the module-level HELIX_PROJECT_ID so different newsletters can
   *  target different Helix projects. */
  collectionMetadata?: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  onSaveEdition?: () => Promise<void>;
}

type AiTab = 'output' | 'desktop';

async function callFunction<T>(name: string, init: RequestInit): Promise<T> {
  const { url } = getSupabaseConfig();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${url}/functions/v1/${name}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `${name} failed (${res.status})`);
  return body as T;
}

export function AiContentField({ fieldName, fieldSchema, content, blockId, collectionMetadata, onChange, onSaveEdition }: AiContentFieldProps) {
  const projectIdOverride = typeof collectionMetadata?.helix_project_id === 'string'
    ? (collectionMetadata.helix_project_id as string)
    : undefined;
  const promptKey = `${fieldName}_prompt`;
  const taskIdKey = `${fieldName}_helix_task_id`;

  const projectKey = `${fieldName}_helix_project_id`;

  const outputValue = (content[fieldName] as string) || '';
  const promptValue = (content[promptKey] as string) || '';
  const helixTaskId = (content[taskIdKey] as string) || '';
  const helixProjectId = (content[projectKey] as string) || '';
  const importedAt = (content[`${fieldName}_helix_output_imported_at`] as string) || '';

  // Always default to Chat & Desktop — the agent's view is the primary
  // surface; the empty state tells new users what to do, and existing
  // tasks show the live agent. Output is one click away.
  const [activeTab, setActiveTab] = useState<AiTab>('desktop');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  // Embed/view URLs are minted server-side per task and held only in
  // component state — never persisted in block content (which would
  // expose the Helix API key embedded in the URL).
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const label = fieldSchema.title || fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const stripHtml = (html: string): string => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  };

  // Fetch a fresh embed URL whenever the task ID becomes known.
  useEffect(() => {
    if (!helixTaskId) {
      setEmbedUrl(null);
      setViewUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ task_id: helixTaskId });
        if (helixProjectId) params.set('project_id', helixProjectId);
        const data = await callFunction<{ embed_url: string; view_url: string }>(
          `helix-task-embed-url?${params}`,
          { method: 'GET' },
        );
        if (cancelled) return;
        setEmbedUrl(data.embed_url);
        setViewUrl(data.view_url);
      } catch (err) {
        if (cancelled) return;
        console.warn('helix embed-url fetch failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to load embed');
      }
    })();
    return () => { cancelled = true; };
  }, [helixTaskId, helixProjectId]);

  const onSaveEditionRef = useRef(onSaveEdition);
  useEffect(() => { onSaveEditionRef.current = onSaveEdition; }, [onSaveEdition]);

  // Keep onChange in a ref so the realtime callback always sees the
  // latest closure. Without this, flushSync re-renders the parent with
  // a new onChange prop but our subscription's captured closure still
  // points at the previous one — and the second update lands on stale
  // block.content, clobbering the first.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Live-update from the DB. Realtime fires whenever this block's row
  // changes — backend cron sync, curl, another tab, etc. — and we
  // mirror new ai_body / imported_at into local state so the editor
  // updates without a refresh. We only push fields that actually differ
  // from what we already have to avoid clobbering in-flight user edits.
  useEffect(() => {
    if (!blockId) return;
    const channel = supabase
      .channel(`newsletter-block-${blockId}`)
      .on(
        // @ts-expect-error - postgres_changes payload typing varies by client version
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'newsletters_edition_blocks',
          filter: `id=eq.${blockId}`,
        },
        (payload: { new?: { content?: Record<string, unknown> } }) => {
          const next = payload?.new?.content;
          if (!next) return;
          // BlockEditor.handleFieldChange merges into the closure'd
          // block.content, so two consecutive onChange calls in the
          // same React batch would clobber each other (the second sees
          // stale content). flushSync forces the first update to
          // commit (and BlockEditor to re-render with new content)
          // before we fire the second one.
          const incomingBody = next[fieldName];
          if (typeof incomingBody === 'string' && incomingBody !== outputValue) {
            flushSync(() => { onChangeRef.current(fieldName, incomingBody); });
          }
          const incomingImportedAt = next[`${fieldName}_helix_output_imported_at`];
          if (typeof incomingImportedAt === 'string' && incomingImportedAt !== importedAt) {
            flushSync(() => { onChangeRef.current(`${fieldName}_helix_output_imported_at`, incomingImportedAt); });
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // outputValue / importedAt are captured for the equality check;
    // onChange is read via ref so it's not in deps.
  }, [blockId, fieldName, outputValue, importedAt]);

  const handleGenerate = useCallback(async () => {
    const promptText = stripHtml(promptValue).trim();
    if (!promptText) {
      setError('Please write a prompt first');
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      // Ensure the edition + blocks are persisted before creating the
      // Helix task. Without this, the edge function can't find the block
      // row to write the task_id into. The silent flag prevents
      // navigation on new editions so the component stays mounted.
      if (onSaveEditionRef.current) {
        await onSaveEditionRef.current();
      }

      const data = await callFunction<{ task_id: string; project_id: string; embed_url: string; view_url: string; persisted: boolean }>(
        'helix-task-create',
        {
          method: 'POST',
          body: JSON.stringify({
            prompt: promptText,
            ...(projectIdOverride ? { project_id: projectIdOverride } : {}),
            ...(blockId ? { block_id: blockId, field_name: fieldName } : {}),
          }),
        },
      );
      flushSync(() => { onChangeRef.current(taskIdKey, data.task_id); });
      flushSync(() => { onChangeRef.current(promptKey, promptText); });
      if (data.project_id) {
        flushSync(() => { onChangeRef.current(projectKey, data.project_id); });
      }
      setEmbedUrl(data.embed_url);
      setViewUrl(data.view_url);
      setActiveTab('desktop');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create research task');
    } finally {
      setIsGenerating(false);
    }
  }, [promptValue, projectIdOverride, taskIdKey, promptKey]);

  const handleSyncFromHelix = useCallback(async () => {
    if (!helixTaskId) return;
    setIsSyncing(true);
    setSyncMessage(null);
    try {
      const body = await callFunction<{ results?: Array<{ task_id: string; imported: boolean; content_html?: string; reason?: string }> }>(
        'newsletter-helix-output-sync',
        {
          method: 'POST',
          body: JSON.stringify({ task_id: helixTaskId }),
        },
      );
      const result = body.results?.find((r) => r.task_id === helixTaskId);
      if (result?.imported && result.content_html) {
        onChange(fieldName, result.content_html);
        setSyncMessage('Imported! Switch to the Output tab to review.');
      } else {
        setSyncMessage(result?.reason || 'No output.html yet — agent still working.');
      }
    } catch (err: unknown) {
      setSyncMessage(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  }, [helixTaskId, fieldName, onChange]);

  const tabs: { id: AiTab; label: string; icon: React.ReactNode }[] = [
    { id: 'desktop', label: 'Chat & Desktop', icon: <ComputerDesktopIcon className="h-4 w-4" /> },
    { id: 'output', label: 'Output', icon: <SparklesIcon className="h-4 w-4" /> },
  ];

  const promptText = stripHtml(promptValue);
  const goDisabled = isGenerating || !promptText.trim();
  const goButtonTitle = !promptText.trim()
    ? 'Write a prompt first'
    : undefined;

  return (
    // min-w-0 + overflow-x-auto lets us live inside flex parents that
    // try to squish us. The inner block enforces a usable minimum
    // (320px) so labels, buttons, and the textarea never collapse below
    // a readable width — if the parent is narrower than that, the user
    // gets a horizontal scroll instead of one-letter-per-line garbage.
    <div className="mb-4 min-w-0 overflow-x-auto">
      <div className="min-w-[320px]">
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 whitespace-nowrap">
        <span className="truncate">{label}</span>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded shrink-0">
          <SparklesIcon className="h-3 w-3" /> AI
        </span>
      </label>

      {/* Prompt + Go button: always visible at the top */}
      <div className="mb-3">
        <textarea
          value={promptText}
          onChange={(e) => onChange(promptKey, e.target.value)}
          placeholder="What should Helix research?"
          rows={3}
          readOnly={!!helixTaskId}
          title={helixTaskId ? 'Locked — this prompt was already sent to Helix. Click Re-research to start a new task.' : undefined}
          className={`block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 ${
            helixTaskId
              ? 'bg-gray-50 dark:bg-gray-800/50 cursor-not-allowed'
              : 'bg-white dark:bg-gray-900'
          }`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={goDisabled}
            title={goButtonTitle}
            // Use the admin's themed `primary-*` palette rather than raw
            // `purple-*`. The admin uses Tailwind v4 with content-based
            // auto-detection — `bg-purple-600`/`bg-purple-700`/etc. are
            // not in the compiled CSS because nothing in the scanned
            // source uses them, so they render as no-bg / inherit-color
            // (effectively white-on-white). `bg-primary-*` shades ARE
            // compiled because they appear throughout the admin shell.
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded transition-colors whitespace-nowrap shrink-0 bg-primary-600 text-white ${
              goDisabled
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-primary-700'
            }`}
          >
            <SparklesIcon className="h-4 w-4 shrink-0" />
            <span>{isGenerating ? 'Starting…' : helixTaskId ? 'Re-research with Helix' : 'Research and Draft with Helix'}</span>
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400 min-w-0">
            {helixTaskId
              ? 'Prompt is locked while a task is running. Edit it by re-researching.'
              : 'Helix will browse the web and write findings into the Output tab.'}
          </span>
        </div>
        {error && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400 break-words">{error}</p>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-3 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === tab.id
                ? 'border-purple-500 text-purple-600 dark:text-purple-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'output' && (
        <div>
          <div className="flex items-center justify-between mb-2 gap-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              This is the content that will appear in the newsletter. Edit directly or generate from a prompt.
            </p>
            {helixTaskId && (
              <div className="flex items-center gap-3 shrink-0">
                {importedAt && (
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    Imported {new Date(importedAt).toLocaleTimeString()}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleSyncFromHelix}
                  disabled={isSyncing}
                  className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 dark:text-purple-400 dark:hover:text-purple-300 disabled:opacity-50"
                  title="Pull the latest output.md from Helix into this editor"
                >
                  <ArrowPathIcon className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  {isSyncing ? 'Syncing…' : importedAt ? 'Re-sync from Helix' : 'Sync from Helix'}
                </button>
              </div>
            )}
          </div>
          {syncMessage && activeTab === 'output' && (
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-2 px-2 py-1 bg-gray-50 dark:bg-gray-800/50 rounded">
              {syncMessage}
            </p>
          )}
          {/* key={importedAt} forces a remount whenever a sync writes new
           *  output.html into the block — RichTextEditor (tiptap) only reads
           *  `content` on mount, so without remounting it would ignore the
           *  realtime-updated value. Keying on importedAt (which only changes
           *  on a sync, not on user typing) preserves the user's cursor while
           *  still picking up agent updates live. */}
          <RichTextEditor
            key={importedAt || 'manual'}
            content={outputValue}
            onChange={(html) => onChange(fieldName, html)}
            className="min-h-[200px]"
          />
        </div>
      )}

      {activeTab === 'desktop' && (
        helixTaskId && embedUrl && viewUrl ? (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
                <ComputerDesktopIcon className="h-4 w-4" />
                Helix is researching…
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSyncFromHelix}
                  disabled={isSyncing}
                  className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 dark:text-purple-400 dark:hover:text-purple-300 disabled:opacity-50"
                  title="Pull output.html from Helix into the Output tab now (instead of waiting for the next sync tick)"
                >
                  <ArrowPathIcon className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  {isSyncing ? 'Syncing…' : 'Sync now'}
                </button>
                <a
                  href={viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline"
                >
                  Open in Helix ↗
                </a>
              </div>
            </div>
            {syncMessage && (
              <div className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                {syncMessage}
              </div>
            )}
            <iframe
              src={embedUrl}
              className="w-full border-0"
              style={{ height: '600px' }}
              allow="clipboard-read; clipboard-write; fullscreen"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-8 min-h-[200px] flex flex-col items-center justify-center text-center">
            <ComputerDesktopIcon className="h-10 w-10 text-gray-300 dark:text-gray-600 mb-3" />
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">No active research task</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-md">
              Write a prompt and click <span className="font-medium">Research with Helix</span> to start an agent. You'll see its desktop here as it works.
            </p>
          </div>
        )
      )}
      </div>
    </div>
  );
}
