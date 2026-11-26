// src/components/PagesPanel/PagesPanel.tsx
import { useState } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { usePages } from '@/context/PagesContext';
import { useEditorDoc } from '@/store/hooks';
import { selectIsPageRowVisible } from '@/store/selectors';
import { PageTreeNode } from './PageTreeNode';
import { DRAG_TYPES } from '@/types/drag';
import { Row, Button, SortableTreeProvider } from '@/components/ui';
import { PlusIcon } from '@/assets/icons';
import { AresWindow } from '@/components/AresWindow';

export function PagesPanel() {
  const [aresOpen, setAresOpen] = useState(false);
  const { pages, rootPageIds, createPage, movePage } = usePages();
  const doc = useEditorDoc();

  const rootPages = rootPageIds
    .map(id => pages.find(p => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && selectIsPageRowVisible(doc, p.id));

  const handleAddPage = () => {
    const name = `Page ${pages.length + 1}`;
    createPage(name);
  };

  return (
    <SortableTreeProvider
      items={pages}
      rootIds={rootPageIds}
      dragType={DRAG_TYPES.PAGES_PANEL}
      onMove={movePage}
    >
      <div className="flex flex-col h-full gap-y-px">
        {/* Action bar */}
        <Row
          title="Pages"
          size="sm"
          className="pl-3 pr-1"
          right={[
            {
              type: 'custom',
              unboxed: true,
              node: (
                <Button
                  variant="ghost"
                  size="sm"
                  label="Doména .cz"
                  aria-label="Point a .cz domain at Cloudflare"
                  title="Point a .cz domain at Cloudflare"
                  onClick={() => window.open('/domena-cz.html', '_blank', 'noopener,noreferrer')}
                />
              ),
            },
            {
              type: 'custom',
              unboxed: true,
              node: (
                <Button
                  variant="ghost"
                  size="sm"
                  label="IČO"
                  aria-label="Company from ARES"
                  onClick={() => setAresOpen(true)}
                  title="Company from ARES"
                />
              ),
            },
            {
              type: 'custom',
              unboxed: true,
              node: (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<PlusIcon className="w-4 h-4" />}
                  aria-label="Add page"
                  onClick={handleAddPage}
                  title="Add page"
                  data-testid="add-page-btn"
                />
              ),
            },
          ]}
        />

        {/* Page tree */}
        <div data-testid="pages-list" className="flex-1 overflow-y-auto scrollbar-thin px-1 pb-1 space-y-px">
          <SortableContext items={rootPageIds} strategy={verticalListSortingStrategy}>
            {rootPages.map((page, index) => (
              <PageTreeNode
                key={page.id}
                page={page}
                depth={0}
                index={index}
                siblingIds={rootPageIds}
                parentId={null}
              />
            ))}
          </SortableContext>

          {rootPages.length === 0 && (
            <div className="px-4 py-8 text-center text-text-secondary text-xs">
              No pages yet. Click + to create one.
            </div>
          )}
        </div>
      </div>
      <AresWindow isOpen={aresOpen} onClose={() => setAresOpen(false)} />
    </SortableTreeProvider>
  );
}
