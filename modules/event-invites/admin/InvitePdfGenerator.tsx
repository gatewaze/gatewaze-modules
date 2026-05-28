import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Modal } from '@/components/ui';
import { DocumentArrowDownIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  findMatchingTemplate,
  getAssetsForEvent,
  getAssetPublicUrl,
  createDelivery,
  type InviteTemplate,
  type TemplateAsset,
  type PdfField,
} from './utils/inviteTemplateService';
import { buildInviteContext, resolveVariable, type InviteContext } from './utils/inviteVariables';
import { wrapText } from './utils/wrapText';

interface InvitePdfGeneratorProps {
  eventUuid: string;
  portalUrl: string;
}

interface PartyForPdf {
  id: string;
  name: string;
  short_code: string;
  lead_first_name: string | null;
  lead_last_name: string | null;
  lead_email: string | null;
  member_count: number;
}

/**
 * Render the template fields (text + QR) onto a given page.
 * Shared between single-party PDF generation and merged-PDF generation.
 */
async function renderFieldsOnPage(
  pdfDoc: any,
  page: any,
  template: InviteTemplate,
  context: InviteContext,
  fontCache: Map<string, any>,
  helvetica: any,
  pdfLib: typeof import('pdf-lib'),
): Promise<void> {
  const fields: PdfField[] = template.pdf_fields || [];
  const { rgb, degrees } = pdfLib;

  for (const field of fields) {
    if (field.type === 'text') {
      const rawText = field.text !== undefined
        ? field.text
        : resolveVariable(field.variable || '', context);
      if (!rawText) continue;

      const font = field.fontAssetId ? (fontCache.get(field.fontAssetId) || helvetica) : helvetica;
      const fontSize = field.fontSize || 12;
      const lineHeight = field.lineHeight ?? 1;
      const color = parseColor(field.color || '#000000', rgb);

      // Wrap text to maxWidth if set, using the same font/size as the output.
      const lines = wrapText(rawText, field.maxWidth, (s) => font.widthOfTextAtSize(s, fontSize));

      const anchorX = field.x || 0;
      const anchorY = field.y || 0;
      const rotationDeg = field.rotation || 0;
      const rad = rotationDeg * Math.PI / 180;
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (!line) continue;
        const lineWidth = font.widthOfTextAtSize(line, fontSize);

        // Local (unrotated) offset of this line's left-baseline from the anchor.
        let localX = 0;
        if (field.align === 'center') localX = -lineWidth / 2;
        else if (field.align === 'right') localX = -lineWidth;
        const localY = -li * fontSize * lineHeight; // subsequent lines go down (smaller pdf y)

        // Rotate around the anchor (counter-clockwise, matching pdf-lib).
        const rotatedX = localX * cosA - localY * sinA;
        const rotatedY = localX * sinA + localY * cosA;

        const drawOptions: any = {
          x: anchorX + rotatedX,
          y: anchorY + rotatedY,
          size: fontSize,
          font,
          color,
        };
        if (rotationDeg) drawOptions.rotate = degrees(rotationDeg);
        page.drawText(line, drawOptions);
      }
    } else if (field.type === 'qr') {
      try {
        const qrValue = resolveVariable(field.variable || '', context);
        if (!qrValue) continue;

        const { QRCodeService } = await import('@/utils/qrCodeService');
        const qrDataUrl = await QRCodeService.generateQRCode({
          data: qrValue,
          size: 300,
          color: '#000000',
          backgroundColor: '#ffffff',
        });
        const base64 = qrDataUrl.split(',')[1];
        const qrBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const qrImage = await pdfDoc.embedPng(qrBytes);
        const size = field.size || 52;

        const drawOptions: any = { x: field.x, y: field.y, width: size, height: size };
        if (field.rotation) {
          drawOptions.rotate = degrees(field.rotation);
        }
        page.drawImage(qrImage, drawOptions);
      } catch (err) {
        console.warn('Failed to generate QR code:', err);
      }
    }
  }
}

/**
 * Load and embed all custom fonts from asset storage into the given PDF doc.
 */
async function embedFontsForDoc(pdfDoc: any, assets: TemplateAsset[]): Promise<Map<string, any>> {
  const fontCache = new Map<string, any>();
  const fontAssets = assets.filter(a => a.asset_type === 'font');
  for (const fontAsset of fontAssets) {
    try {
      const fontUrl = getAssetPublicUrl(fontAsset);
      const fontBytes = await fetch(fontUrl).then(r => r.arrayBuffer());
      const embedded = await pdfDoc.embedFont(new Uint8Array(fontBytes));
      fontCache.set(fontAsset.id, embedded);
    } catch (err) {
      console.warn(`Failed to load font ${fontAsset.filename}:`, err);
    }
  }
  return fontCache;
}

async function generateInvitePdf(
  party: PartyForPdf,
  template: InviteTemplate,
  context: InviteContext,
  assets: TemplateAsset[],
): Promise<Blob> {
  const pdfLib = await import('pdf-lib');
  const PDFDocument = pdfLib.PDFDocument;
  const fontkitModule = await import('@pdf-lib/fontkit');
  const fontkit = fontkitModule.default || fontkitModule;

  let pdfDoc: InstanceType<typeof PDFDocument>;

  if (template.pdf_background_path) {
    const bgAsset = assets.find(a => a.storage_path === template.pdf_background_path);
    if (bgAsset) {
      const bgUrl = getAssetPublicUrl(bgAsset);
      const bgBytes = await fetch(bgUrl).then(r => r.arrayBuffer());
      if (template.pdf_background_hidden) {
        // Keep the same page size as the background but don't include it
        const bgDoc = await PDFDocument.load(bgBytes);
        const [w, h] = [bgDoc.getPage(0).getWidth(), bgDoc.getPage(0).getHeight()];
        pdfDoc = await PDFDocument.create();
        pdfDoc.addPage([w, h]);
      } else {
        pdfDoc = await PDFDocument.load(bgBytes);
      }
    } else {
      pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([297.75, 419.25]);
    }
  } else {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([297.75, 419.25]);
  }

  pdfDoc.registerFontkit(fontkit);
  const fontCache = await embedFontsForDoc(pdfDoc, assets);
  const helvetica = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);

  const page = pdfDoc.getPages()[0];
  await renderFieldsOnPage(pdfDoc, page, template, context, fontCache, helvetica, pdfLib);

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

/**
 * Generate a single multi-page PDF containing one page per party.
 * Each page is rendered onto a fresh copy of the template's background PDF.
 */
async function generateMergedPdf(
  jobs: Array<{ template: InviteTemplate; context: InviteContext }>,
  assets: TemplateAsset[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const pdfLib = await import('pdf-lib');
  const PDFDocument = pdfLib.PDFDocument;
  const fontkitModule = await import('@pdf-lib/fontkit');
  const fontkit = fontkitModule.default || fontkitModule;

  // Create the output doc
  const mergedDoc = await PDFDocument.create();
  mergedDoc.registerFontkit(fontkit);
  const fontCache = await embedFontsForDoc(mergedDoc, assets);
  const helvetica = await mergedDoc.embedFont(pdfLib.StandardFonts.Helvetica);

  // Cache loaded background docs by storage path so we only download each once
  const bgDocCache = new Map<string, any>();

  for (let i = 0; i < jobs.length; i++) {
    const { template, context } = jobs[i];

    let page: any;
    if (template.pdf_background_path) {
      let bgDoc = bgDocCache.get(template.pdf_background_path);
      if (!bgDoc) {
        const bgAsset = assets.find(a => a.storage_path === template.pdf_background_path);
        if (bgAsset) {
          const bgUrl = getAssetPublicUrl(bgAsset);
          const bgBytes = await fetch(bgUrl).then(r => r.arrayBuffer());
          bgDoc = await PDFDocument.load(bgBytes);
          bgDocCache.set(template.pdf_background_path, bgDoc);
        }
      }

      if (bgDoc) {
        if (template.pdf_background_hidden) {
          // Match the background's page size but leave the page blank
          const bgPage = bgDoc.getPage(0);
          page = mergedDoc.addPage([bgPage.getWidth(), bgPage.getHeight()]);
        } else {
          const [copiedPage] = await mergedDoc.copyPages(bgDoc, [0]);
          page = mergedDoc.addPage(copiedPage);
        }
      } else {
        page = mergedDoc.addPage([297.75, 419.25]);
      }
    } else {
      page = mergedDoc.addPage([297.75, 419.25]);
    }

    await renderFieldsOnPage(mergedDoc, page, template, context, fontCache, helvetica, pdfLib);
    onProgress?.(i + 1, jobs.length);
  }

  const pdfBytes = await mergedDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

function parseColor(hex: string, rgbFn: typeof import('pdf-lib').rgb) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return rgbFn(r, g, b);
}

export function InvitePdfGenerator({ eventUuid, portalUrl }: InvitePdfGeneratorProps) {
  const [showModal, setShowModal] = useState(false);
  const [parties, setParties] = useState<PartyForPdf[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');

  const loadData = useCallback(async () => {
    const { data: partyData } = await supabase
      .from('invite_parties_with_stats')
      .select('id, name, short_code, lead_first_name, lead_last_name, lead_email, member_count, event_ids')
      .contains('event_ids', [eventUuid]);
    setParties((partyData || []) as PartyForPdf[]);

    const { data: event } = await supabase
      .from('events')
      .select('event_title')
      .eq('id', eventUuid)
      .single();
    setEventTitle(event?.event_title || 'Event');
  }, [eventUuid]);

  const handleOpen = async () => {
    setShowModal(true);
    setSelectedIds(new Set());
    setSearch('');
    await loadData();
  };

  const toggleSelect = (partyId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  };

  const filteredParties = parties.filter(p => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      (p.name || '').toLowerCase().includes(term) ||
      (p.lead_first_name || '').toLowerCase().includes(term) ||
      (p.lead_last_name || '').toLowerCase().includes(term) ||
      (p.lead_email || '').toLowerCase().includes(term)
    );
  });

  const allFilteredSelected = filteredParties.length > 0 && filteredParties.every(p => selectedIds.has(p.id));
  const toggleSelectAllFiltered = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const p of filteredParties) next.delete(p.id);
      } else {
        for (const p of filteredParties) next.add(p.id);
      }
      return next;
    });
  };

  /**
   * Build one or more invite jobs for a party.
   *
   * Members are automatically grouped by their primary sub-event assignment,
   * so a single party can produce multiple invite cards when members have
   * different sub-event coverage (e.g., parents invited to day+evening, kids
   * invited to evening only). Groups that map to the same template are merged
   * back into one card, so single-template setups still produce one card.
   *
   * All cards for a party share the same RSVP link and QR code.
   */
  const buildJobsForParty = async (
    party: PartyForPdf,
    assets: TemplateAsset[],
  ): Promise<Array<{ template: InviteTemplate; context: InviteContext }>> => {
    // Load event, members, member-event mappings, and sub-events in parallel
    const [eventRes, membersRes, subEventsRes] = await Promise.all([
      supabase
        .from('events')
        .select('event_title, event_start, event_location')
        .eq('id', eventUuid)
        .single(),
      supabase
        .from('invite_party_members')
        .select('id, first_name, last_name, email, is_lead_booker, sort_order')
        .eq('party_id', party.id)
        .order('sort_order'),
      supabase
        .from('invite_sub_events')
        .select('id, name, description, starts_at, sort_order')
        .eq('event_id', eventUuid)
        .order('sort_order'),
    ]);

    const event = eventRes.data;
    const members = membersRes.data || [];
    const subEvents = subEventsRes.data || [];

    if (members.length === 0) return [];

    // Load sub-event assignments for each member
    const { data: memberEvents } = await supabase
      .from('invite_party_member_events')
      .select('party_member_id, sub_event_id')
      .in('party_member_id', members.map(m => m.id));

    // Build: sub_event_id → sort_order (for determining "primary")
    const subEventOrder = new Map<string, number>();
    for (const se of subEvents) {
      subEventOrder.set(se.id, se.sort_order ?? 0);
    }

    // For each member, find their primary sub-event (first by sort_order that they're assigned to).
    // Members with no sub-event assignments get a null primary.
    const memberPrimarySubEvent = new Map<string, string | null>();
    for (const member of members) {
      const assignedSubEventIds = (memberEvents || [])
        .filter(me => me.party_member_id === member.id && me.sub_event_id)
        .map(me => me.sub_event_id as string);
      assignedSubEventIds.sort((a, b) => (subEventOrder.get(a) ?? 0) - (subEventOrder.get(b) ?? 0));
      memberPrimarySubEvent.set(member.id, assignedSubEventIds[0] || null);
    }

    // Group members by primary sub-event
    const groupsBySubEvent = new Map<string | null, typeof members>();
    for (const member of members) {
      const primary = memberPrimarySubEvent.get(member.id) || null;
      const list = groupsBySubEvent.get(primary) || [];
      list.push(member);
      groupsBySubEvent.set(primary, list);
    }

    // Resolve template per group, then merge groups that map to the same template.
    // This means: if the user only has a default template (no sub-event specific ones),
    // all groups collapse into a single card with all members.
    type MergedGroup = {
      template: InviteTemplate;
      subEventId: string | null;
      members: typeof members;
    };
    const mergedByTemplate = new Map<string, MergedGroup>();

    for (const [primarySubEventId, groupMembers] of groupsBySubEvent) {
      const template = await findMatchingTemplate(eventUuid, 'pdf', primarySubEventId);
      if (!template) continue; // skip group if no template available

      const existing = mergedByTemplate.get(template.id);
      if (existing) {
        existing.members.push(...groupMembers);
      } else {
        mergedByTemplate.set(template.id, {
          template,
          subEventId: primarySubEventId,
          members: [...groupMembers],
        });
      }
    }

    // Sort merged groups so cards come out in sub-event sort order
    const mergedList = Array.from(mergedByTemplate.values()).sort((a, b) => {
      const aOrder = a.subEventId ? (subEventOrder.get(a.subEventId) ?? 999) : 1000;
      const bOrder = b.subEventId ? (subEventOrder.get(b.subEventId) ?? 999) : 1000;
      return aOrder - bOrder;
    });

    // Build one job (= one invite card) per merged group, with a context
    // that only includes that group's members
    const jobs: Array<{ template: InviteTemplate; context: InviteContext }> = [];
    for (const group of mergedList) {
      // Sort group's members by original sort_order so name lists are consistent
      const groupMembers = [...group.members].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

      const subEventData = group.subEventId
        ? subEvents.find(se => se.id === group.subEventId) || null
        : null;

      const context = buildInviteContext(
        {
          name: party.name,
          short_code: party.short_code,
          members: groupMembers.map(m => ({
            first_name: m.first_name,
            last_name: m.last_name,
            email: m.email,
            is_lead_booker: m.is_lead_booker,
          })),
        },
        event || { event_title: eventTitle, event_start: null, event_location: null },
        subEventData,
        portalUrl,
      );

      jobs.push({ template: group.template, context });
    }

    return jobs;
  };

  const handleDownloadSingle = async (party: PartyForPdf) => {
    try {
      setProgress(`Generating ${party.name}...`);
      const assets = await getAssetsForEvent(eventUuid);
      const jobs = await buildJobsForParty(party, assets);

      if (jobs.length === 0) {
        toast.error(`No PDF template found for ${party.name}`);
        return;
      }

      // Generate either a single-page or merged multi-page PDF
      const blob = jobs.length === 1
        ? await generateInvitePdf(party, jobs[0].template, jobs[0].context, assets)
        : await generateMergedPdf(jobs, assets);

      const link = document.createElement('a');
      const suffix = jobs.length > 1 ? `_${jobs.length}_cards` : '';
      link.download = `invite_${party.name.replace(/[^a-zA-Z0-9]/g, '_')}${suffix}.pdf`;
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);

      // Log one delivery for the party (regardless of card count)
      await createDelivery({ party_id: party.id, channel: 'pdf', status: 'downloaded' });

      if (jobs.length > 1) {
        toast.success(`${jobs.length} cards downloaded for ${party.name}`);
      } else {
        toast.success(`PDF downloaded for ${party.name}`);
      }
    } catch (err) {
      console.error('Error generating PDF:', err);
      toast.error(`Failed to generate PDF for ${party.name}`);
    } finally {
      setProgress('');
    }
  };

  const handleDownloadBatch = async (batch: PartyForPdf[]) => {
    if (batch.length === 0) { toast.error('No parties'); return; }
    setGenerating(true);
    try {
      // Load assets once for the whole batch
      const assets = await getAssetsForEvent(eventUuid);

      // Build all jobs — a single party may produce multiple jobs (one card per
      // member grouping) when members have different sub-event coverage
      const allJobs: Array<{ template: InviteTemplate; context: InviteContext }> = [];
      const includedParties: PartyForPdf[] = [];
      const skipped: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const party = batch[i];
        setProgress(`Resolving ${i + 1}/${batch.length}: ${party.name}`);
        const jobs = await buildJobsForParty(party, assets);
        if (jobs.length > 0) {
          allJobs.push(...jobs);
          includedParties.push(party);
        } else {
          skipped.push(party.name);
        }
      }

      if (allJobs.length === 0) {
        toast.error('No PDF templates matched any parties');
        return;
      }

      // Generate the merged PDF
      const mergedBlob = await generateMergedPdf(
        allJobs,
        assets,
        (done, total) => setProgress(`Rendering ${done}/${total}`),
      );

      const link = document.createElement('a');
      link.download = `invites_${eventTitle.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      link.href = URL.createObjectURL(mergedBlob);
      link.click();
      URL.revokeObjectURL(link.href);

      // Log one delivery per party (regardless of how many cards each produced)
      for (const party of includedParties) {
        await createDelivery({ party_id: party.id, channel: 'pdf', status: 'downloaded' });
      }

      const cardCount = allJobs.length;
      const partyCount = includedParties.length;
      const cardWord = cardCount !== 1 ? 'cards' : 'card';
      const partyWord = partyCount !== 1 ? 'parties' : 'party';
      let msg: string;
      if (cardCount === partyCount) {
        msg = `Exported ${cardCount} ${cardWord} (${partyCount} ${partyWord}) as single PDF`;
      } else {
        msg = `Exported ${cardCount} ${cardWord} across ${partyCount} ${partyWord} as single PDF`;
      }
      if (skipped.length > 0) {
        toast.success(`${msg} (${skipped.length} skipped: no matching template)`);
      } else {
        toast.success(msg);
      }
    } catch (err) {
      console.error('Error generating merged PDF:', err);
      toast.error('Failed to generate merged PDF');
    } finally {
      setGenerating(false);
      setProgress('');
    }
  };

  return (
    <>
      <Button variant="soft" onClick={handleOpen}>
        <DocumentArrowDownIcon className="w-4 h-4 mr-1" />
        Print Invites
      </Button>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="Print Invites"
        size="lg"
        footer={
          <div className="flex items-center justify-between gap-2 w-full">
            <span className="text-xs text-[var(--gray-9)]">
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Nothing selected'}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="soft" onClick={() => setShowModal(false)}>
                Close
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const batch = parties.filter(p => selectedIds.has(p.id));
                  handleDownloadBatch(batch);
                }}
                disabled={generating || selectedIds.size === 0}
              >
                <DocumentArrowDownIcon className="w-4 h-4 mr-1" />
                {generating ? 'Generating...' : `Export Selected (${selectedIds.size})`}
              </Button>
              <Button onClick={() => handleDownloadBatch(parties)} disabled={generating || parties.length === 0}>
                <DocumentArrowDownIcon className="w-4 h-4 mr-1" />
                {generating ? 'Generating...' : `Export All (${parties.length})`}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-11)]">
            Generate PDF invitations using the configured PDF template. Tick specific parties and use &ldquo;Export Selected&rdquo;, or use &ldquo;Export All&rdquo; for the full list.
          </p>

          {progress && (
            <div className="text-sm text-[var(--accent-11)] bg-[var(--accent-3)] p-2 rounded">{progress}</div>
          )}

          {/* Search + select-all */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search parties..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            />
            <label className="flex items-center gap-2 text-xs text-[var(--gray-11)] cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleSelectAllFiltered}
                disabled={filteredParties.length === 0}
                className="cursor-pointer"
              />
              Select {search ? 'filtered' : 'all'}
            </label>
          </div>

          <div className="max-h-80 overflow-y-auto rounded border border-[var(--gray-6)]">
            {filteredParties.length === 0 ? (
              <p className="text-sm text-[var(--gray-9)] text-center py-6">
                {parties.length === 0 ? 'No parties found.' : 'No parties match your search.'}
              </p>
            ) : (
              filteredParties.map(party => {
                const checked = selectedIds.has(party.id);
                return (
                  <label
                    key={party.id}
                    className={`flex items-center justify-between gap-3 px-3 py-2 cursor-pointer border-b border-[var(--gray-4)] last:border-b-0 ${
                      checked ? 'bg-[var(--accent-3)]' : 'hover:bg-[var(--gray-3)]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelect(party.id)}
                        className="cursor-pointer shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--gray-12)] truncate">{party.name}</p>
                        <p className="text-xs text-[var(--gray-9)]">
                          {party.member_count} member{party.member_count !== 1 ? 's' : ''}
                          {party.lead_email ? ` · ${party.lead_email}` : ''}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="soft"
                      size="1"
                      onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); handleDownloadSingle(party); }}
                      title="Download single PDF"
                    >
                      <DocumentArrowDownIcon className="w-3.5 h-3.5" />
                    </Button>
                  </label>
                );
              })
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
