/**
 * Newsletter edition editor — Puck-powered alternative to EditionCanvas.
 *
 * Per spec-builder-evaluation §3.6: ONE editor across email + website
 * channels. This component is a controlled wrapper that reuses the
 * sites-module Puck adapter (PuckConfigAdapter, render-block-client)
 * with newsletter-shaped data via a small bidirectional adapter
 * (`editionToPuckData` / `puckDataToEdition`).
 *
 * Why not refactor PuckCanvasEditor directly? The sites component is
 * uncontrolled (loads from server, manages locks, diffs against a
 * baseline). Newsletter editions are CONTROLLED — parent owns the
 * NewsletterEdition state and persistence. A controlled wrapper is
 * cleaner than threading two persistence strategies into one
 * component.
 *
 * Phase D++ scope: edit / save round-trip via parent. Per-edition lock
 * semantics, real-time collab, undo/redo come later (current
 * EditionCanvas doesn't have them either).
 */

import { useEffect, useMemo, useRef, useState, type FC, type ReactElement, type ReactNode, type CSSProperties } from 'react';
import {
  type Config,
  ActionBar,
  createUsePuck,
} from '@puckeditor/core';
import {
  PencilSquareIcon,
  CodeBracketIcon,
  ArrowDownTrayIcon,
  ClipboardDocumentIcon,
  GlobeAltIcon,
  PaperAirplaneIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  buildPuckConfig,
  type PuckRenderHost,
} from '../../../../sites/admin/components/canvas/puck/PuckConfigAdapter.js';
import { renderBlockClient, type BlockTemplateLookup } from '../../../../sites/admin/components/canvas/puck/render-block-client.js';
import type {
  BlockDefRow,
  BrickDefRow,
} from '../../../../sites/admin/components/canvas/puck/types.js';
import type {
  NewsletterEdition,
  BlockTemplate,
  BrickTemplate,
} from '../../utils/types.js';
import { editionToPuckData, puckDataToEdition } from './edition-puck-adapter.js';
import { buildEmailRegistry } from './email-blocks/declarative/registry.js';
import { mergeRegistryIntoConfig } from './email-blocks/merge-into-config.js';
import { BlockSearchComponents } from './block-search.js';
import { exportEditionHtml } from './email-blocks/export-edition-html.js';
import { CanvasShell } from '../../../../sites/admin/components/canvas/puck/CanvasShell.js';
import { buildAiBlockDefs } from './email-blocks/build-ai-block-defs.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { useHasModule } from '@/hooks/useModuleFeature';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { getSupabaseConfig } from '@/config/brands';
import { NewsletterEditingProvider } from './NewsletterEditingContext.js';
import { EmailSizeIndicator } from '../EmailSizeIndicator.js';
import { UserBlocksProvider, useUserBlocks } from './user-blocks/UserBlocksContext.js';
import { SaveAsBlockAction } from './user-blocks/SaveAsBlockAction.js';
import { MyBlocksPanel } from './user-blocks/MyBlocksPanel.js';

interface NewsletterPuckCanvasProps {
  edition: NewsletterEdition;
  blockTemplates: ReadonlyArray<BlockTemplate>;
  brickTemplates: ReadonlyArray<BrickTemplate>;
  onChange: (next: NewsletterEdition) => void;
  onSave?: (options?: { silent?: boolean }) => Promise<void> | void;
  isSaving?: boolean;
  /**
   * react-email registry components to enable for this edition. Maps
   * `templates_block_defs.component_id` values that the parent loader
   * found in the bound library. When undefined, all registry entries
   * are exposed (useful for development; production wires the parent
   * loader to filter by what's actually in the library). Per
   * spec-builder-evaluation §3.6 (extended).
   */
  enabledRegistryComponentIds?: ReadonlyArray<string>;
  /**
   * Per-newsletter overrides forwarded to inline custom Puck fields via
   * NewsletterEditingContext — currently consumed only by the Helix AI
   * field on the HelixAiContent block (`helix_project_id` override) but
   * intentionally generic so future module-level integrations can read
   * the same shape without re-plumbing.
   */
  collectionMetadata?: Record<string, unknown>;
  /**
   * Newsletter collection id — used to scope user-saved blocks. When
   * absent, scoping falls back to the edition id (so user blocks
   * effectively become per-edition rather than per-newsletter).
   */
  collectionId?: string;
  /**
   * Declarative wrapper template HTML from the newsletter's repo
   * (templates_wrappers row, key='default'). Threaded into every
   * exportEditionHtml call so preview, send, and publish all render inside
   * the same wrapper.
   */
  wrapperTemplate?: string | null;
}

export const NewsletterPuckCanvas: FC<NewsletterPuckCanvasProps> = (props) => {
  // Per-newsletter scope for user-saved blocks. v1 uses localStorage
  // keyed on this id (see user-blocks/storage.ts); a follow-up can
  // swap the storage to the newsletter collection's metadata column
  // without changing call sites.
  const userBlocksScope = props.collectionId ?? props.edition.id;
  return (
    <UserBlocksProvider scopeId={userBlocksScope}>
      <NewsletterPuckCanvasInner {...props} />
    </UserBlocksProvider>
  );
};

const NewsletterPuckCanvasInner: FC<NewsletterPuckCanvasProps> = ({
  edition,
  blockTemplates,
  brickTemplates,
  onChange,
  onSave,
  isSaving,
  enabledRegistryComponentIds,
  collectionMetadata,
  collectionId,
  wrapperTemplate,
}) => {
  // Default false so the Publish button renders enabled when the
  // parent doesn't thread the saving state through.
  const isSavingNow = isSaving ?? false;

  // Wrapper template HTML. Prefer the prop; if the parent hasn't threaded it
  // yet (load-order), fetch the latest templates_wrappers row for this
  // collection's library so the canvas preview / export / send all render
  // inside the same chrome.
  const [resolvedWrapper, setResolvedWrapper] = useState<string | null>(wrapperTemplate ?? null);
  useEffect(() => {
    if (wrapperTemplate !== undefined) { setResolvedWrapper(wrapperTemplate); return; }
    if (!collectionId) { setResolvedWrapper(null); return; }
    let cancelled = false;
    void supabase
      .from('templates_wrappers')
      .select('html, is_current')
      .eq('library_id', collectionId)
      .eq('key', 'default')
      .eq('is_current', true)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setResolvedWrapper((data?.html as string | undefined) ?? null);
      });
    return () => { cancelled = true; };
  }, [wrapperConfig, collectionId]);

  // Per-edition registry: the static code blocks + this newsletter's
  // declarative (git-authored) blocks. Superset of the static registry, so
  // newsletters without declarative blocks are unchanged.
  const registry = useMemo(() => buildEmailRegistry(blockTemplates, brickTemplates), [blockTemplates, brickTemplates]);

  // Adapt newsletter templates → sites' BlockDefRow / BrickDefRow shape
  // so we can reuse the existing Puck Config builder. Memoised — these
  // change rarely (only when the library reloads).
  const { blockDefs, brickDefs, lookup } = useMemo(() => {
    // Skip any mustache block_def whose block_type has a native react-email
    // registry component — the registry block takes over (in the editor here
    // and in the export via buildBlockMeta), so we don't build a shadowing
    // mustache component for it. This is how a legacy block is "converted":
    // ship the registry component with componentId === block_type.
    const bd: BlockDefRow[] = blockTemplates
      .filter((t) => !registry.has(t.block_type))
      .map((t) => ({
      id: t.id,
      key: t.block_type,
      name: t.name,
      schema: (t.content.schema ?? {}) as Record<string, unknown>,
      html: t.content.html_template ?? '',
      has_bricks: t.content.has_bricks ?? false,
      is_current: true,
      // Newsletter blocks are always email-channel.
      theme_kind: 'email',
    }));
    const br: BrickDefRow[] = brickTemplates
      .filter((t) => !registry.has(t.brick_type))
      .map((t) => ({
      id: t.id,
      key: t.brick_type,
      name: t.name,
      // No parent linkage in the newsletter shape — bricks are
      // declared per-template. We allow any brick in any has_bricks
      // block by setting a synthetic parent key shared by all blocks.
      parent_block_def_key: '*',
      parent_block_def_id: '*',
      schema: (t.content.schema ?? {}) as Record<string, unknown>,
      html: t.content.html_template ?? '',
      is_current: true,
      theme_kind: 'email',
    }));
    const tplLookup: BlockTemplateLookup = {
      byKey: new Map([
        ...bd.map((d) => [d.key, { html: d.html, schema: d.schema }] as const),
        ...br.map((b) => [b.key, { html: b.html, schema: b.schema }] as const),
      ]),
    };
    return { blockDefs: bd, brickDefs: br, lookup: tplLookup };
  }, [blockTemplates, brickTemplates, registry]);

  const renderHost: PuckRenderHost = useMemo(
    () => ({
      renderBlock: ({ blockDefKey, content, variantKey }): ReactElement => {
        const result = renderBlockClient({ blockDefKey, content, variantKey, lookup });
        return (
          <div
            className="puck-block-rendered"
            data-block-key={blockDefKey}
            dangerouslySetInnerHTML={{ __html: result.html }}
          />
        );
      },
      // Newsletter editor doesn't have host-media for inline images yet —
      // image fields fall back to a URL prompt, matching the legacy
      // newsletter behaviour. Phase D++ may wire this to the existing
      // edition image-upload utility.
      showMediaPicker: (cb) => {
        const url = window.prompt('Image URL');
        if (url) cb(url);
      },
    }),
    [lookup],
  );

  const config = useMemo(() => {
    const base = buildPuckConfig({
      libraryId: edition.id, // edition id ⇒ per-edition Config namespace
      blockDefs,
      brickDefs,
      wrappers: [],
      themeKind: 'email',
      renderHost,
    });
    // Layer the react-email registry on top — those entries' `render`
    // returns real email-safe JSX (via @react-email/components) instead
    // of going through the Mustache + iframe-string path.
    const enabledSet = enabledRegistryComponentIds
      ? new Set(enabledRegistryComponentIds)
      : undefined;
    const merged = mergeRegistryIntoConfig({
      base: base.config,
      registry: registry,
      renderHost,
      ...(enabledSet ? { enabledComponentIds: enabledSet } : {}),
    });
    // Replace the canvas root.render with a newsletter-specific shell
    // that:
    //   - injects baseline CSS into the Puck iframe (font-family,
    //     html/body reset, the 600px-max white "email card" with a
    //     subtle shadow, padding around it)
    //   - reads `previewMode` from Puck's metadata at render time so
    //     a light↔dark toggle is picked up without rebuilding the
    //     Config (rebuilding would re-mount Puck and lose selection).
    //   - wraps the canvas children in `<div class="gw-email-card">`
    //     so the inserted blocks visually sit inside the email frame
    //     the operator is composing.
    const cfg = merged.config as Config;
    const finalConfig: Config = {
      ...cfg,
      root: {
        ...((cfg.root ?? {}) as Record<string, unknown>),
        render: NewsletterCanvasRoot as never,
      },
    } as Config;
    return { ...base, config: finalConfig, registryCollisions: merged.collisions };
  }, [edition.id, blockDefs, brickDefs, renderHost, enabledRegistryComponentIds, registry]);

  const [data, setData] = useState(() => editionToPuckData(edition, registry));
  // previewMode (light/dark) state lives inside CanvasShell now — it
  // owns the Sun/Moon portal AND threads previewMode into Puck's
  // metadata so the canvas root sees `puck.metadata.previewMode` and
  // re-renders the email backdrop on toggle. No state here.
  const [exportBusy, setExportBusy] = useState<null | 'email' | 'substack' | 'beehiiv'>(null);
  // Toggles between the WYSIWYG Puck canvas and a read-only HTML view
  // (the same email-safe markup the recipient would see). Useful for
  // operators who want to inspect / copy the source without leaving
  // the editor. State lives here so flipping doesn't unmount Puck —
  // we keep the WYSIWYG node rendered but visually hidden and overlay
  // a code panel on top of it; that way switching back doesn't lose
  // selection / undo history / scroll position.
  const [view, setView] = useState<'wysiwyg' | 'html'>('wysiwyg');
  const [htmlSource, setHtmlSource] = useState<string>('');
  const [htmlBuilding, setHtmlBuilding] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  // Test Send: minimal inline picker — operator types a recipient,
  // we render the current draft's email HTML and POST it to the
  // newsletters api which fans out to SendGrid. Subject lands as
  // "[TEST] <edition title>" so the inbox is unambiguous.
  const [testSendOpen, setTestSendOpen] = useState(false);
  const [testSendEmail, setTestSendEmail] = useState('');
  const [testSendBusy, setTestSendBusy] = useState(false);

  // Live Gmail-clipping size indicator. Re-render exportEditionHtml on
  // a debounced idle so we can show "X.X KB" + the 90/102 KB warnings
  // while editing — not just in the HTML preview tab. exportEditionHtml
  // is the same path used by Send + HTML export, so the count matches
  // what actually goes out (incl. boilerplate). Debounce avoids running
  // the renderer on every keystroke; we only need a refresh after the
  // operator pauses.
  const [emailSizeBytes, setEmailSizeBytes] = useState<number | null>(null);

  // Pull the AI Puck plugin via dynamic import + pass through
  // `extraPlugins`. The original design used a shared canvas-puck-plugin-
  // registry (sites/admin/.../canvas-puck-plugin-registry.ts) into which
  // editor-ai-copilot's admin/index.ts would push its plugin as a
  // side-effect. Rollup tree-shook the side-effect call out of the
  // production bundle no matter how we annotated it (sideEffects in
  // package.json, namespace import + globalThis pin, moduleSideEffects:
  // 'no-treeshake' from the resolver — verified empirically v1.2.47
  // through v1.2.51). The aiPlugin object literal survived but the
  // register call didn't, so the registry stayed empty in prod.
  //
  // Dynamic import sidesteps the whole tree-shake question: the chunk
  // is always emitted, the await always runs, and we wire the plugin
  // into CanvasShell's existing extraPlugins prop. Catch swallows the
  // import error on brands that don't have editor-ai-copilot installed
  // so the editor still mounts (without an AI tab).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [aiCopilotPlugins, setAiCopilotPlugins] = useState<ReadonlyArray<any>>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await import('@gatewaze-modules/editor-ai-copilot/admin' as any);
        if (cancelled) return;
        if (mod && mod.aiPlugin) setAiCopilotPlugins([mod.aiPlugin]);
      } catch {
        // editor-ai-copilot not in this brand's MODULE_SOURCES — fine.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Publish flow:
  //   1. Confirm with the operator (the act is recipient-visible).
  //   2. Save the edition to the database first so the publish-to-
  //      git endpoint can find a row whose blocks match what's on
  //      screen.
  //   3. POST to /api/admin/newsletters/editions/:id/publish-to-git,
  //      which renders the edition into editions/<id>.html +
  //      editions/<id>.json on the publish branch of the per-
  //      newsletter internal git repo.
  // Status flips to 'published' server-side as part of the endpoint
  // (not done here) — until Publish is clicked the edition stays
  // as 'draft'.
  const handlePublish = async () => {
    if (publishBusy || !edition) return;
    if (typeof window !== 'undefined' && !window.confirm(
      `Publish "${edition.subject || 'this edition'}"?\n\nThis will write the edition to the newsletter's git repository and mark it as published. Recipients on subsequent sends will see this content.`,
    )) {
      return;
    }
    setPublishBusy(true);
    try {
      if (onSave) {
        await onSave({ silent: true });
      }
      // Render the edition HTML client-side. The publish-to-git
      // endpoint used to render server-side via EditionEmail, but
      // that path pulls the admin's email-blocks barrel — which
      // transitively requires Puck + heroicons + sonner + the admin's
      // RichTextEditor (via the `@/` alias), none of which resolve
      // in the API container. Producing the HTML here uses the same
      // exportEditionHtml path as the Send and HTML-export buttons.
      const publishMeta = buildBlockMeta();
      const publishHtml = await exportEditionHtml({
        edition,
        format: 'email',
        blockMeta: publishMeta,
        wrapperTemplate: resolvedWrapper, registry,
        // The published page is the online version — drop the redundant
        // "View Online" self-link from its header.
        hideViewOnline: true,
        pretty: false,
      });
      // Send the EFFECTIVE render path per block so the published
      // edition.json reflects how the HTML was actually produced (react-email
      // via the registry), not the stale templates_block_defs.render_kind the
      // git-HTML import recorded.
      const blockRender = edition.blocks.map((b) => {
        const m = publishMeta.get(b.id);
        return {
          id: b.id,
          render_kind: m?.render_kind ?? 'mustache',
          component_id: m?.component_id ?? b.block_template.block_type,
        };
      });
      const { url } = getSupabaseConfig();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      // Admin nginx doesn't proxy /api — see DeleteNewsletterCard for the
      // same VITE_API_URL pattern.
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}/api/admin/newsletters/editions/${edition.id}/publish-to-git`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ html: publishHtml, blockRender }),
      });
      // The publish-to-git endpoint uses 200 + `kind: 'skipped'` to
      // signal a graceful no-op (e.g. newsletter still on the
      // platform boilerplate with no external git repo connected).
      // Treat that as a warning, not a success — recipients won't
      // see anything different until the operator connects a real
      // git remote.
      const body = (await res.json().catch(() => null)) as
        | {
            kind?: 'published' | 'skipped';
            reason?: string;
            message?: string;
            error?: { message?: string };
            externalPush?: { pushed: true } | { pushed: false; error: string };
            externalUrl?: string | null;
          }
        | null;
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `publish-to-git ${res.status}`);
      }
      if (body?.kind === 'skipped') {
        toast.warning(body.message ?? 'Edition saved to the database, but no external git repo is connected — nothing published to git.');
      } else if (body?.externalPush && body.externalPush.pushed === false) {
        // Internal commit landed but the mirror push to the external
        // repo failed — surface that so the operator knows to fix
        // credentials or remote state. Keep the message terse; full
        // git stderr is in the API logs.
        toast.warning(
          `Edition published to internal repo, but mirror push to ${body.externalUrl ?? 'external repo'} failed: ${body.externalPush.error}`,
        );
      } else if (body?.externalPush?.pushed === true) {
        toast.success(`Edition published to ${body.externalUrl ?? 'external repo'}.`);
      } else {
        toast.success('Edition published.');
      }
      // The supabase URL var goes unused once the fetch is direct —
      // referenced here so the import doesn't get dropped if a
      // future caller routes through the supabase functions
      // namespace instead.
      void url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setPublishBusy(false);
    }
  };
  // The Substack / Beehiiv copy buttons only make sense when the
  // corresponding output-adapter module is installed (those modules
  // own the per-platform render variants we copy to clipboard).
  // The HTML download button is always available — every newsletter
  // has email-safe HTML to download regardless of which third-party
  // platforms the operator publishes to.
  const hasSubstackOutput = useHasModule('newsletters-output-substack');
  const hasBeehiivOutput = useHasModule('newsletters-output-beehiiv');
  const hasEditorAi = useHasModule('editor-ai-copilot');

  const userBlocks = useUserBlocks();

  // Layer the saved user-blocks into the Puck Config as synthetic
  // components under a "My blocks" category so they appear in the
  // left drawer alongside the platform's blocks. Each synthetic
  // renders null in the canvas — when the operator drops one, the
  // onChange handler below rewrites the inserted node into its real
  // saved subtree (with fresh ids stamped recursively), so the
  // synthetic never persists in the edition's data.
  //
  // This avoids needing publish-side awareness of the synthetic
  // type: the saved tree's outer `type` is always a real registry
  // componentId (Section / Container / Hero / …), so once expanded
  // the edition is indistinguishable from one composed by hand.
  const configWithUserBlocks = useMemo(() => {
    if (userBlocks.blocks.length === 0) return config;
    const cfg = config.config as Config;
    const components = { ...(cfg.components ?? {}) } as Record<string, Config['components'][string]>;
    const myBlocksIds: string[] = [];
    for (const ub of userBlocks.blocks) {
      const id = `user::${ub.id}`;
      myBlocksIds.push(id);
      components[id] = {
        label: ub.label,
        fields: {},
        defaultProps: {},
        // Render nothing — the synthetic is replaced via onChange the
        // moment it lands in the data tree. If the replace doesn't
        // happen for some reason (race / stale data), null is a
        // benign no-op.
        render: () => null,
      } as Config['components'][string];
    }
    const categoriesRaw = (cfg as { categories?: Record<string, { components?: string[]; title?: string; defaultExpanded?: boolean }> }).categories ?? {};
    const categories = {
      ...categoriesRaw,
      myBlocks: { components: myBlocksIds, title: 'My blocks', defaultExpanded: true },
    };
    return { ...config, config: { ...cfg, components, categories } as Config };
  }, [config, userBlocks.blocks, registry]);

  // Re-sync from upstream when the parent edition changes by id
  // (e.g. user navigates to a different edition).
  useEffect(() => {
    setData(editionToPuckData(edition, registry));
  }, [edition.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced email-size compute for the Gmail clipping indicator.
  // exportEditionHtml runs the same render path as Send so the count
  // matches the wire bytes. 600ms idle window: long enough to skip
  // per-keystroke renders, short enough to feel live after a paste.
  // We ignore stale resolves via a guard token so racy edits don't
  // flicker the indicator to a previous value.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          const blockMeta = buildBlockMeta();
          const html = await exportEditionHtml({
            edition,
            format: 'email',
            blockMeta,
            wrapperTemplate: resolvedWrapper, registry,
            pretty: false,
          });
          if (cancelled) return;
          setEmailSizeBytes(new Blob([html]).size);
        } catch {
          // Renderer error during a partial edit (e.g. catalogue
          // mismatch). Leave the previous size in place; the next
          // successful render will refresh it.
        }
      })();
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [edition]);

  function buildBlockMeta() {
    const blockMeta = new Map<string, import('./email-blocks/EditionEmail.js').BlockRenderMeta>();
    for (const block of edition.blocks) {
      const isRegistry = registry.has(block.block_template.block_type);
      blockMeta.set(
        block.id,
        isRegistry
          ? { render_kind: 'react-email', component_id: block.block_template.block_type }
          : { render_kind: 'mustache', mustache_html: block.block_template.content.html_template ?? '' },
      );
    }
    return blockMeta;
  }

  const handleExport = async (format: 'email' | 'substack' | 'beehiiv') => {
    setExportBusy(format);
    try {
      const blockMeta = buildBlockMeta();
      const html = await exportEditionHtml({ edition, format, blockMeta, wrapperTemplate: resolvedWrapper, registry, pretty: true });

      if (format === 'email') {
        // Email HTML → download a .html file (recipient-safe full doc).
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${edition.id}-${edition.edition_date}.html`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Downloaded email HTML.');
      } else {
        // Substack / Beehiiv: those platforms accept rich-text paste.
        // Copy directly to clipboard as HTML so the destination editor
        // ingests headings/bold/links rather than escaped source.
        await copyHtmlToClipboard(html);
        toast.success(
          `${format === 'substack' ? 'Substack' : 'Beehiiv'} rich-text copied to clipboard. Paste into your editor.`,
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[newsletter-puck] export failed:', e);
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExportBusy(null);
    }
  };

  const handleTestSend = async () => {
    if (edition.id === 'new') {
      toast.error('Save the edition first, then send a test.');
      return;
    }
    const recipient = testSendEmail.trim();
    if (!recipient || !recipient.includes('@')) {
      toast.error('Enter a valid email address.');
      return;
    }
    setTestSendBusy(true);
    try {
      const blockMeta = buildBlockMeta();
      const html = await exportEditionHtml({ edition, format: 'email', blockMeta, wrapperTemplate: resolvedWrapper, registry, pretty: false });
      // Mirror DeleteNewsletterCard's URL form — admin nginx has no /api
      // proxy, so we hit api.<brand>.live directly.
      const apiUrl = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? '';
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? null;
      const subjectLine = (edition as { subject?: string; title?: string }).subject
        ?? (edition as { title?: string }).title
        ?? 'Newsletter preview';
      const res = await fetch(`${apiUrl}/api/admin/newsletters/editions/${edition.id}/test-send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          recipient_email: recipient,
          html,
          subject: subjectLine,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(body?.error?.message ?? `Test send failed (${res.status})`);
        return;
      }
      toast.success(`Test email sent to ${recipient}.`);
      setTestSendOpen(false);
      setTestSendEmail('');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[newsletter-puck] test-send failed:', e);
      toast.error(e instanceof Error ? e.message : 'Test send failed.');
    } finally {
      setTestSendBusy(false);
    }
  };

  // The AI plugin (editor-ai-copilot) needs the available block defs
  // to constrain its output. For newsletters those come from BOTH the
  // DB-backed Mustache templates AND the react-email registry; the
  // copilot's default DB query against `templates_block_defs` returns
  // nothing because email registry blocks have no DB rows. We compute
  // the merged set here and supply it via the host context — the
  // copilot will skip its DB query when this is present.
  const aiBlockDefs = useMemo(
    () =>
      buildAiBlockDefs({
        blockTemplates,
        registry: registry,
        ...(enabledRegistryComponentIds
          ? { enabledRegistryComponentIds: new Set(enabledRegistryComponentIds) }
          : {}),
      }) as unknown as ReadonlyArray<Record<string, unknown>>,
    [blockTemplates, enabledRegistryComponentIds],
  );

  return (
    <NewsletterEditingProvider
      value={{
        collectionMetadata: collectionMetadata ?? {},
        collectionId,
        onSaveEdition: onSave ? (async () => { await onSave({ silent: true }); }) : undefined,
      }}
    >
    <div
      className="newsletter-puck-canvas puck-canvas-email"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {/* Page-level actions row. Sits ABOVE the curved-corner panel.
          The Editor / HTML view toggle is left-aligned (it switches
          which body the panel renders — feels like a navigation
          choice). The four output actions (download HTML, copy for
          Substack / Beehiiv, Publish) are right-aligned. The
          Light / Dark preview backdrop has moved INTO Puck's
          viewport-controls row via a portal — it's a sibling to
          the Desktop / Mobile switcher because they're both
          canvas-rendering settings. */}
      <div
        className="newsletter-puck-page-actions"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div role="group" aria-label="View mode" style={toolbarSegment()}>
          <button
            type="button"
            onClick={() => setView('wysiwyg')}
            style={toolbarIconBtn(view === 'wysiwyg')}
            aria-pressed={view === 'wysiwyg'}
            aria-label="Visual editor"
            title="Visual editor"
          >
            <PencilSquareIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={async () => {
              setHtmlBuilding(true);
              try {
                const html = await exportEditionHtml({
                  edition,
                  format: 'email',
                  blockMeta: buildBlockMeta(),
                  wrapperTemplate: resolvedWrapper, registry,
                  pretty: true,
                });
                setHtmlSource(html);
                setView('html');
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[newsletter-puck] html-view render failed:', e);
                setHtmlSource(`<!-- failed to render: ${e instanceof Error ? e.message : String(e)} -->`);
                setView('html');
              } finally {
                setHtmlBuilding(false);
              }
            }}
            style={toolbarIconBtn(view === 'html', htmlBuilding)}
            aria-pressed={view === 'html'}
            aria-label="View HTML source"
            title="View the rendered email HTML source"
          >
            <CodeBracketIcon className="w-4 h-4" />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Output destinations grouped in a single connected segment
              (same visual treatment as the Light/Dark + view toggles)
              because they're all "send the edition somewhere" actions
              — the segment gives a clear shared affordance. */}
          <div role="group" aria-label="Output destination" style={toolbarSegment()}>
            <button
              type="button"
              onClick={() => handleExport('email')}
              disabled={exportBusy !== null}
              style={segmentTextBtn(false, exportBusy === 'email')}
              title="Download as email-safe HTML (full document)"
            >
              <ArrowDownTrayIcon className="w-4 h-4 shrink-0" />
              <span>{exportBusy === 'email' ? 'Exporting…' : 'HTML'}</span>
            </button>
            {hasSubstackOutput && (
              <button
                type="button"
                onClick={() => handleExport('substack')}
                disabled={exportBusy !== null}
                style={segmentTextBtn(false, exportBusy === 'substack')}
                title="Render as Substack rich text and copy to clipboard"
              >
                <ClipboardDocumentIcon className="w-4 h-4 shrink-0" />
                <span>{exportBusy === 'substack' ? 'Copying…' : 'Substack'}</span>
              </button>
            )}
            {hasBeehiivOutput && (
              <button
                type="button"
                onClick={() => handleExport('beehiiv')}
                disabled={exportBusy !== null}
                style={segmentTextBtn(false, exportBusy === 'beehiiv')}
                title="Render as Beehiiv rich text and copy to clipboard"
              >
                <ClipboardDocumentIcon className="w-4 h-4 shrink-0" />
                <span>{exportBusy === 'beehiiv' ? 'Copying…' : 'Beehiiv'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setTestSendOpen((v) => !v)}
              disabled={exportBusy !== null || edition.id === 'new'}
              style={segmentTextBtn(false, testSendOpen)}
              title={edition.id === 'new'
                ? 'Save the edition first, then send a test'
                : 'Send a one-off preview to your inbox via SendGrid'}
            >
              <PaperAirplaneIcon className="w-4 h-4 shrink-0" />
              <span>Test Send</span>
            </button>
          </div>

          {/* Save — persists the edition's draft to the database
              only. No git write, no recipient-visible change. The
              edition's status stays 'draft' until Publish is hit. */}
          <button
            type="button"
            onClick={async () => {
              if (!onSave) return;
              try {
                await onSave({ silent: true });
                toast.success('Draft saved.');
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Save failed');
              }
            }}
            disabled={isSavingNow}
            style={saveBtnStyle(isSavingNow)}
          >
            <span>{isSavingNow ? 'Saving…' : 'Save Draft'}</span>
          </button>

          {/* Publish — confirm with the operator first, then save +
              POST to the publish-to-git endpoint. The endpoint
              writes editions/<id>.html and editions/<id>.json into
              the publish branch of the per-newsletter git repo, so
              this is the action that makes the edition visible to
              recipients downstream. */}
          <button
            type="button"
            onClick={() => handlePublish()}
            disabled={publishBusy}
            style={publishBtnStyle(publishBusy)}
          >
            <GlobeAltIcon className="w-4 h-4 shrink-0" />
            <span>{publishBusy ? 'Publishing…' : 'Publish'}</span>
          </button>
        </div>
      </div>

      {/* Test Send inline panel — slides under the toolbar when the
          "Test Send" button is active. Enter a recipient, hit Send,
          we render the current draft as email HTML and POST it to
          the newsletters api which forwards to SendGrid. The
          recipient sees a "[TEST] …" subject so the inbox is
          unambiguous. Persists across re-renders so the operator
          can re-send to the same address without retyping. */}
      {testSendOpen && (
        <div
          style={{
            margin: '8px 0',
            padding: 12,
            background: 'var(--accent-a2, rgba(59,130,246,0.08))',
            border: '1px solid var(--accent-a4, rgba(59,130,246,0.25))',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
          role="region"
          aria-label="Send a test email"
        >
          <PaperAirplaneIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--accent-11, #2563eb)' }} />
          <span style={{ fontSize: 13, color: 'var(--gray-12, #111)', fontWeight: 500 }}>
            Send a test email to
          </span>
          <input
            type="email"
            autoFocus
            value={testSendEmail}
            onChange={(e) => setTestSendEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !testSendBusy) { e.preventDefault(); void handleTestSend(); }
              if (e.key === 'Escape') { setTestSendOpen(false); }
            }}
            placeholder="your@email.com"
            style={{
              flex: 1,
              minWidth: 240,
              padding: '6px 10px',
              fontSize: 13,
              border: '1px solid var(--gray-a6, #d1d5db)',
              borderRadius: 6,
              background: 'var(--color-panel-solid, white)',
              color: 'var(--gray-12, #111)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleTestSend}
            disabled={testSendBusy || !testSendEmail.includes('@')}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 500,
              border: 'none',
              borderRadius: 6,
              background: 'var(--accent-9, #2563eb)',
              color: 'white',
              cursor: testSendBusy || !testSendEmail.includes('@') ? 'not-allowed' : 'pointer',
              opacity: testSendBusy || !testSendEmail.includes('@') ? 0.55 : 1,
            }}
          >
            {testSendBusy ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            onClick={() => setTestSendOpen(false)}
            aria-label="Close test send"
            style={{
              padding: 4,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--gray-11, #6b7280)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* MyBlocksPanel now only opens for the "Save current selection
          as block" flow — operators browse + insert via the Puck
          drawer's "My blocks" category (synthesised above). The save
          flow is fired by the in-canvas "★ Save block" action button
          which sets pendingSave; we open the modal in 'save' mode
          when that happens. */}
      <MyBlocksPanel
        open={userBlocks.pendingSave !== null}
        mode="save"
        edition={edition}
        registry={registry}
        onApply={onChange}
        onClose={() => {
          userBlocks.clearPendingSave();
        }}
      />

      {/* When the operator clicks the <> button, swap the wysiwyg
          shell for a read-only HTML source panel. The shell unmounts
          and Puck loses undo history while in HTML view — acceptable
          tradeoff since HTML view is a quick "view source / copy"
          flow rather than a long edit session. */}
      {view === 'html' ? (
        <div
          className="newsletter-puck-html-view"
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            background: '#0e0f12',
            color: '#e5e7eb',
            border: '1px solid var(--gray-a5, #e5e7eb)',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #23262d' }}>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Rendered email HTML — read-only.</span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(htmlSource);
                  toast.success('HTML copied to clipboard.');
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Copy failed');
                }
              }}
              style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #2a2d34', background: '#1f2227', color: '#e5e7eb', cursor: 'pointer', fontSize: 12 }}
            >
              Copy
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              padding: '12px 16px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflow: 'auto',
              flex: 1,
            }}
          >
            {htmlSource}
          </pre>
        </div>
      ) : (
        <CanvasShell
          hostKind="newsletter"
          hostId={collectionId ?? edition.id}
          targetId={edition.id}
          extraPlugins={aiCopilotPlugins}
          // Disable AI on unsaved editions — the generate endpoint
          // looks up the edition row in newsletters_editions to build
          // its prompt context (library, blocks, preheader), and would
          // 404 with `newsletter_edition_not_found` otherwise. Save
          // the draft first, then come back to the AI tab.
          //
          // Gating: prefer the dynamic-import outcome over
          // `useHasModule('editor-ai-copilot')`. The dynamic import is
          // the actual proof the plugin is loadable in this bundle on
          // this brand; the modules-context hook reads the
          // installed_modules table and was flaky on AAIF (returned
          // false even when the row was status='enabled'). Keep
          // hasEditorAi as a belt-and-braces OR so the gate still
          // honours a deliberate disable from the modules admin.
          aiEnabled={(aiCopilotPlugins.length > 0 || hasEditorAi) && edition.id !== 'new'}
          {...(edition.id === 'new'
            ? { aiDisabledReason: 'Save the edition first, then come back to use AI to generate content.' }
            : {})}
          blockDefs={aiBlockDefs}
          config={configWithUserBlocks.config as never}
          data={data as never}
          // Surface the fixed header/footer chrome + edition date to the canvas
          // root so it can render a non-editable preview of them around the
          // editable blocks (they're page chrome, not blocks).
          extraMetadata={{ wrapperTemplate: resolvedWrapper, editionDate: edition.edition_date }}
          // Newsletters lock to the email column width. The Desktop frame is
          // 682, not 650: the authored email column is 650px and the canvas
          // body adds 16px of horizontal padding each side (see
          // BASE_CANVAS_CSS), so a 650px frame left only 618px usable and
          // clipped the right ~32px of the email. 682 = 650 + 2×16 gives the
          // full 650px column room with its intended side margins. Mobile
          // (375) is narrower than any 650px email; the .gw-email-card rules
          // let the content shrink to fit rather than clip. Sites uses
          // CanvasShell's default 1280/375.
          viewports={[
            { width: 682, height: 'auto', label: 'Desktop', icon: 'Monitor' },
            { width: 375, height: 'auto', label: 'Mobile', icon: 'Smartphone' },
          ]}
          overrides={{
            // Search box at the top of the Blocks drawer — filters the
            // (now large) block palette by label / component id.
            components: BlockSearchComponents as never,
            // Inject "Save block" alongside Puck's default
            // delete/duplicate buttons in the contextual action bar
            // that appears around the selected component. Mirrors the
            // puckeditor.com DefaultActionBar shape — <ActionBar>
            // wrapper + two <ActionBar.Group> sections.
            actionBar: ({ children, parentAction, label }) => (
              <ActionBar>
                <ActionBar.Group>
                  {parentAction}
                  {label ? <ActionBar.Label label={label} /> : null}
                </ActionBar.Group>
                <ActionBar.Group>
                  {children}
                  <SaveAsBlockAction />
                </ActionBar.Group>
              </ActionBar>
            ),
          }}
          onChange={(nextData) => {
            // Convert + emit upstream. Cast through unknown because
            // Puck's `Data` type widens props to its own shape; ours
            // is a subset.
            let nextPuck = nextData as unknown as ReturnType<typeof editionToPuckData>;

            // Drawer-inserted "My blocks" components arrive with
            // type='user::<id>' and an empty props object. Walk the
            // tree and replace each one with the saved tree (real
            // registry type + recursively-stamped fresh ids). This is
            // the moment the synthetic ceases to exist — every
            // downstream consumer (puckDataToEdition, the publish
            // renderer, the EditionEmail composer) sees only the
            // expanded type.
            const expanded = expandUserBlockSynthetics(nextPuck, userBlocks.blocks);
            if (expanded !== nextPuck) {
              nextPuck = expanded;
            }

            setData(nextPuck);
            try {
              const nextEdition = puckDataToEdition({
                base: edition,
                data: nextPuck,
                blockTemplates,
                brickTemplates,
                registry: registry,
              });
              onChange(nextEdition);
            } catch (e) {
              // Catalogue mismatch — keep the editor state but don't
              // propagate. The parent will surface a refresh prompt.
              // eslint-disable-next-line no-console
              console.warn('[newsletter-puck] adapter rejected change:', e);
            }
          }}
          onPublish={async () => {
            if (onSave) await onSave();
          }}
        />
      )}

      {/* Gmail clipping indicator — same component the HTML preview tab
          uses. Sits below the canvas in both wysiwyg and html views so
          the operator can watch the size grow as blocks are added. The
          first paint shows "…" until the debounced exportEditionHtml
          resolves; subsequent edits update after a 600ms idle. */}
      <EmailSizeIndicator
        sizeInBytes={emailSizeBytes ?? 0}
        blocksCount={edition.blocks.length}
        ready={emailSizeBytes !== null}
      />
    </div>
    </NewsletterEditingProvider>
  );
};

export default NewsletterPuckCanvas;

// ---------------------------------------------------------------------------
// User-block synthetic expansion. The drawer's "My blocks" category
// inserts a placeholder of type `user::<saved-block-id>`; this helper
// walks Puck's content tree (recursing into slot children) and
// replaces any such placeholder with the saved tree's real
// componentId + props. Fresh ids are stamped at every level so the
// same saved block can be inserted multiple times in one session
// without colliding on Puck's identity tracking. Returns the same
// reference when nothing changes so React's setData skips re-renders.
// ---------------------------------------------------------------------------

interface UserBlockLite {
  id: string;
  tree: { type: string; props: Record<string, unknown> };
}

function expandUserBlockSynthetics(
  data: ReturnType<typeof editionToPuckData>,
  userBlocks: ReadonlyArray<UserBlockLite>,
): ReturnType<typeof editionToPuckData> {
  if (userBlocks.length === 0) return data;
  let mutated = false;

  function freshUuid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
  }

  function stampIdsRecursive(node: { type: string; props: Record<string, unknown> }): { type: string; props: Record<string, unknown> } {
    const props: Record<string, unknown> = { ...node.props, id: freshUuid() };
    if (Array.isArray(props.children)) {
      props.children = (props.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) =>
        stampIdsRecursive(c),
      );
    }
    return { type: node.type, props };
  }

  function expandOne(entry: { type: string; props: Record<string, unknown> }): { type: string; props: Record<string, unknown> } {
    if (typeof entry.type === 'string' && entry.type.startsWith('user::')) {
      const slug = entry.type.slice(6);
      const ub = userBlocks.find((b) => b.id === slug);
      if (ub) {
        mutated = true;
        return stampIdsRecursive(ub.tree);
      }
    }
    // Recurse into nested children (slot containers like Section / Row /
    // Column / Container store their tree under props.children).
    if (Array.isArray(entry.props.children)) {
      const nextChildren = (entry.props.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) =>
        expandOne(c),
      );
      if (nextChildren.some((c, i) => c !== (entry.props.children as unknown[])[i])) {
        return { type: entry.type, props: { ...entry.props, children: nextChildren } };
      }
    }
    return entry;
  }

  const nextContent = data.content.map((b) => expandOne(b as never)) as typeof data.content;
  if (!mutated) return data;
  return { ...data, content: nextContent };
}

// ---------------------------------------------------------------------------
// Canvas root — replaces Puck's default root.render. Wraps children in
// an email-shape "card" so the iframe shows what the operator is
// actually composing (centered 600px max-width, white card on a
// light/dark backdrop, paddings + shadow + base typography).
// previewMode comes through Puck's metadata so the canvas re-renders
// when the toolbar toggle flips, without us having to rebuild the
// whole Puck Config (which would lose selection).
// ---------------------------------------------------------------------------

interface RootProps {
  children?: ReactNode;
  puck?: {
    metadata?: {
      previewMode?: 'light' | 'dark';
      wrapperTemplate?: string | null;
      editionDate?: string;
    };
  };
}

// Module-level Puck hook — `createUsePuck()` returns a selector-aware
// hook (the parameterless `usePuck` re-renders on every state change
// and prints a dev warning). Reading `selectedItem` lets us subscribe
// to selection changes without re-rendering for unrelated state.
const usePuckSelected = createUsePuck();

// Watches the Puck selection and switches the left sidebar to the
// Fields tab whenever a new block is selected. This replaces an
// earlier doc-level click listener that didn't work because Puck's
// DraggableComponent click handler calls e.stopPropagation() — the
// click never reached the document, so we never knew a selection
// had happened. Subscribing to selectedItem in-context bypasses the
// event pipeline entirely and works for every selection path: click,
// inline-text focus, breadcrumb, programmatic, undo/redo.
function FieldsAutoSwitcher(): null {
  const selectedId = usePuckSelected((s) => s.selectedItem?.props?.id ?? null);
  const dispatch = usePuckSelected((s) => s.dispatch);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedId && selectedId !== lastIdRef.current) {
      dispatch({
        type: 'setUi',
        ui: { plugin: { current: 'fields' }, leftSideBarVisible: true },
      });
    }
    lastIdRef.current = selectedId;
  }, [selectedId, dispatch]);

  return null;
}

/**
 * Watches Puck's internal store for `user::<id>` synthetics dropped
 * from the "My blocks" drawer category and dispatches `setData` to
 * replace each one with the saved tree (real registry componentId +
 * recursively-stamped fresh ids).
 *
 * Why this exists alongside the outer-onChange expansion: Puck v0.21
 * treats the `data` prop as an INITIAL seed only — the inner store
 * lives in `useState(() => populateFromInitialData(data))`, which
 * runs once at mount and never re-syncs from subsequent `data` prop
 * changes. Our outer onChange handler `setData(expanded)`-s React's
 * data state and threads the expanded tree through `puckDataToEdition`
 * (so the email actually sends correctly), but Puck's CANVAS keeps
 * showing the unexpanded `user::X` because its internal store is
 * untouched. `user::X`'s render returns null → empty card on canvas.
 *
 * Mounting an effect inside Puck's context (via NewsletterCanvasRoot)
 * lets us reach `dispatch` and replace the data in Puck's store
 * directly, which propagates back through the canvas.
 *
 * Cost: `usePuckSelected((s) => s.appState.data)` re-renders this
 * component on every Puck-internal edit. The component returns null
 * (no DOM cost), and the effect early-exits when no synthetics are
 * present, so the cost is a tree walk per edit — negligible compared
 * to Puck's own re-render work.
 */
function UserBlockSyntheticExpander(): null {
  const data = usePuckSelected((s) => s.appState.data);
  const dispatch = usePuckSelected((s) => s.dispatch);
  const { blocks: userBlocks } = useUserBlocks();
  useEffect(() => {
    if (userBlocks.length === 0) return;
    const expanded = expandUserBlockSynthetics(
      data as unknown as ReturnType<typeof editionToPuckData>,
      userBlocks,
    );
    if (expanded === (data as unknown)) return;
    dispatch({ type: 'setData', data: expanded as never });
  }, [data, userBlocks, dispatch]);
  return null;
}

function NewsletterCanvasRoot(props: RootProps) {
  const mode = props.puck?.metadata?.previewMode ?? 'light';
  const css = mode === 'dark' ? CANVAS_DARK_CSS : CANVAS_LIGHT_CSS;
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // wrapperRef lives inside the Puck iframe, so ownerDocument here
    // is the iframe document — that's where Puck's actionBar overlay
    // is portaled. Used to strip the native browser title="..."
    // tooltip on every default action-bar button (Duplicate / Delete
    // / Select parent), which is unstyleable and clashes with the
    // editor chrome. Re-run on every DOM mutation because the action
    // bar is portaled in/out around selection changes.
    const doc = wrapper.ownerDocument;
    if (!doc) return;
    const stripTitles = () => {
      doc.querySelectorAll<HTMLElement>('[class*="ActionBarAction"][title]').forEach((el) => {
        el.removeAttribute('title');
      });
    };
    stripTitles();
    const obs = new MutationObserver(stripTitles);
    obs.observe(doc.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // Wrapper chrome (header/footer) is rendered by EditionEmail at export /
  // send / publish time using the declarative template from the newsletter's
  // repo (templates_wrappers row). The live canvas shows only the editable
  // body blocks — clicking "Preview" surfaces the full wrapped render.
  return (
    <>
      <style data-newsletter-canvas-css dangerouslySetInnerHTML={{ __html: BASE_CANVAS_CSS + css }} />
      <FieldsAutoSwitcher />
      <UserBlockSyntheticExpander />
      <div ref={wrapperRef} className="gw-email-card">
        {props.children}
      </div>
    </>
  );
}

const BASE_CANVAS_CSS = `
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    -webkit-text-size-adjust: 100%;
    transition: background-color 0.15s ease;
  }
  body {
    padding: 32px 16px;
    box-sizing: border-box;
  }
  .gw-email-card {
    width: 100%;
    max-width: 650px;
    margin: 0 auto;
    border-radius: 6px;
    /* overflow:visible (was hidden): the authored blocks are a fixed 650px and
       some carry their own 1px border + rounded corners flush to that width.
       Clipping at the 650px card edge shaved the right border/corner. The
       Desktop frame (682 = 650 + 2×16 body padding) already gives the column
       room, so let block borders paint to their full width. */
    overflow: visible;
    transition: background-color 0.15s ease, box-shadow 0.15s ease;
  }
  /* The email column is authored at a fixed 650px. When the viewport is
     narrower than that (the Mobile frame, or any pane tighter than 650),
     cap the top-level tables to the card width so the template REDUCES to
     fit instead of overflowing and being clipped by the card's
     overflow:hidden. Scoped to the card so Puck's own chrome is untouched. */
  .gw-email-card table {
    max-width: 100%;
  }
  /* Reset table defaults for react-email components so authored padding
     / backgroundColor styles render predictably in the editor iframe. */
  table {
    border-collapse: collapse;
    border-spacing: 0;
  }
  /* Make sure embedded Img blocks behave like email-safe images. */
  img {
    max-width: 100%;
    height: auto;
    display: block;
  }

  /* ==========================================================
     Email-client default reset.

     Puck's CopyHostStyles ports the admin's Tailwind preflight
     (and any other parent stylesheet) into this iframe. Email
     clients DON'T have Tailwind preflight — they apply user-agent
     defaults. Without this counter-reset every <h1>/<h2>/<h3>,
     <ul>/<ol>, <a>, <blockquote> etc. inherits the admin reset
     and renders flat in the canvas, even though the same markup
     composes correctly when sent.

     Inline styles on blocks always win in cascade, so this only
     affects elements that DON'T have an explicit style — exactly
     the same as how a real recipient's mail client would render
     them. The goal: edit-time canvas matches recipient view byte
     for visible byte.

     Using em units for size so the cascade stays proportional
     (the Heading block's explicit px values still override these).
     ========================================================== */

  h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; line-height: 1.25; }
  h2 { font-size: 1.5em; font-weight: bold; margin: 0.83em 0; line-height: 1.25; }
  h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0; line-height: 1.25; }
  h4 { font-size: 1em; font-weight: bold; margin: 1.33em 0; }
  h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0; }
  h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0; }

  p { margin: 1em 0; }

  /* Default link colour matches the typical Outlook / Gmail blue.
     Most email designs override per-link via inline color, so this
     is just the "no inline style" fallback. */
  a { color: #0563C1; text-decoration: underline; cursor: pointer; }

  b, strong { font-weight: bold; }
  em, i { font-style: italic; }
  small { font-size: 80%; }

  ul, ol { margin: 1em 0; padding-left: 40px; }
  ul { list-style: disc outside; }
  ol { list-style: decimal outside; }
  ul ul, ol ul { list-style: circle outside; }
  ul ul ul, ol ol ul { list-style: square outside; }
  li { display: list-item; }

  blockquote { margin: 1em 40px; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 1em 0; }

  /* Tailwind preflight sets box-sizing: border-box on all elements.
     Email clients use content-box for tables (the historical default).
     react-email's table-based layouts assume content-box widths;
     border-box subtly shifts cell widths when padding is applied,
     which makes hero/CTA cards render narrower in the canvas than
     in the inbox. Restore content-box for table-layout elements. */
  table, tr, td, th, tbody, thead, tfoot {
    box-sizing: content-box;
  }

  /* Inline-edit chrome — these rules ALSO live in the iframe-side
     CSS (this file) because Puck renders the DraggableComponent
     overlays + InlineTextField spans inside the canvas iframe.
     Parent-document <style> tags don't reach them. */

  /* Push Puck's selection / hover outline OUTSIDE the block's edge
     so the contentEditable text doesn't overlap with the chrome. */
  [class*="DraggableComponent-overlay"] {
    outline-offset: 4px !important;
  }

  /* Drop the browser default contentEditable focus ring on the
     InlineTextField span. */
  [class*="InlineTextField"]:focus,
  [class*="InlineTextField"]:focus-visible {
    outline: none !important;
  }

  /* When an InlineTextField has focus, hide the block's selection
     outline entirely. The :has() selector finds the
     DraggableComponent ancestor, then the descendant combinator
     hits the overlay element. As soon as focus leaves, the outline
     reappears so the operator can see what's selected. */
  [class*="DraggableComponent"]:has([class*="InlineTextField"]:focus) [class*="DraggableComponent-overlay"] {
    outline: none !important;
  }
  /* :focus-within fallback for older Safari (Safari pre-15.4 lacks
     :has support). Slightly broader scope but the visual outcome is
     the same: typing in any text input descendant hides the block
     outline. */
  [class*="DraggableComponent"]:focus-within [class*="DraggableComponent-overlay"] {
    outline: none !important;
  }

  /* Inline rich-text editing: dnd-kit marks the draggable component
     wrapper user-select:none (so a drag doesn't select page text). The
     tiptap contentEditable inside inherits it, which silently blocks
     placing a cursor / selecting text — the editor renders but feels
     "not editable". Force text selection + a text caret back on the
     editable regions (tiptap's .ProseMirror / Puck's .rich-text and any
     contenteditable). Scoped to the email card so Puck chrome is
     untouched. */
  .gw-email-card [data-puck-overlay-portal],
  .gw-email-card .rich-text,
  .gw-email-card .ProseMirror,
  .gw-email-card [contenteditable="true"] {
    user-select: text !important;
    -webkit-user-select: text !important;
    cursor: text;
  }
`;

const CANVAS_LIGHT_CSS = `
  body { background-color: #fafbfc; color: #14171E; }
  .gw-email-card { background-color: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06); }
`;

const CANVAS_DARK_CSS = `
  body { background-color: #0e0f12; color: #e5e7eb; }
  .gw-email-card { background-color: #1a1c20; box-shadow: 0 0 0 1px rgba(255,255,255,0.06); }
`;

// ---------------------------------------------------------------------------
// Toolbar helpers — small inline-style factories used by the page-level
// toolbar above the canvas. Puck theming + the Light/Dark portal now
// live in the shared CanvasShell.
// ---------------------------------------------------------------------------

function toolbarSegment(): React.CSSProperties {
  return {
    display: 'inline-flex',
    border: '1px solid var(--gray-a6, #ccc)',
    borderRadius: 4,
    overflow: 'hidden',
    background: 'var(--color-surface, #fff)',
  };
}

// Shared button height across every toolbar control so HTML /
// Substack / Beehiiv / Publish (and the icon-only segments) all line
// up cleanly. Tweak here once if the toolbar density changes.
const TOOLBAR_BTN_HEIGHT = 32;

function toolbarIconBtn(active: boolean, busy = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: TOOLBAR_BTN_HEIGHT,
    border: 'none',
    borderRight: '1px solid var(--gray-a4, #eee)',
    background: active ? 'var(--accent-a3, #eef2f7)' : 'transparent',
    color: active ? 'var(--accent-11, #14171E)' : 'var(--gray-12, inherit)',
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.7 : 1,
  };
}

function segmentTextBtn(active: boolean, busy = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    height: TOOLBAR_BTN_HEIGHT,
    border: 'none',
    borderRight: '1px solid var(--gray-a4, #eee)',
    background: active ? 'var(--accent-a3, #eef2f7)' : 'transparent',
    color: active ? 'var(--accent-11, #14171E)' : 'var(--gray-12, inherit)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 13,
    opacity: busy ? 0.7 : 1,
    whiteSpace: 'nowrap',
  };
}

function saveBtnStyle(busy: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 14px',
    height: TOOLBAR_BTN_HEIGHT,
    border: '1px solid var(--gray-a6, #ccc)',
    borderRadius: 6,
    background: 'var(--color-surface, #fff)',
    color: 'var(--gray-12, #14171E)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 13,
    fontWeight: 500,
    opacity: busy ? 0.7 : 1,
    whiteSpace: 'nowrap',
  };
}

function publishBtnStyle(busy: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 14px',
    height: TOOLBAR_BTN_HEIGHT,
    border: '1px solid var(--accent-9, #14171E)',
    borderRadius: 6,
    background: 'var(--accent-9, #14171E)',
    color: 'var(--accent-contrast, #fff)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 13,
    fontWeight: 500,
    opacity: busy ? 0.7 : 1,
    whiteSpace: 'nowrap',
  };
}

/**
 * Copy an HTML string to the clipboard as **rich content** (so paste
 * targets like Substack / Beehiiv ingest formatting), with a plain-
 * text fallback. Uses the modern Clipboard API where available; falls
 * back to a hidden contenteditable for older browsers.
 */
async function copyHtmlToClipboard(html: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && 'write' in navigator.clipboard) {
    const blob = new Blob([html], { type: 'text/html' });
    const textBlob = new Blob([stripTags(html)], { type: 'text/plain' });
    const item = new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob });
    await navigator.clipboard.write([item]);
    return;
  }
  // Fallback — synchronous selection + execCommand on a hidden node.
  const div = document.createElement('div');
  div.contentEditable = 'true';
  div.innerHTML = html;
  div.style.position = 'fixed';
  div.style.opacity = '0';
  document.body.appendChild(div);
  const range = document.createRange();
  range.selectNodeContents(div);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('copy');
  sel?.removeAllRanges();
  document.body.removeChild(div);
}

function stripTags(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}
