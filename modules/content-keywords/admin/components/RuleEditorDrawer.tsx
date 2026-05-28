import { useEffect, useState } from 'react';
import { Button, Modal, Badge } from '@/components/ui';
import { keywordRulesService, type KeywordRule, type AdapterRow } from '../utils/keywordRulesService';

const inputClass =
  'w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

interface Props {
  rule: KeywordRule | null;
  adapters: AdapterRow[];
  onClose: () => void;
  onSaved: () => void;
}

export function RuleEditorDrawer({ rule, adapters, onClose, onSaved }: Props) {
  const isCreate = !rule;
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [patternType, setPatternType] = useState<'substring' | 'word' | 'regex'>(rule?.pattern_type ?? 'substring');
  const [caseSensitive, setCaseSensitive] = useState(rule?.case_sensitive ?? false);
  const [contentTypes, setContentTypes] = useState<string[]>(rule?.content_types ?? []);
  const [sources, setSources] = useState<string>((rule?.sources ?? []).join(', '));
  const [fields, setFields] = useState<string[]>(rule?.fields ?? ['any']);
  const [isActive, setIsActive] = useState(rule?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Available fields = union of declared_fields for selected content_types.
  const availableFields = Array.from(new Set(
    adapters
      .filter(a => contentTypes.includes(a.content_type))
      .flatMap(a => a.declared_fields)
  ));

  useEffect(() => {
    // Reset fields if content_types change leaves selected fields invalid.
    if (fields[0] !== 'any') {
      const filtered = fields.filter(f => availableFields.includes(f));
      if (filtered.length !== fields.length) {
        setFields(filtered.length > 0 ? filtered : ['any']);
      }
    }
  }, [contentTypes.join(',')]);

  const toggleContentType = (ct: string) => {
    setContentTypes(prev => prev.includes(ct) ? prev.filter(x => x !== ct) : [...prev, ct]);
  };

  const toggleField = (f: string) => {
    if (f === 'any') { setFields(['any']); return; }
    setFields(prev => {
      const filtered = prev.filter(x => x !== 'any');
      return filtered.includes(f) ? filtered.filter(x => x !== f) : [...filtered, f];
    });
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const sourcesArr = sources.split(',').map(s => s.trim()).filter(Boolean);
      const payload = {
        name,
        description: description || null,
        pattern,
        pattern_type: patternType,
        case_sensitive: caseSensitive,
        content_types: contentTypes,
        sources: sourcesArr.length > 0 ? sourcesArr : null,
        fields: fields.length > 0 ? fields : ['any'],
        is_active: isActive,
      };
      if (isCreate) {
        await keywordRulesService.createRule(payload);
      } else {
        await keywordRulesService.updateRule(rule!.id, payload, rule!.row_version);
      }
      onSaved();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!rule || !confirm('Permanently delete this rule? Use Deactivate to keep history.')) return;
    setSaving(true);
    try {
      await keywordRulesService.deleteRule(rule.id);
      onSaved();
    } catch (err: any) {
      setError(err.message ?? String(err));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={isCreate ? 'New keyword rule' : `Edit: ${rule?.name}`} size="lg">
      <div className="p-4 space-y-4">
        {error && (
          <div className="p-3 rounded bg-[var(--red-a3)] text-sm text-[var(--red-11)]">{error}</div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input className={inputClass} value={name} onChange={e => setName(e.target.value)} maxLength={100} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Pattern</label>
          <input className={inputClass} value={pattern} onChange={e => setPattern(e.target.value)} maxLength={500} />
          <div className="flex gap-2 mt-2">
            {(['substring', 'word', 'regex'] as const).map(t => (
              <button key={t} type="button" onClick={() => setPatternType(t)} className={`px-3 py-1 text-xs rounded ${patternType === t ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)]'}`}>
                {t}
              </button>
            ))}
            <label className="ml-2 text-xs flex items-center gap-1">
              <input type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} />
              Case sensitive
            </label>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description (optional)</label>
          <textarea className={inputClass} value={description ?? ''} onChange={e => setDescription(e.target.value)} rows={2} maxLength={1000} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Content types</label>
          <div className="flex flex-wrap gap-2">
            {adapters.map(a => (
              <button
                key={a.content_type}
                type="button"
                onClick={() => toggleContentType(a.content_type)}
                className={`px-3 py-1 text-xs rounded ${contentTypes.includes(a.content_type) ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)]'}`}
              >
                {a.display_label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Fields</label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => toggleField('any')} className={`px-3 py-1 text-xs rounded ${fields[0] === 'any' ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)]'}`}>any</button>
            {availableFields.map(f => (
              <button key={f} type="button" onClick={() => toggleField(f)} className={`px-3 py-1 text-xs rounded ${fields.includes(f) && fields[0] !== 'any' ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)]'}`}>
                {f}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Sources (optional, comma-separated)</label>
          <input className={inputClass} value={sources} onChange={e => setSources(e.target.value)} placeholder="luma, meetup, …" />
          <p className="text-xs text-[var(--gray-10)] mt-1">Leave empty to apply across all sources.</p>
        </div>

        <div className="flex items-center gap-2">
          <input id="is_active" type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          <label htmlFor="is_active" className="text-sm">Active</label>
          {!isCreate && rule && <Badge variant="soft" color="gray" className="ml-2">v{rule.row_version}</Badge>}
        </div>

        <div className="pt-4 border-t border-[var(--gray-a4)] flex gap-2 justify-between">
          <div>
            {!isCreate && (
              <Button variant="ghost" color="red" onClick={remove} disabled={saving}>Delete</Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving || !name || !pattern || contentTypes.length === 0}>
              {saving ? 'Saving…' : (isCreate ? 'Create rule' : 'Save changes')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
