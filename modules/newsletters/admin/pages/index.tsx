import { useNavigate, useSearchParams } from 'react-router';
import { RectangleGroupIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { Page } from '@/components/shared/Page';
import { EditorTab } from './EditorTab';

export default function NewslettersPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'editions';

  return (
    <Page title="Newsletters">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Newsletters
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Manage newsletter templates and editions
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-1 border-b border-[var(--gray-6)] mb-6">
          <button
            onClick={() => setSearchParams({})}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'editions'
                ? 'border-[var(--accent-9)] text-[var(--accent-11)]'
                : 'border-transparent text-[var(--gray-11)] hover:text-[var(--gray-12)] hover:border-[var(--gray-8)]'
            }`}
          >
            <PencilSquareIcon className="w-4 h-4" />
            Editions
          </button>
          <button
            onClick={() => navigate('/newsletters/templates')}
            className="px-4 py-2.5 text-sm font-medium border-b-2 border-transparent text-[var(--gray-11)] hover:text-[var(--gray-12)] hover:border-[var(--gray-8)] transition-colors flex items-center gap-2"
          >
            <RectangleGroupIcon className="w-4 h-4" />
            Templates
          </button>
        </div>

        <EditorTab />
      </div>
    </Page>
  );
}
