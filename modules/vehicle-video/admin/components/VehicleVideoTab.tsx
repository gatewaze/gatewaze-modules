/**
 * Vehicle Video — entry tab. Shows the dealer's live Auto Trader stock
 * (inventory-first); pick a vehicle to generate. Also lists past runs and allows
 * generating from a pasted Auto Trader car-details URL.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Badge, Button, Input, WorkspaceLayout } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  listInventory,
  refreshInventory,
  listRuns,
  createRunFromListing,
  createRunFromUrl,
  deleteRun,
  type StockVehicle,
  type Run,
} from '../utils/vehicleVideoService';

export default function VehicleVideoTab() {
  const navigate = useNavigate();
  const [vehicles, setVehicles] = useState<StockVehicle[]>([]);
  const [stale, setStale] = useState(false);
  const [invLoading, setInvLoading] = useState(true);
  const [invError, setInvError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [url, setUrl] = useState('');
  const [creating, setCreating] = useState(false);

  async function loadInventory() {
    setInvLoading(true);
    setInvError(null);
    try {
      const r = await listInventory();
      setVehicles(r.vehicles);
      setStale(r.stale);
    } catch (e) {
      setInvError((e as Error).message);
    } finally {
      setInvLoading(false);
    }
  }
  async function loadRuns() {
    try {
      setRuns((await listRuns()).runs);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  useEffect(() => {
    loadInventory();
    loadRuns();
  }, []);

  async function generate(listingId: string) {
    setCreating(true);
    try {
      const { id } = await createRunFromListing(listingId);
      toast.success('Generating — pulling the listing');
      navigate(`/vehicle-video/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function generateFromUrl() {
    if (!url.trim()) return;
    setCreating(true);
    try {
      const { id } = await createRunFromUrl(url.trim());
      navigate(`/vehicle-video/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <WorkspaceLayout title="Vehicle Videos" subtitle="Generate AI showcase videos from your Auto Trader stock">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Input placeholder="Paste an Auto Trader car-details URL…" value={url} onChange={(e: any) => setUrl(e.target.value)} />
        <Button onClick={generateFromUrl} disabled={creating || !url.trim()}>Generate</Button>
        <Button variant="secondary" onClick={async () => { await refreshInventory(); loadInventory(); }}>Refresh stock</Button>
      </div>

      <h3>Your stock {stale && <Badge color="amber">cached (Auto Trader unreachable)</Badge>}</h3>
      {invLoading ? (
        <LoadingSpinner />
      ) : invError ? (
        <p style={{ color: 'var(--danger, #c00)' }}>Inventory unavailable: {invError}</p>
      ) : vehicles.length === 0 ? (
        <p>No stock found. Set VEHICLE_VIDEO_AUTOTRADER_RETAILER_ID, or paste a car-details URL above.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {vehicles.map((v) => (
            <div key={v.listing_id} style={{ border: '1px solid #e2e2e2', borderRadius: 8, overflow: 'hidden' }}>
              {v.thumbnail_url && <img src={v.thumbnail_url} alt={v.title ?? ''} style={{ width: '100%', height: 130, objectFit: 'cover' }} />}
              <div style={{ padding: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{v.title ?? `Listing ${v.listing_id}`}</div>
                <div style={{ fontSize: 13, color: '#666' }}>{[v.price, v.mileage].filter(Boolean).join(' · ')}</div>
                <Button style={{ marginTop: 8, width: '100%' }} disabled={creating} onClick={() => generate(v.listing_id)}>
                  Generate video
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Recent videos</h3>
      {runs.length === 0 ? (
        <p>No videos yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              <th>Vehicle</th><th>Script</th><th>Video</th><th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const v = r.vehicle ?? {};
              const label = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || r.source_url || r.id.slice(0, 8);
              return (
                <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }} onClick={() => navigate(`/vehicle-video/${r.id}`)}>
                  <td style={{ padding: '6px 4px' }}>{label}</td>
                  <td><Badge>{r.script_status}</Badge></td>
                  <td><Badge color={r.video_status === 'complete' ? 'green' : undefined}>{r.video_status}</Badge></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" onClick={async () => { await deleteRun(r.id); loadRuns(); }}>Delete</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WorkspaceLayout>
  );
}
