/* @gatewaze:wrapper name="docs" role="page" */

import type { ReactNode } from 'react';

interface DocsWrapperProps {
  children: ReactNode;
}

/**
 * Docs page wrapper: nests inside the site wrapper for any page under /docs/.
 * Renders a sidebar with sub-nav populated from useSectionPages('/docs/').
 */
export function DocsWrapper({ children }: DocsWrapperProps) {
  // In the real runtime this calls useSectionPages('/docs/').
  const sectionPages = [
    { id: '1', full_path: '/docs/getting-started', title: 'Getting started', section_order: 0 },
    { id: '2', full_path: '/docs/concepts', title: 'Concepts', section_order: 1 },
    { id: '3', full_path: '/docs/api', title: 'API reference', section_order: 2 },
  ];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-8">
      <aside className="lg:border-r lg:border-[var(--color-border)] lg:pr-6">
        <nav className="sticky top-8 space-y-1">
          {sectionPages.map((p) => (
            <a
              key={p.id}
              href={p.full_path}
              className="block px-3 py-2 rounded-md text-sm hover:bg-gray-100"
            >
              {p.title}
            </a>
          ))}
        </nav>
      </aside>
      <article className="prose prose-neutral max-w-none">
        {children}
      </article>
    </div>
  );
}
