import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Modal } from '@/components/ui';
import { InboxArrowDownIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { getAssetsForEvent, getAssetPublicUrl, createDelivery } from './utils/inviteTemplateService';

interface EnvelopePdfGeneratorProps {
  eventUuid: string;
}

interface PartyForEnvelope {
  id: string;
  name: string;
  short_code: string;
  lead_first_name: string | null;
  lead_last_name: string | null;
  lead_email: string | null;
  address: string | null;
  member_count: number;
}

interface PartyMember {
  first_name: string | null;
  last_name: string | null;
  is_lead_booker: boolean;
  sort_order: number | null;
}

// --- Envelope sizing -------------------------------------------------------

const MM_PER_PT = 25.4 / 72;
const PT_PER_MM = 72 / 25.4;

/**
 * Standard international (ISO) and US envelope sizes, in millimetres, sorted
 * smallest → largest. Picked at runtime based on the invite's own dimensions
 * so we never assume a fixed paper size.
 */
const STANDARD_ENVELOPES: Array<{ name: string; wMm: number; hMm: number }> = [
  { name: 'C7', wMm: 81, hMm: 114 },
  { name: 'B7', wMm: 88, hMm: 125 },
  { name: 'US A2', wMm: 111, hMm: 146 },
  { name: 'C7/6', wMm: 81, hMm: 162 },
  { name: 'C6', wMm: 114, hMm: 162 },
  { name: 'US A6', wMm: 120, hMm: 165 },
  { name: 'B6', wMm: 125, hMm: 176 },
  { name: 'US A7', wMm: 133, hMm: 184 },
  { name: 'DL', wMm: 110, hMm: 220 },
  { name: 'C6/5', wMm: 114, hMm: 229 },
  { name: 'C5', wMm: 162, hMm: 229 },
  { name: 'B5', wMm: 176, hMm: 250 },
  { name: 'C4', wMm: 229, hMm: 324 },
  { name: 'B4', wMm: 250, hMm: 353 },
];

/**
 * Minimum breathing room around the invite inside the envelope.
 * 2 mm is snug but realistic — "just larger than" the invite.
 */
const MIN_MARGIN_MM = 2;

/**
 * Pick the smallest standard envelope whose short/long edges both clear the
 * invite (in either orientation) by MIN_MARGIN_MM per side, then return its
 * dimensions in landscape orientation — long edge is width, short edge is
 * height — which is how envelopes are typically addressed.
 */
function pickEnvelopeSize(inviteWPt: number, inviteHPt: number): { name: string; wPt: number; hPt: number } {
  const needWMm = inviteWPt * MM_PER_PT + 2 * MIN_MARGIN_MM;
  const needHMm = inviteHPt * MM_PER_PT + 2 * MIN_MARGIN_MM;
  const needShort = Math.min(needWMm, needHMm);
  const needLong = Math.max(needWMm, needHMm);

  const ranked = [...STANDARD_ENVELOPES].sort((a, b) => (a.wMm * a.hMm) - (b.wMm * b.hMm));

  for (const env of ranked) {
    const envShort = Math.min(env.wMm, env.hMm);
    const envLong = Math.max(env.wMm, env.hMm);
    if (envShort >= needShort && envLong >= needLong) {
      return { name: env.name, wPt: envLong * PT_PER_MM, hPt: envShort * PT_PER_MM };
    }
  }

  const last = ranked[ranked.length - 1];
  const lastShort = Math.min(last.wMm, last.hMm);
  const lastLong = Math.max(last.wMm, last.hMm);
  return { name: last.name, wPt: lastLong * PT_PER_MM, hPt: lastShort * PT_PER_MM };
}

// --- Addressee + address formatting ---------------------------------------

/**
 * Build the addressee line shown at the top of the envelope.
 *
 *  1 member  → "First Last"
 *  2 members → "First & First"
 *  3+        → "First, First, First & First"   (ampersand before the last)
 *
 * Lead booker always comes first; the rest follow their sort_order. A member
 * with no first_name still shows up, using their last_name as a fallback —
 * we never want to silently drop a real person from the envelope.
 */
function formatAddressee(members: PartyMember[]): string {
  const sorted = [...members].sort((a, b) => {
    if (a.is_lead_booker !== b.is_lead_booker) return a.is_lead_booker ? -1 : 1;
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });

  const displayNames = sorted.map(m => {
    const first = (m.first_name || '').trim();
    const last = (m.last_name || '').trim();
    return first || last;
  }).filter(Boolean);

  if (displayNames.length === 0) return '';
  if (displayNames.length === 1) {
    return [sorted[0].first_name, sorted[0].last_name]
      .map(v => (v || '').trim())
      .filter(Boolean)
      .join(' ');
  }
  if (displayNames.length === 2) return `${displayNames[0]} & ${displayNames[1]}`;
  return `${displayNames.slice(0, -1).join(', ')} & ${displayNames[displayNames.length - 1]}`;
}

/**
 * Turn a comma-delimited address into one line per segment.
 * "108 Martens Avenue, Bexley Heath, Kent, DA7 6AN"
 *   → ["108 Martens Avenue", "Bexley Heath", "Kent", "DA7 6AN"]
 */
function formatAddressLines(address: string | null | undefined): string[] {
  if (!address) return [];
  return address
    .split(/\r?\n|,/)
    .map(s => s.trim())
    .filter(Boolean);
}

// --- Invite dimensions -----------------------------------------------------

/**
 * Determine the invite size by reading the MediaBox of each PDF template's
 * background. If a template has no background we fall back to the generator's
 * default page size (see InvitePdfGenerator). Returns the largest WxH observed
 * so the envelope fits every invite variant this event produces.
 */
async function getInviteDimensions(
  eventUuid: string,
  pdfLib: typeof import('pdf-lib'),
): Promise<{ wPt: number; hPt: number }> {
  const DEFAULT_W = 297.75;
  const DEFAULT_H = 419.25;

  const { data: templates } = await supabase
    .from('invite_templates')
    .select('pdf_background_path')
    .eq('event_id', eventUuid)
    .eq('channel', 'pdf')
    .eq('is_active', true);

  const paths = Array.from(new Set(
    (templates || []).map(t => t.pdf_background_path).filter(Boolean) as string[],
  ));

  if (paths.length === 0) return { wPt: DEFAULT_W, hPt: DEFAULT_H };

  const assets = await getAssetsForEvent(eventUuid);

  let maxW = 0;
  let maxH = 0;
  for (const path of paths) {
    const bgAsset = assets.find(a => a.storage_path === path);
    if (!bgAsset) continue;
    try {
      const bgUrl = getAssetPublicUrl(bgAsset);
      const bgBytes = await fetch(bgUrl).then(r => r.arrayBuffer());
      const bgDoc = await pdfLib.PDFDocument.load(bgBytes);
      const page = bgDoc.getPage(0);
      maxW = Math.max(maxW, page.getWidth());
      maxH = Math.max(maxH, page.getHeight());
    } catch (err) {
      console.warn(`Failed to read invite template ${path}:`, err);
    }
  }

  if (maxW === 0 || maxH === 0) return { wPt: DEFAULT_W, hPt: DEFAULT_H };
  return { wPt: maxW, hPt: maxH };
}

// --- Envelope page rendering ----------------------------------------------

/**
 * Draw a left-aligned, single-size addressee + address block on the envelope.
 *
 * Layout: vertically centred, inset from the left edge by LEFT_MARGIN_RATIO
 * of the envelope width. Addressee is followed by a blank line and then one
 * line per comma-split address segment.
 */
function renderEnvelopePage(
  page: import('pdf-lib').PDFPage,
  envelope: { wPt: number; hPt: number },
  addressee: string,
  addressLines: string[],
  font: import('pdf-lib').PDFFont,
  pdfLib: typeof import('pdf-lib'),
): void {
  const { rgb } = pdfLib;
  const black = rgb(0, 0, 0);

  const fontSize = 12;
  const lineLeading = 4; // extra gap between consecutive lines
  const gapBetweenAddresseeAndAddress = fontSize + lineLeading; // one blank line
  const LEFT_MARGIN_RATIO = 0.18;

  const hasAddressee = addressee.length > 0;
  const totalLines = (hasAddressee ? 1 : 0) + addressLines.length;
  if (totalLines === 0) return;

  const spacerCount = hasAddressee && addressLines.length > 0
    ? 1  // addressee → address separator
    : 0;
  const totalH = totalLines * fontSize
    + Math.max(0, totalLines - 1 - spacerCount) * lineLeading
    + spacerCount * gapBetweenAddresseeAndAddress;

  const x = envelope.wPt * LEFT_MARGIN_RATIO;
  let cursorY = (envelope.hPt + totalH) / 2 - fontSize;

  if (hasAddressee) {
    page.drawText(addressee, { x, y: cursorY, size: fontSize, font, color: black });
    cursorY -= gapBetweenAddresseeAndAddress;
  }

  for (let i = 0; i < addressLines.length; i++) {
    page.drawText(addressLines[i], { x, y: cursorY, size: fontSize, font, color: black });
    cursorY -= fontSize + lineLeading;
  }
}

// --- Data loading ---------------------------------------------------------

async function fetchPartyMembersByPartyIds(
  partyIds: string[],
): Promise<Map<string, PartyMember[]>> {
  const out = new Map<string, PartyMember[]>();
  if (partyIds.length === 0) return out;

  const { data } = await supabase
    .from('invite_party_members')
    .select('party_id, first_name, last_name, is_lead_booker, sort_order')
    .in('party_id', partyIds)
    .order('sort_order', { ascending: true });

  for (const m of data || []) {
    const list = out.get(m.party_id) || [];
    list.push({
      first_name: m.first_name,
      last_name: m.last_name,
      is_lead_booker: !!m.is_lead_booker,
      sort_order: m.sort_order,
    });
    out.set(m.party_id, list);
  }
  return out;
}

// --- PDF generation --------------------------------------------------------

async function generateEnvelopesPdf(
  parties: PartyForEnvelope[],
  envelope: { name: string; wPt: number; hPt: number },
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const pdfLib = await import('pdf-lib');
  const { PDFDocument, StandardFonts } = pdfLib;

  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  const membersByParty = await fetchPartyMembersByPartyIds(parties.map(p => p.id));

  for (let i = 0; i < parties.length; i++) {
    const party = parties[i];
    const members = membersByParty.get(party.id) || [];
    const addressee = formatAddressee(members);
    const addressLines = formatAddressLines(party.address);

    const page = doc.addPage([envelope.wPt, envelope.hPt]);
    renderEnvelopePage(page, envelope, addressee, addressLines, helvetica, pdfLib);

    onProgress?.(i + 1, parties.length);
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

// --- Component -------------------------------------------------------------

export function EnvelopePdfGenerator({ eventUuid }: EnvelopePdfGeneratorProps) {
  const [showModal, setShowModal] = useState(false);
  const [parties, setParties] = useState<PartyForEnvelope[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');
  const [envelopeInfo, setEnvelopeInfo] = useState<string>('');

  const loadData = useCallback(async () => {
    // Same query/ordering as InvitePdfGenerator so envelopes print in the same
    // order as the invite batch
    const { data: partyData } = await supabase
      .from('invite_parties_with_stats')
      .select('id, name, short_code, lead_first_name, lead_last_name, lead_email, member_count, event_ids, address')
      .contains('event_ids', [eventUuid]);
    setParties((partyData || []) as PartyForEnvelope[]);

    const { data: event } = await supabase
      .from('events')
      .select('event_title')
      .eq('id', eventUuid)
      .single();
    setEventTitle(event?.event_title || 'Event');

    // Resolve the envelope size once up-front so we can show the user which
    // size we'll use before they click export
    try {
      const pdfLib = await import('pdf-lib');
      const invite = await getInviteDimensions(eventUuid, pdfLib);
      const env = pickEnvelopeSize(invite.wPt, invite.hPt);
      const wMm = Math.round(env.wPt * MM_PER_PT);
      const hMm = Math.round(env.hPt * MM_PER_PT);
      const invWMm = Math.round(invite.wPt * MM_PER_PT);
      const invHMm = Math.round(invite.hPt * MM_PER_PT);
      setEnvelopeInfo(`${env.name} envelope, landscape (${wMm} × ${hMm} mm) for ${invWMm} × ${invHMm} mm invite`);
    } catch (err) {
      console.warn('Failed to resolve envelope size:', err);
      setEnvelopeInfo('');
    }
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
      (p.lead_email || '').toLowerCase().includes(term) ||
      (p.address || '').toLowerCase().includes(term)
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

  const resolveEnvelope = async () => {
    const pdfLib = await import('pdf-lib');
    const invite = await getInviteDimensions(eventUuid, pdfLib);
    return pickEnvelopeSize(invite.wPt, invite.hPt);
  };

  const handleDownloadSingle = async (party: PartyForEnvelope) => {
    try {
      setProgress(`Generating envelope for ${party.name}...`);
      const envelope = await resolveEnvelope();
      const blob = await generateEnvelopesPdf([party], envelope);

      const link = document.createElement('a');
      link.download = `envelope_${party.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);

      await createDelivery({ party_id: party.id, channel: 'pdf', status: 'downloaded' });
      toast.success(`Envelope downloaded for ${party.name}`);
    } catch (err) {
      console.error('Error generating envelope PDF:', err);
      toast.error(`Failed to generate envelope for ${party.name}`);
    } finally {
      setProgress('');
    }
  };

  const handleDownloadBatch = async (batch: PartyForEnvelope[]) => {
    if (batch.length === 0) { toast.error('No parties'); return; }
    setGenerating(true);
    try {
      const envelope = await resolveEnvelope();
      const blob = await generateEnvelopesPdf(batch, envelope, (done, total) => {
        setProgress(`Rendering ${done}/${total}`);
      });

      const link = document.createElement('a');
      link.download = `envelopes_${eventTitle.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);

      for (const p of batch) {
        await createDelivery({ party_id: p.id, channel: 'pdf', status: 'downloaded' });
      }

      const word = batch.length !== 1 ? 'envelopes' : 'envelope';
      toast.success(`${batch.length} ${word} exported as single PDF (${envelope.name})`);
    } catch (err) {
      console.error('Error generating envelopes PDF:', err);
      toast.error('Failed to generate envelopes PDF');
    } finally {
      setGenerating(false);
      setProgress('');
    }
  };

  const renderPartyMeta = (party: PartyForEnvelope): string => {
    const pieces: string[] = [];
    pieces.push(`${party.member_count} member${party.member_count !== 1 ? 's' : ''}`);
    if (party.address) {
      pieces.push(party.address.length > 40 ? party.address.slice(0, 40) + '…' : party.address);
    } else {
      pieces.push('no address');
    }
    return pieces.join(' · ');
  };

  return (
    <>
      <Button variant="soft" onClick={handleOpen}>
        <InboxArrowDownIcon className="w-4 h-4 mr-1" />
        Print Envelopes
      </Button>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="Print Envelopes"
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
                <InboxArrowDownIcon className="w-4 h-4 mr-1" />
                {generating ? 'Generating...' : `Export Selected (${selectedIds.size})`}
              </Button>
              <Button onClick={() => handleDownloadBatch(parties)} disabled={generating || parties.length === 0}>
                <InboxArrowDownIcon className="w-4 h-4 mr-1" />
                {generating ? 'Generating...' : `Export All (${parties.length})`}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-11)]">
            Generate a multi-page PDF with one envelope per party, printed in the same order as the invites.
            Addressees are formatted from each party&apos;s members; addresses split at every comma onto their own line.
          </p>

          {envelopeInfo && (
            <div className="text-xs text-[var(--gray-11)] bg-[var(--gray-3)] px-2.5 py-1.5 rounded">
              {envelopeInfo}
            </div>
          )}

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
                        <p className="text-xs text-[var(--gray-9)] truncate">{renderPartyMeta(party)}</p>
                      </div>
                    </div>
                    <Button
                      variant="soft"
                      size="1"
                      onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); handleDownloadSingle(party); }}
                      title="Download single envelope"
                    >
                      <InboxArrowDownIcon className="w-3.5 h-3.5" />
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
