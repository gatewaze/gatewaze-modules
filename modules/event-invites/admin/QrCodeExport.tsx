import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { QRCodeService } from '@/utils/qrCodeService';
import { Button, Modal } from '@/components/ui';
import { QrCodeIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

interface QrCodeExportProps {
  eventUuid: string;
}

interface PartyForQr {
  id: string;
  name: string;
  short_code: string;
}

const portalUrl = import.meta.env.VITE_PORTAL_URL || import.meta.env.VITE_APP_URL || '';

async function generateQrDataUrl(text: string, size = 300): Promise<string> {
  return QRCodeService.generateQRCode({
    data: text,
    size,
    color: '#000000',
    backgroundColor: '#ffffff',
  });
}


export function QrCodeExport({ eventUuid }: QrCodeExportProps) {
  const [showModal, setShowModal] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewParty, setPreviewParty] = useState<PartyForQr | null>(null);
  const [parties, setParties] = useState<PartyForQr[]>([]);
  const [qrSize, setQrSize] = useState(600);
  const [customDomainUrl, setCustomDomainUrl] = useState<string | null>(null);

  // Look up custom domain for this event
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL || '';
    fetch(`${apiUrl}/api/modules/custom-domains/lookup/events/${eventUuid}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.url) setCustomDomainUrl(data.url);
      })
      .catch(() => { /* custom domains module may not be enabled */ });
  }, [eventUuid]);

  const loadParties = useCallback(async () => {
    const { data } = await supabase
      .from('invite_parties_with_stats')
      .select('id, name, short_code, event_ids')
      .contains('event_ids', [eventUuid]);

    setParties((data || []) as PartyForQr[]);
  }, [eventUuid]);

  const handleOpen = async () => {
    setShowModal(true);
    await loadParties();
  };

  const handlePreview = async (party: PartyForQr) => {
    setPreviewParty(party);
    try {
      const url = `${customDomainUrl || portalUrl}/rsvp/${party.short_code}`;
      const dataUrl = await generateQrDataUrl(url, 300);
      setPreviewUrl(dataUrl);
    } catch (error) {
      console.error('Error generating QR preview:', error);
      toast.error('Failed to generate QR code');
    }
  };

  const handleDownloadSingle = async (party: PartyForQr) => {
    try {
      const url = `${customDomainUrl || portalUrl}/rsvp/${party.short_code}`;
      const dataUrl = await generateQrDataUrl(url, qrSize);

      const link = document.createElement('a');
      link.download = `${party.name.replace(/[^a-zA-Z0-9]/g, '_')}_qr.png`;
      link.href = dataUrl;
      link.click();

      toast.success(`QR code downloaded for ${party.name}`);
    } catch (error) {
      console.error('Error downloading QR:', error);
      toast.error('Failed to download QR code');
    }
  };

  const handleBulkExport = async () => {
    if (parties.length === 0) {
      toast.error('No parties to export');
      return;
    }

    setGenerating(true);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      for (let i = 0; i < parties.length; i++) {
        const party = parties[i];
        const url = `${customDomainUrl || portalUrl}/rsvp/${party.short_code}`;
        const dataUrl = await generateQrDataUrl(url, qrSize);

        // Convert data URL to binary
        const base64 = dataUrl.split(',')[1];
        const fileName = `${party.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
        zip.file(fileName, base64, { base64: true });
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.download = `invite_qr_codes_${new Date().toISOString().split('T')[0]}.zip`;
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);

      toast.success(`Exported ${parties.length} QR codes`);
    } catch (error) {
      console.error('Error bulk exporting QR codes:', error);
      toast.error('Failed to export QR codes');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <Button variant="soft" onClick={handleOpen}>
        <QrCodeIcon className="w-4 h-4 mr-1" />
        QR Codes
      </Button>

      <Modal
        isOpen={showModal}
        onClose={() => { setShowModal(false); setPreviewUrl(null); setPreviewParty(null); }}
        title="QR Code Export"
        size="lg"
        footer={
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--gray-11)]">Size</label>
              <select
                value={qrSize}
                onChange={e => setQrSize(parseInt(e.target.value))}
                className="px-2 py-1 text-sm border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]"
              >
                <option value={300}>300px (screen)</option>
                <option value={600}>600px (print)</option>
                <option value={1200}>1200px (high-res)</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button variant="soft" onClick={() => { setShowModal(false); setPreviewUrl(null); setPreviewParty(null); }}>
                Close
              </Button>
              <Button onClick={handleBulkExport} disabled={generating || parties.length === 0}>
                <ArrowDownTrayIcon className="w-4 h-4 mr-1" />
                {generating ? 'Generating...' : `Export All (${parties.length})`}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">

          {/* Preview */}
          {previewUrl && previewParty && (
            <div className="flex flex-col items-center gap-2 p-4 bg-[var(--gray-2)] rounded-lg">
              <img src={previewUrl} alt="QR Code" className="w-48 h-48" />
              <p className="text-sm font-medium text-[var(--gray-12)]">{previewParty.name}</p>
              <p className="text-xs text-[var(--gray-9)]">{portalUrl}/rsvp/{previewParty.short_code}</p>
              <Button variant="soft" size="1" onClick={() => handleDownloadSingle(previewParty)}>
                <ArrowDownTrayIcon className="w-3.5 h-3.5 mr-1" />
                Download PNG
              </Button>
            </div>
          )}

          {/* Party list */}
          <div className="max-h-64 overflow-y-auto space-y-1">
            {parties.map(party => (
              <div
                key={party.id}
                className={`flex items-center justify-between px-3 py-2 rounded cursor-pointer hover:bg-[var(--gray-3)] ${
                  previewParty?.id === party.id ? 'bg-[var(--accent-3)]' : ''
                }`}
                onClick={() => handlePreview(party)}
              >
                <div>
                  <p className="text-sm font-medium text-[var(--gray-12)]">{party.name}</p>
                  <p className="text-xs text-[var(--gray-9)]">{party.short_code}</p>
                </div>
                <Button
                  variant="soft"
                  size="1"
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDownloadSingle(party); }}
                >
                  <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>

          {parties.length === 0 && (
            <p className="text-sm text-[var(--gray-9)] text-center py-4">
              No parties found for this event.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
