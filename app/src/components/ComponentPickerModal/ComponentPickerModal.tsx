// src/components/ComponentPickerModal/ComponentPickerModal.tsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { t } from '@/i18n';
import { Modal, Tabs, SearchField, Button, EmptyState, OperationNotice } from '@/components/ui';
import { useComponentLibrary, type ScannedComponent } from '@/hooks/useComponentLibrary';
import { getPreviewImage, resolvePreviewImage } from './previewImages';
import { useThemesLibrary, type ThemeComponent } from '@/context/ThemesLibraryContext';
import { projectComponentsForTheme, uploadedThemeOf } from '@/utils/libraryThemes';
import { useLayoutLibrary, layoutToScannedComponent } from '@/hooks/useLayoutLibrary';
import { ThemePicker, useThemeUpload } from './ThemePicker';
import { buildPickerCategories, type PickerCategory } from './pickerCategories';
import { resolveFolderTree, mergeScannedComponents } from '@/store/folderManifest';
import { useFolderManifest } from '@/hooks/useFolderManifest';
import { PAGE_TEMPLATES, type PageTemplatePreset } from './pageTemplates';
import { loadLucideIcons } from '@/utils/iconLibrary';

// Extended type for theme components
export interface ThemeComponentTemplate {
  id: string;
  name: string;
  category: string;
  image: string;
  html: string;
  themeId: string;
  componentPath: string;
}

/** Picker type guard: distinguishes theme templates from scanned local components. */
export function isThemeComponentTemplate(
  c: ScannedComponent | ThemeComponentTemplate,
): c is ThemeComponentTemplate {
  return 'themeId' in c && !!c.themeId;
}

interface ComponentPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectComponent: (component: ScannedComponent | ThemeComponentTemplate) => void | Promise<void>;
  onSelectPageTemplate: (preset: PageTemplatePreset) => void | Promise<void>;
  /** Icons tab (task-106): called with the Lucide icon name + raw SVG string. */
  onSelectIcon?: (lucideName: string, svg: string) => void | Promise<void>;
  /** task-133: local (files-truth) runtime — only the Components tab exists.
   *  Pages presets and the icon materializer write into starquix's own repo
   *  (library/icons/…, task-147 file-leak), not the user's project. */
  localMode?: boolean;
}

// Category folder item component
function CategoryItem({
  name,
  isActive,
  onHover,
  onFocus,
  innerRef,
}: {
  name: string;
  isActive: boolean;
  onHover: () => void;
  onFocus?: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={innerRef}
      className={`cursor-pointer p-4 border-b border-stroke transition-colors ${
        isActive ? 'bg-bg-hover' : 'hover:bg-bg-hover'
      }`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onFocus?.();
        onHover();
      }}
    >
      <div className="text-text text-sm-medium">{t(name)}</div>
    </div>
  );
}

// Component card with preview
function ComponentCard({
  component,
  isSelected,
  onSelect,
  onHover,
  innerRef,
}: {
  component: ScannedComponent;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const showAddButton = isHovered || isSelected;
  // Built-in PNGs are name-keyed and Starquix-owned — resolvePreviewImage keeps
  // a user-project component from borrowing one (see previewImages.ts).
  const previewImage = resolvePreviewImage(component);

  return (
    <div
      ref={innerRef}
      data-testid="template-item"
      className={`relative p-3 bg-bg-contrast rounded-lg transition-all cursor-pointer ${
        isSelected ? 'ring-2 ring-btn-primary-fill-default' : 'hover:bg-bg-hover'
      }`}
      onMouseEnter={() => {
        setIsHovered(true);
        onHover();
      }}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onSelect}
    >
      {/* Preview image */}
      <div className="aspect-[16/9] bg-bg-hover rounded border border-stroke mb-2 overflow-hidden">
        {previewImage ? (
          <img
            src={previewImage}
            alt={t(component.name)}
            className="w-full h-full object-cover object-top"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-secondary text-xs">
            {t(component.name)}
          </div>
        )}
      </div>

      {/* Component name */}
      <div className="text-xs text-text-secondary truncate">{t(component.name)}</div>

      {/* Add button overlay */}
      {showAddButton && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
          <Button
            variant="primary"
            label="Add"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
          />
        </div>
      )}
    </div>
  );
}

// Theme component card (shows HTML preview instead of image)
/** What the preview box's old `p-2 text-xs` gave the inline HTML, for the frame's document. */
const THEME_PREVIEW_BASE = '<style>body{margin:0;padding:8px;font:12px/1.4 system-ui,sans-serif}img,video,svg{max-width:100%;height:auto}</style>';

export function ThemeComponentCard({
  component,
  isSelected,
  onSelect,
  onHover,
  innerRef,
}: {
  component: ThemeComponent;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const showAddButton = isHovered || isSelected;

  return (
    <div
      ref={innerRef}
      data-testid="component-item"
      className={`relative p-3 bg-bg-contrast rounded-lg transition-all cursor-pointer ${
        isSelected ? 'ring-2 ring-btn-primary-fill-default' : 'hover:bg-bg-hover'
      }`}
      onMouseEnter={() => {
        setIsHovered(true);
        onHover();
      }}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onSelect}
    >
      {/* HTML Preview — theme-ZIP HTML is third-party: it renders in a
          script-less sandboxed frame, never in the editor document (which holds
          window.sqDesktop, every project and the stored tokens). */}
      <div className="aspect-[16/9] bg-white rounded border border-stroke mb-2 overflow-hidden">
        <iframe
          title={t(component.name)}
          sandbox=""
          srcDoc={THEME_PREVIEW_BASE + component.html}
          loading="lazy"
          tabIndex={-1}
          className="w-full h-full border-0 pointer-events-none"
        />
      </div>

      {/* Component name */}
      <div className="text-xs text-text-secondary truncate">{t(component.name)}</div>
      <div className="text-xs text-text-secondary truncate">{component.path}</div>

      {/* Add button overlay */}
      {showAddButton && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
          <Button
            variant="primary"
            label="Add"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
          />
        </div>
      )}
    </div>
  );
}

// Stacked mini-previews of the preset's components — reuses the generated
// component PNGs; no dedicated page screenshots needed (design deviation, OK'd).
function PageTemplateCard({ preset, isSelected, onSelect, onHover, innerRef }: {
  preset: PageTemplatePreset;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  const previews = preset.components
    .map((name) => getPreviewImage(name))
    .filter((u): u is string => !!u)
    .slice(0, 4);
  return (
    <div
      ref={innerRef}
      data-testid="page-template-item"
      className={`relative p-3 bg-bg-contrast rounded-lg transition-all cursor-pointer ${
        isSelected ? 'ring-2 ring-btn-primary-fill-default' : 'hover:bg-bg-hover'
      }`}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <div className="aspect-[3/4] bg-bg-hover rounded border border-stroke mb-2 overflow-hidden flex flex-col">
        {previews.length > 0 ? (
          previews.map((src, i) => (
            <img key={i} src={src} alt="" className="w-full flex-1 min-h-0 object-cover object-top" />
          ))
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-secondary text-xs">{t(preset.name)}</div>
        )}
      </div>
      <div className="text-xs text-text-secondary truncate">{t(preset.name)}</div>
      <div className="text-xs text-text-secondary truncate">{preset.components.length} sections</div>
    </div>
  );
}

export function ComponentPickerModal({
  isOpen,
  onClose,
  onSelectComponent,
  onSelectPageTemplate,
  onSelectIcon,
  localMode = false,
}: ComponentPickerModalProps) {
  const themeUpload = useThemeUpload();
  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredCategoryIndex, setHoveredCategoryIndex] = useState(0);
  const [selectedComponentIndex, setSelectedComponentIndex] = useState(0);
  const [isInRightColumn, setIsInRightColumn] = useState(false);
  const [activeTab, setActiveTab] = useState<'components' | 'pages' | 'icons'>('components');
  // Icons tab (task-106): Lucide SVGs lazy-loaded on first open
  const [lucideIcons, setLucideIcons] = useState<Record<string, string> | null>(null);
  const [iconsLoading, setIconsLoading] = useState(false);
  const [themeCache, setThemeCache] = useState<Record<string, ThemeComponent[]>>({});
  const [loadingThemeComponents, setLoadingThemeComponents] = useState(false);
  const [selectionIssue, setSelectionIssue] = useState<string | null>(null);
  const selectionPending = useRef(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const categoryItemsRef = useRef<(HTMLDivElement | null)[]>([]);
  const componentItemsRef = useRef<(HTMLDivElement | null)[]>([]);

  // Get dynamic component library from scanner
  const { builtIn, userProject, isLoading: libraryLoading } = useComponentLibrary();
  const { layouts } = useLayoutLibrary();

  // Lazy-load Lucide icons the first time the Icons tab opens
  useEffect(() => {
    if (activeTab !== 'icons' || lucideIcons || iconsLoading) return;
    setIconsLoading(true);
    loadLucideIcons()
      .then(setLucideIcons)
      .finally(() => setIconsLoading(false));
  }, [activeTab, lucideIcons, iconsLoading]);

  const ICONS_RENDER_CAP = 120; // ~1990 inline SVGs would jank the modal; search narrows
  const { icons: filteredIcons, iconsTruncated } = useMemo(() => {
    if (!lucideIcons) return { icons: [], iconsTruncated: false };
    // Lucide exports are PascalCase; users type "arrow-right" / "arrow right" — strip separators on both sides
    const q = searchQuery.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const entries = Object.entries(lucideIcons);
    const matched = q ? entries.filter(([name]) => name.toLowerCase().includes(q)) : entries;
    return { icons: matched.slice(0, ICONS_RENDER_CAP), iconsTruncated: matched.length > ICONS_RENDER_CAP };
  }, [lucideIcons, searchQuery]);

  const layoutsAsComponents = useMemo<ScannedComponent[]>(
    () => layouts.map(layoutToScannedComponent),
    [layouts],
  );

  // Get enabled themes from context
  // The project's theme; an active upload is listed as one theme category (lazy-loaded below).
  const { themes, activeTheme, getThemeComponents } = useThemesLibrary();
  const activeUpload = uploadedThemeOf(activeTheme);

  // ONE category model, shared with the Assets panel: the same resolved folder
  // tree, flattened. Nested folders read as "Marketing pages / Heroes".
  const { manifest } = useFolderManifest();
  const folderTree = useMemo(
    () => resolveFolderTree(mergeScannedComponents(builtIn, projectComponentsForTheme(userProject, builtIn, activeTheme), layoutsAsComponents), manifest),
    [builtIn, userProject, activeTheme, layoutsAsComponents, manifest],
  );
  const categories = useMemo(
    () => buildPickerCategories({
      tree: folderTree,
      themes: themes.filter((t) => t._id === activeUpload),
    }),
    [folderTree, themes, activeUpload],
  );

  // Filter categories based on search. Theme categories: only loaded ones are
  // searchable (ponytail: no eager fetch of every theme just to search).
  const filteredCategories = useMemo(() => {
    if (!searchQuery) return categories;
    const q = searchQuery.toLowerCase();
    return categories.flatMap((cat): PickerCategory[] => {
      if (cat.kind === 'library') {
        const components = cat.components.filter(
          (c) => c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
        );
        return components.length > 0 ? [{ ...cat, components }] : [];
      }
      const loaded = themeCache[cat.themeId];
      if (!loaded) return []; // ponytail: unloaded themes hidden during search; visit the category once to index it
      return loaded.some((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q)) ? [cat] : [];
    });
  }, [searchQuery, categories, themeCache]);

  const currentCategory = filteredCategories[hoveredCategoryIndex] ?? null;

  // Lazy-load theme components into a per-theme cache when a theme category
  // is highlighted.
  useEffect(() => {
    if (currentCategory?.kind !== 'theme') return;
    const { themeId } = currentCategory;
    if (themeCache[themeId]) return;
    let cancelled = false;
    setLoadingThemeComponents(true);
    getThemeComponents(themeId)
      .then((comps) => { if (!cancelled) setThemeCache((p) => ({ ...p, [themeId]: comps })); })
      .catch((err) => { console.error('Failed to load theme components:', err); if (!cancelled) setThemeCache((p) => ({ ...p, [themeId]: [] })); })
      .finally(() => { if (!cancelled) setLoadingThemeComponents(false); });
    return () => { cancelled = true; };
  }, [currentCategory, themeCache, getThemeComponents]);

  // Right-column contents for rendering + keyboard nav; theme contents are
  // search-filtered here (their category filter above only decides visibility).
  const currentComponents = useMemo<Array<ScannedComponent | ThemeComponent>>(() => {
    if (!currentCategory) return [];
    if (currentCategory.kind === 'library') return currentCategory.components;
    const loaded = themeCache[currentCategory.themeId] ?? [];
    if (!searchQuery) return loaded;
    const q = searchQuery.toLowerCase();
    return loaded.filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q));
  }, [currentCategory, themeCache, searchQuery]);

  // Pages tab: curated presets, filtered by name.
  const filteredPresets = useMemo(() => {
    if (!searchQuery) return PAGE_TEMPLATES;
    const q = searchQuery.toLowerCase();
    return PAGE_TEMPLATES.filter((p) => p.name.toLowerCase().includes(q));
  }, [searchQuery]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
      setSearchQuery('');
      setHoveredCategoryIndex(0);
      setSelectedComponentIndex(0);
      setIsInRightColumn(false);
      setActiveTab('components');
      categoryItemsRef.current = [];
      componentItemsRef.current = [];
    }
  }, [isOpen]);

  // Reset selections when filtered categories change
  useEffect(() => {
    setHoveredCategoryIndex(0);
    setSelectedComponentIndex(0);
    setIsInRightColumn(false);
  }, [searchQuery]);

  // Reset selection when switching tabs; refocus search so arrows/typing
  // keep working after a tab click (focus would otherwise sit on the tab button).
  useEffect(() => {
    setSelectedComponentIndex(0);
    setIsInRightColumn(false);
    componentItemsRef.current = [];
    searchInputRef.current?.focus();
  }, [activeTab]);

  // Scroll selected category into view
  useEffect(() => {
    if (activeTab === 'components' && !isInRightColumn && hoveredCategoryIndex >= 0) {
      const element = categoryItemsRef.current[hoveredCategoryIndex];
      if (element) {
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [hoveredCategoryIndex, isInRightColumn, activeTab]);

  // Scroll selected component / preset card into view
  useEffect(() => {
    if ((isInRightColumn || activeTab === 'pages') && selectedComponentIndex >= 0) {
      const element = componentItemsRef.current[selectedComponentIndex];
      if (element) {
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedComponentIndex, isInRightColumn, activeTab]);

  const handleCategoryHover = useCallback((index: number) => {
    setHoveredCategoryIndex(index);
    setSelectedComponentIndex(0);
    componentItemsRef.current = [];
  }, []);

  const completeSelection = useCallback(async (select: () => void | Promise<void>, label: string) => {
    if (selectionPending.current) return;
    selectionPending.current = true;
    setSelectionIssue(null);
    try {
      const pending = select();
      if (pending) await pending;
      onClose();
    } catch (error) {
      setSelectionIssue(`Could not add ${label} — ${error instanceof Error ? error.message : 'storage failed'}. Please retry.`);
    } finally { selectionPending.current = false; }
  }, [onClose]);

  const handleComponentSelect = useCallback((component: ScannedComponent) => {
    void completeSelection(() => onSelectComponent(component), component.name);
  }, [onSelectComponent, completeSelection]);

  const handleThemeComponentSelect = useCallback((component: ThemeComponent, themeId: string) => {
    // Convert theme component to ThemeComponentTemplate format
    const themeTemplate: ThemeComponentTemplate = {
      id: `theme-${themeId}-${component.id}`,
      name: component.name,
      category: 'Theme',
      image: '', // Theme components don't have images
      html: component.html,
      themeId,
      componentPath: component.path,
    };
    void completeSelection(() => onSelectComponent(themeTemplate), component.name);
  }, [onSelectComponent, completeSelection]);

  const handlePresetSelect = useCallback((preset: PageTemplatePreset) => {
    void completeSelection(() => onSelectPageTemplate(preset), preset.name);
  }, [onSelectPageTemplate, completeSelection]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't handle if typing in search (except for navigation keys)
    if (document.activeElement === searchInputRef.current) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        searchInputRef.current?.blur();
        containerRef.current?.focus();
        setIsInRightColumn(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        searchInputRef.current?.blur();
        containerRef.current?.focus();
      }
      return;
    }

    const isNavKey = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key);
    if (isNavKey) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Pages tab: 2-column preset grid (←→ = ±1, ↑↓ = ±2, Enter applies)
    if (activeTab === 'pages') {
      const max = filteredPresets.length - 1;
      if (e.key === 'ArrowRight') setSelectedComponentIndex((i) => Math.min(i + 1, max));
      if (e.key === 'ArrowLeft') setSelectedComponentIndex((i) => Math.max(i - 1, 0));
      if (e.key === 'ArrowDown') setSelectedComponentIndex((i) => Math.min(i + 2, max));
      if (e.key === 'ArrowUp') setSelectedComponentIndex((i) => Math.max(i - 2, 0));
      if ((e.key === 'Enter' || e.key === ' ') && filteredPresets[selectedComponentIndex]) {
        handlePresetSelect(filteredPresets[selectedComponentIndex]);
      }
      return;
    }

    // Left/Right switches between columns
    if (e.key === 'ArrowLeft' && isInRightColumn) {
      setIsInRightColumn(false);
      return;
    }

    if (e.key === 'ArrowRight' && !isInRightColumn && currentComponents.length > 0) {
      setIsInRightColumn(true);
      setSelectedComponentIndex(0);
      return;
    }

    // Up/Down navigates within current column
    if (e.key === 'ArrowUp') {
      if (!isInRightColumn) {
        if (hoveredCategoryIndex > 0) {
          setHoveredCategoryIndex(hoveredCategoryIndex - 1);
          setSelectedComponentIndex(0);
        }
      } else {
        if (selectedComponentIndex > 0) {
          setSelectedComponentIndex(selectedComponentIndex - 1);
        } else {
          setIsInRightColumn(false);
        }
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      if (!isInRightColumn) {
        if (hoveredCategoryIndex < filteredCategories.length - 1) {
          setHoveredCategoryIndex(hoveredCategoryIndex + 1);
          setSelectedComponentIndex(0);
        }
      } else {
        if (selectedComponentIndex < currentComponents.length - 1) {
          setSelectedComponentIndex(selectedComponentIndex + 1);
        }
      }
      return;
    }

    // Enter/Space selects component
    if ((e.key === 'Enter' || e.key === ' ') && isInRightColumn && currentCategory) {
      const component = currentComponents[selectedComponentIndex];
      if (component) {
        if (currentCategory.kind === 'library') {
          handleComponentSelect(component as ScannedComponent);
        } else {
          handleThemeComponentSelect(component as ThemeComponent, currentCategory.themeId);
        }
      }
      return;
    }
  }, [
    activeTab,
    filteredPresets,
    handlePresetSelect,
    isInRightColumn,
    hoveredCategoryIndex,
    selectedComponentIndex,
    filteredCategories.length,
    currentCategory,
    currentComponents,
    handleComponentSelect,
    handleThemeComponentSelect,
  ]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} aria-label="Add component" size="picker">
      {selectionIssue && <div role="alert" className="px-4 py-2 text-sm text-text">{selectionIssue}</div>}
      {/* Tabs header; the project's section theme on the right (Components only) */}
      <div className="px-4 border-b border-stroke flex items-center gap-2">
        <Tabs
          size="sm"
          options={
            localMode
              // Pages (doc page templates) stay doc-only; Icons materialize
              // into the project (utils/iconLibrary.ts, Phase 6).
              ? [
                  { value: 'components', label: 'Components' },
                  { value: 'icons', label: 'Icons' },
                ]
              : [
                  { value: 'components', label: 'Components' },
                  { value: 'pages', label: 'Pages' },
                  { value: 'icons', label: 'Icons' },
                ]
          }
          value={activeTab}
          onChange={(v) => setActiveTab(v as 'components' | 'pages' | 'icons')}
        />
        {activeTab === 'components' && (
          <div className="ml-auto">
            <ThemePicker onUpload={themeUpload.choose} uploading={themeUpload.busy} />
          </div>
        )}
        {themeUpload.input}
      </div>
      {themeUpload.issue && (
        <div className="px-2 pt-2">
          <OperationNotice title={themeUpload.issue.title} detail={themeUpload.issue.detail}
            action={{ label: 'Try again', onClick: themeUpload.choose }} />
        </div>
      )}

      {/* Search header */}
      <div className="p-4 border-b border-stroke">
        <SearchField
          ref={searchInputRef}
          placeholder={activeTab === 'pages' ? 'Search page templates...' : activeTab === 'icons' ? 'Search icons...' : 'Search components...'}
          value={searchQuery}
          onChange={setSearchQuery}
          onKeyDown={handleKeyDown}
          className="w-full"
        />
      </div>

      {/* Content area */}
      {activeTab === 'icons' ? (
        /* Icons tab (task-106): Lucide grid, materialized as components on pick */
        <div className="flex-1 overflow-y-auto p-3" data-testid="icons-grid">
          {iconsLoading || !lucideIcons ? (
            <div className="flex h-full items-center justify-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-btn-primary-fill-default" />
            </div>
          ) : filteredIcons.length === 0 ? (
            <EmptyState title="No icons match your search." />
          ) : (
            <>
              <div className="grid grid-cols-8 gap-1">
                {filteredIcons.map(([name, svg]) => (
                  <Button
                    key={name}
                    variant="ghost"
                    title={name}
                    aria-label={name}
                    data-testid={`icon-${name}`}
                    onClick={() => { void completeSelection(() => onSelectIcon?.(name, svg), name); }}
                    className="h-14 px-0 rounded-outer font-normal text-text hover:bg-bg-hover [&_svg]:w-6 [&_svg]:h-6"
                    // Trusted static package content (lucide-static)
                    icon={<span className="flex" dangerouslySetInnerHTML={{ __html: svg }} />}
                  />
                ))}
              </div>
              {iconsTruncated && (
                <div className="pt-2 text-xs text-text-secondary text-center">
                  Showing first {filteredIcons.length} — refine your search
                </div>
              )}
            </>
          )}
        </div>
      ) : activeTab === 'pages' ? (
        /* Pages tab: curated full-page presets */
        <div
          ref={containerRef}
          tabIndex={-1}
          className="flex-1 overflow-y-auto p-3 outline-none"
          onKeyDown={handleKeyDown}
        >
          {filteredPresets.length === 0 ? (
            <EmptyState title="No page templates match your search." />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredPresets.map((preset, index) => (
                <PageTemplateCard
                  key={preset.id}
                  preset={preset}
                  isSelected={selectedComponentIndex === index}
                  onSelect={() => handlePresetSelect(preset)}
                  onHover={() => setSelectedComponentIndex(index)}
                  innerRef={(el) => { componentItemsRef.current[index] = el; }}
                />
              ))}
            </div>
          )}
        </div>
      ) : libraryLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-btn-primary-fill-default" />
        </div>
      ) : (
        /* Components tab: two-column layout */
        <div
          ref={containerRef}
          tabIndex={-1}
          className="flex flex-1 overflow-hidden outline-none"
          onKeyDown={handleKeyDown}
        >
          {/* Left column: Categories */}
          <div className="w-1/2 overflow-y-auto border-r border-stroke">
            {filteredCategories.length === 0 ? (
              <EmptyState title="No categories match your search." />
            ) : (
              filteredCategories.map((category, index) => (
                <CategoryItem
                  // Name alone is NOT unique (two same-named folders are legal; a
                  // duplicated 'Layouts' spammed React dup-key errors 2026-08-26).
                  key={category.kind === 'theme' ? `theme-${category.themeId}` : `${index}-${category.name}`}
                  name={category.name}
                  isActive={hoveredCategoryIndex === index}
                  onHover={() => handleCategoryHover(index)}
                  onFocus={() => {
                    containerRef.current?.focus();
                    setIsInRightColumn(false);
                  }}
                  innerRef={(el) => {
                    categoryItemsRef.current[index] = el;
                  }}
                />
              ))
            )}
          </div>

          {/* Right column: Components */}
          <div className="w-1/2 overflow-y-auto p-3">
            {currentCategory ? (
              currentCategory.kind === 'theme' && loadingThemeComponents ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-btn-primary-fill-default" />
                </div>
              ) : currentComponents.length > 0 ? (
                <div className="grid grid-cols-1 gap-3">
                  {currentCategory.kind === 'library'
                    ? (currentComponents as ScannedComponent[]).map((component, index) => (
                        <ComponentCard
                          key={component.path}
                          component={component}
                          isSelected={isInRightColumn && selectedComponentIndex === index}
                          onSelect={() => handleComponentSelect(component)}
                          onHover={() => {
                            setIsInRightColumn(true);
                            setSelectedComponentIndex(index);
                          }}
                          innerRef={(el) => {
                            componentItemsRef.current[index] = el;
                          }}
                        />
                      ))
                    : (currentComponents as ThemeComponent[]).map((component, index) => (
                        <ThemeComponentCard
                          key={component.id}
                          component={component}
                          isSelected={isInRightColumn && selectedComponentIndex === index}
                          onSelect={() => handleThemeComponentSelect(component, currentCategory.themeId)}
                          onHover={() => {
                            setIsInRightColumn(true);
                            setSelectedComponentIndex(index);
                          }}
                          innerRef={(el) => {
                            componentItemsRef.current[index] = el;
                          }}
                        />
                      ))}
                </div>
              ) : (
                <EmptyState title="No components in this category." />
              )
            ) : (
              <EmptyState title="Select a category to view components." />
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="p-3 border-t border-stroke text-center">
        <span className="text-xs text-text-secondary">
          <kbd className="px-1.5 py-0.5 bg-bg-contrast rounded text-text-secondary">←</kbd>
          <kbd className="px-1.5 py-0.5 bg-bg-contrast rounded text-text-secondary ml-1">→</kbd>
          {' '}{t('navigate')}{' '}&bull;{' '}
          <kbd className="px-1.5 py-0.5 bg-bg-contrast rounded text-text-secondary">Enter</kbd> {t('add')}
          {' '}&bull;{' '}
          <kbd className="px-1.5 py-0.5 bg-bg-contrast rounded text-text-secondary">Esc</kbd> {t('close')}
        </span>
      </div>
    </Modal>
  );
}
