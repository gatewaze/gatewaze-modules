import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { ArrowUpTrayIcon, DocumentTextIcon, CheckIcon } from '@heroicons/react/24/outline';
import { Button, Card, Select, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import {
  SrCollection,
  SrSectionTemplate,
  CollectionsService,
  SectionTemplatesService,
  MarkdownImporter,
  ParsedImport,
} from '../../utils/structuredResourcesService';

type ImportStep = 'input' | 'preview' | 'mapping' | 'complete';

const ImportPage: React.FC = () => {
  const [step, setStep] = useState<ImportStep>('input');
  const [markdown, setMarkdown] = useState('');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [collections, setCollections] = useState<SrCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  const [createNew, setCreateNew] = useState(true);
  const [templates, setTemplates] = useState<SrSectionTemplate[]>([]);
  const [sectionMap, setSectionMap] = useState<Map<string, string>>(new Map());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ categories: number; items: number; sections: number } | null>(null);

  useEffect(() => {
    CollectionsService.getAll().then(res => {
      if (res.success && res.data) setCollections(res.data);
    });
  }, []);

  useEffect(() => {
    if (selectedCollectionId) {
      SectionTemplatesService.getByCollection(selectedCollectionId).then(res => {
        if (res.success && res.data) setTemplates(res.data);
      });
    } else {
      setTemplates([]);
    }
  }, [selectedCollectionId]);

  const handleParse = () => {
    if (!markdown.trim()) {
      toast.error('Please paste or type markdown content');
      return;
    }

    try {
      const result = MarkdownImporter.parse(markdown);
      if (result.categories.length === 0) {
        toast.error('No categories found. Use ## headings for categories and ### for items.');
        return;
      }
      setParsed(result);
      setStep('preview');
    } catch {
      toast.error('Failed to parse markdown');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      setMarkdown(evt.target?.result as string || '');
    };
    reader.readAsText(file);
  };

  const proceedToMapping = () => {
    if (!createNew && !selectedCollectionId) {
      toast.error('Please select a target collection');
      return;
    }
    // Collect unique section headings from parsed content
    if (parsed) {
      const headings = new Set<string>();
      for (const cat of parsed.categories) {
        for (const item of cat.items) {
          for (const sec of item.sections) {
            headings.add(sec.heading);
          }
        }
      }
      // Auto-map by matching heading names to existing templates
      const autoMap = new Map<string, string>();
      for (const heading of headings) {
        const match = templates.find(t => t.heading.toLowerCase() === heading.toLowerCase());
        if (match) autoMap.set(heading, match.id);
      }
      setSectionMap(autoMap);
    }
    setStep('mapping');
  };

  const handleImport = async () => {
    if (!parsed) return;
    setImporting(true);

    try {
      let targetCollectionId = selectedCollectionId;

      if (createNew) {
        const res = await CollectionsService.create({
          name: parsed.title || 'Imported Collection',
          status: 'draft',
          access: 'inherit',
        });
        if (!res.success || !res.data) {
          toast.error(res.error || 'Failed to create collection');
          return;
        }
        targetCollectionId = res.data.id;

        // Create section templates from unique headings
        const headings = new Set<string>();
        for (const cat of parsed.categories) {
          for (const item of cat.items) {
            for (const sec of item.sections) {
              headings.add(sec.heading);
            }
          }
        }

        let order = 0;
        const newTemplateMap = new Map<string, string>();
        for (const heading of headings) {
          const tplRes = await SectionTemplatesService.create({
            collection_id: targetCollectionId,
            heading,
            sort_order: order++,
          });
          if (tplRes.success && tplRes.data) {
            newTemplateMap.set(heading, tplRes.data.id);
          }
        }
        setSectionMap(newTemplateMap);

        const importRes = await MarkdownImporter.importToCollection(targetCollectionId, parsed, newTemplateMap);
        if (importRes.success && importRes.data) {
          setResult(importRes.data);
          setStep('complete');
          toast.success('Import complete!');
        } else {
          toast.error(importRes.error || 'Import failed');
        }
      } else {
        const importRes = await MarkdownImporter.importToCollection(targetCollectionId, parsed, sectionMap);
        if (importRes.success && importRes.data) {
          setResult(importRes.data);
          setStep('complete');
          toast.success('Import complete!');
        } else {
          toast.error(importRes.error || 'Import failed');
        }
      }
    } catch (err: any) {
      toast.error(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const totalItems = parsed?.categories.reduce((sum, c) => sum + c.items.length, 0) || 0;
  const totalSections = parsed?.categories.reduce((sum, c) =>
    sum + c.items.reduce((s, i) => s + i.sections.length, 0), 0) || 0;

  return (
    <Page title="Import Markdown">
      <WorkspaceLayout title="Resources">
        <div className="space-y-6 max-w-4xl mx-auto">
          <div>
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Import Markdown</h2>
            <p className="text-[var(--gray-11)] mt-1">Import structured content from a markdown file</p>
          </div>

          {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {['Input', 'Preview', 'Mapping', 'Complete'].map((label, i) => {
          const steps: ImportStep[] = ['input', 'preview', 'mapping', 'complete'];
          const isActive = step === steps[i];
          const isPast = steps.indexOf(step) > i;
          return (
            <React.Fragment key={label}>
              {i > 0 && <div className={`flex-1 h-px ${isPast ? 'bg-blue-500' : 'bg-gray-200'}`} />}
              <span className={`px-2 py-1 rounded ${isActive ? 'bg-blue-100 text-blue-700 font-medium' : isPast ? 'text-blue-600' : 'text-gray-400'}`}>
                {label}
              </span>
            </React.Fragment>
          );
        })}
      </div>

      {/* Step 1: Input */}
      {step === 'input' && (
        <Card className="space-y-4">
          <div className="flex items-center gap-4 mb-4">
            <label className="flex items-center gap-2 cursor-pointer px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
              <ArrowUpTrayIcon className="w-4 h-4" />
              <span className="text-sm">Upload .md file</span>
              <input type="file" accept=".md,.markdown,.txt" onChange={handleFileUpload} className="hidden" />
            </label>
            <span className="text-gray-400 text-sm">or paste below</span>
          </div>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder={'# Collection Title\n\n## Category Name\n\n### Item Title\n\n[https://example.com](https://example.com)\n\n#### Section Heading\n\nContent here...'}
            className="w-full h-96 font-mono text-sm border border-gray-300 rounded-lg p-4 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <div className="flex justify-end">
            <Button onClick={handleParse}>Parse Markdown</Button>
          </div>
        </Card>
      )}

      {/* Step 2: Preview */}
      {step === 'preview' && parsed && (
        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">{parsed.title || 'Untitled Collection'}</h2>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-gray-900">{parsed.categories.length}</div>
              <div className="text-sm text-gray-500">Categories</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-gray-900">{totalItems}</div>
              <div className="text-sm text-gray-500">Items</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-gray-900">{totalSections}</div>
              <div className="text-sm text-gray-500">Sections</div>
            </div>
          </div>

          <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
            {parsed.categories.map((cat, ci) => (
              <div key={ci} className="p-3">
                <div className="font-medium text-gray-900">{cat.name}</div>
                <div className="ml-4 mt-1 space-y-1">
                  {cat.items.map((item, ii) => (
                    <div key={ii} className="text-sm">
                      <span className="text-gray-700">{item.title}</span>
                      <span className="text-gray-400 ml-2">({item.sections.length} sections)</span>
                      {item.external_url && <span className="text-blue-500 ml-2 text-xs">{item.external_url}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t pt-4 space-y-3">
            <label className="flex items-center gap-2">
              <input type="radio" checked={createNew} onChange={() => setCreateNew(true)} />
              <span className="text-sm">Create new collection</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={!createNew} onChange={() => setCreateNew(false)} />
              <span className="text-sm">Import into existing collection</span>
            </label>
            {!createNew && (
              <Select
                value={selectedCollectionId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedCollectionId(e.target.value)}
                data={[{ value: '', label: 'Select a collection...' }, ...collections.map(c => ({ value: c.id, label: c.name }))]}
              />
            )}
          </div>

          <div className="flex justify-between pt-4">
            <Button variant="ghost" onClick={() => setStep('input')}>Back</Button>
            <Button onClick={proceedToMapping}>Continue</Button>
          </div>
        </Card>
      )}

      {/* Step 3: Mapping */}
      {step === 'mapping' && parsed && (
        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Section Template Mapping</h2>
          <p className="text-sm text-gray-500">
            {createNew
              ? 'Section templates will be created automatically from detected headings.'
              : 'Map detected section headings to existing templates, or create new ones.'}
          </p>

          {createNew ? (
            <div className="space-y-2">
              {Array.from(new Set(parsed.categories.flatMap(c => c.items.flatMap(i => i.sections.map(s => s.heading))))).map((heading, i) => (
                <div key={i} className="flex items-center gap-2 py-2 px-3 bg-gray-50 rounded">
                  <DocumentTextIcon className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-700">{heading}</span>
                  <span className="text-xs text-green-600 ml-auto">Will create template</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {Array.from(new Set(parsed.categories.flatMap(c => c.items.flatMap(i => i.sections.map(s => s.heading))))).map((heading, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <span className="text-sm text-gray-700 w-48 truncate">{heading}</span>
                  <span className="text-gray-400">→</span>
                  <Select
                    value={sectionMap.get(heading) || ''}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                      setSectionMap(prev => {
                        const next = new Map(prev);
                        if (e.target.value) next.set(heading, e.target.value);
                        else next.delete(heading);
                        return next;
                      });
                    }}
                    data={[{ value: '', label: 'Create new template' }, ...templates.map(t => ({ value: t.id, label: t.heading }))]}
                    className="flex-1"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-between pt-4">
            <Button variant="ghost" onClick={() => setStep('preview')}>Back</Button>
            <Button onClick={handleImport} disabled={importing}>Import</Button>
          </div>
        </Card>
      )}

      {/* Step 4: Complete */}
      {step === 'complete' && result && (
        <Card className="text-center py-12 space-y-4">
          <CheckIcon className="w-16 h-16 text-green-500 mx-auto" />
          <h2 className="text-xl font-semibold text-gray-900">Import Complete</h2>
          <div className="text-gray-500">
            Created {result.categories} categories, {result.items} items, and {result.sections} sections.
          </div>
          <div className="flex justify-center gap-3 pt-4">
            <Button variant="ghost" onClick={() => { setStep('input'); setMarkdown(''); setParsed(null); setResult(null); }}>
              Import Another
            </Button>
            <Button onClick={() => window.location.href = '/resources/collections'}>
              View Collections
            </Button>
          </div>
        </Card>
      )}
        </div>
      </WorkspaceLayout>
    </Page>
  );
};

export default ImportPage;
