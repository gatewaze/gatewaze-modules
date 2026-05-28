import { useEffect, useState } from 'react';
import { Button, Card } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { keywordRulesService, type AdapterRow, type PreviewImpact } from '../utils/keywordRulesService';

export default function PreviewImpactPage() {
  const [adapters, setAdapters] = useState<AdapterRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<PreviewImpact | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { keywordRulesService.listAdapters().then(setAdapters); }, []);

  const run = async () => {
    setErr(null); setRunning(true); setResult(null);
    try {
      const r = await keywordRulesService.previewImpact(selected, [], 'approx');
      setResult(r);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Page title="Preview impact">
      <div className="p-6">
        <h1 className="text-2xl font-semibold mb-4">Preview keyword impact</h1>
        <p className="text-sm text-[var(--gray-11)] mb-6">
          Select content types to estimate how the current rule set affects visibility. Delta-based "what if I edit this rule" preview will arrive in a future iteration.
        </p>

        <Card className="p-4 mb-4">
          <div className="flex flex-wrap gap-2 mb-4">
            {adapters.map(a => (
              <button
                key={a.content_type}
                type="button"
                onClick={() => setSelected(prev => prev.includes(a.content_type) ? prev.filter(x => x !== a.content_type) : [...prev, a.content_type])}
                className={`px-3 py-1 text-xs rounded ${selected.includes(a.content_type) ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)]'}`}
              >
                {a.display_label}
              </button>
            ))}
          </div>
          <Button onClick={run} disabled={running || selected.length === 0}>
            {running ? 'Running…' : 'Compute current visibility'}
          </Button>
        </Card>

        {err && <Card className="p-4 mb-4 bg-[var(--red-a3)] text-[var(--red-11)]">{err}</Card>}

        {result && (
          <Card className="p-4">
            <h3 className="font-medium mb-2">Results ({result.mode})</h3>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--gray-a4)]">
                <th className="text-left py-2">Content type</th>
                <th className="text-right">Total</th>
                <th className="text-right">Visible now</th>
                <th className="text-right">Will become visible</th>
                <th className="text-right">Will become hidden</th>
                <th className="text-right">Sampled</th>
              </tr></thead>
              <tbody>
                {Object.entries(result.by_content_type).map(([ct, r]) => (
                  <tr key={ct} className="border-b border-[var(--gray-a3)] last:border-0">
                    <td className="py-2"><code className="text-xs">{ct}</code></td>
                    <td className="text-right">{r.total_rows_estimate}</td>
                    <td className="text-right">{r.current_visible}</td>
                    <td className="text-right">{r.will_become_visible}</td>
                    <td className="text-right">{r.will_become_hidden}</td>
                    <td className="text-right">{r.sampled_rows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </Page>
  );
}
