/**
 * Link Block
 *
 * The selected element's link. None: a "Link" header with +, which makes one at
 * once. One: − removes it (⌘Z brings it back), the URL or page, an arrow that
 * follows it, and the "Open in a new tab" toggle.
 *
 * A link lives in its file (localLinkEdit). A text session adds and removes
 * through the bridge, which holds the live selection. A link this surface can't
 * write (a shared component's, a bound card's) reads and follows only.
 */

import { useState, useCallback, useMemo, useRef, useEffect, type FC } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Button, Field, Row } from '@/components/ui';
import { Popover, MenuItem } from '@/components/ui';
import { PlusIcon, MinusIcon, ArrowUpRightIcon, ChevronDownIcon } from '@/assets/icons';
import { addElementLink, removeElementLink, setElementLinkAttribute } from '@/components/Editor/localLinkEdit';
import { useScannedElements, useTextSelection } from '@/context/SelectionContext';
import { useUndoContext } from '@/context/UndoContext';
import { usePages } from '@/context/PagesContext';
import type { PageData } from '@/store/types';
import { pageRoute } from '@/store/pageRoute';
import { findPageByHref } from '@/store/findPageByHref';
import { DEFAULT_LINK_HREF, noteInlineLinkAdded } from '@/utils/linkSource';
import { isLocalCrossFileWrite } from '@/utils/localWriteScope';
import { sanitizeUrl } from '@/utils/sanitizeUrl';

// ============================================================================
// Types
// ============================================================================

interface LinkBlockProps {
  /** The selected element */
  elementKey?: string | null;
  /** A text session is live: its selection, not the element, is what gets linked */
  isEditingText?: boolean;
  /** Link the session's selected text */
  onLinkChange: (href: string) => void;
  /** Remove the link at the session's cursor */
  onUnlink: () => void;
  /** Callback when user starts/stops interacting with link controls (prevents parent unmount) */
  onInteractingChange?: (interacting: boolean) => void;
}

interface PageOption {
  value: string;
  label: string;
  path: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sync link attribute change to iframe via window message.
 * ViewportFrame listens for this and forwards to the iframe.
 */
function syncLinkAttrToIframe(key: string, attribute: string, value: string) {
  window.postMessage({
    type: 'SYNC_LINK_ATTR_TO_IFRAME',
    payload: { key, attribute, value }
  }, '*');
}

/**
 * Notify iframe that user is interacting with link controls.
 * This prevents the windowBlurHandler from exiting edit mode.
 */
function notifyLinkInteracting(interacting: boolean) {
  window.postMessage({
    type: 'SET_LINK_INTERACTING',
    payload: { interacting }
  }, '*');
}

// ============================================================================
// Component
// ============================================================================

/** The field belongs to the selected element: a new element remounts the block,
 *  so its FIRST commit already shows that element's link. The sync effect alone
 *  left one commit with the previous element's value, and typing in it was
 *  clobbered ("//nested/about/" — e2e L1, 2026-11-09). */
export const LinkBlock: FC<LinkBlockProps> = (props) => <ElementLinkBlock key={props.elementKey ?? ''} {...props} />;

const ElementLinkBlock: FC<LinkBlockProps> = ({
  elementKey,
  isEditingText = false,
  onLinkChange,
  onUnlink,
  onInteractingChange,
}) => {
  const { isInsideLink, existingHref, existingTarget, linkKey: textLinkKey } = useTextSelection();
  const { scannedByKey } = useScannedElements();
  const { pushStructuralUndo } = useUndoContext();
  const { pages, setActivePage } = usePages();

  const element = elementKey ? scannedByKey.get(elementKey) : undefined;
  const linkKey = isEditingText ? textLinkKey : element?.linkKey;
  const link = linkKey ? scannedByKey.get(linkKey) : undefined;
  const linkLocation = link?.sourceLocation;
  const currentHref = isEditingText ? (isInsideLink ? existingHref ?? '' : null) : element?.linkHref ?? null;
  const currentTarget = isEditingText ? existingTarget : element?.linkTarget;
  const currentAriaLabel = link?.linkAriaLabel ?? '';
  const hasLink = currentHref !== null;
  const readOnly = hasLink && !isEditingText && (!linkLocation || isLocalCrossFileWrite(linkLocation.file));

  // Local state
  const [href, setHref] = useState(currentHref ?? '');
  const [openInNewTab, setOpenInNewTab] = useState(currentTarget === '_blank');
  const [showDropdown, setShowDropdown] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [ariaLabel, setAriaLabel] = useState(currentAriaLabel);

  const inputRef = useRef<HTMLInputElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Track blur timeout for cleanup
  const committedHrefRef = useRef(currentHref); // What the file holds or is about to: Enter, then blur, is one write

  // Helper to update all interaction state in one call (parent, and notify iframe)
  const updateInteracting = useCallback((value: boolean) => {
    onInteractingChange?.(value);
    notifyLinkInteracting(value);
  }, [onInteractingChange]);

  // Sync with the link the scan reports
  useEffect(() => {
    setHref(currentHref ?? '');
    committedHrefRef.current = currentHref;
  }, [currentHref]);

  useEffect(() => {
    setOpenInNewTab(currentTarget === '_blank');
  }, [currentTarget]);

  useEffect(() => {
    setAriaLabel(currentAriaLabel);
  }, [currentAriaLabel]);

  // Cleanup: reset interacting state and clear pending timeout when component unmounts
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
      onInteractingChange?.(false);
      // Also notify iframe so bridge.js resets linkInteracting flag
      // Without this, bridge.js stays in linkInteracting=true and blocks TEXT_SELECTION_CHANGED
      notifyLinkInteracting(false);
    };
  }, [onInteractingChange]);

  // Build page options
  const pageOptions = useMemo((): PageOption[] => {
    return pages.map((page: PageData) => ({
      value: page.id,
      label: page.name,
      path: pageRoute(page)
    }));
  }, [pages]);

  // findPageByHref is THE matcher — preview-mode link nav resolves through the
  // same function (task-116), so the arrow and a preview click can't drift.
  const matchingPage = useMemo(() => findPageByHref(pages, href), [pages, href]);

  // Filtered options based on input
  const filteredOptions = useMemo(() => {
    if (!filterText) return pageOptions;
    const lower = filterText.toLowerCase();
    return pageOptions.filter(opt =>
      opt.label.toLowerCase().includes(lower) ||
      opt.path.toLowerCase().includes(lower)
    );
  }, [pageOptions, filterText]);

  const handleAdd = useCallback(() => {
    if (isEditingText) {
      if (elementKey) noteInlineLinkAdded(elementKey);
      onLinkChange(DEFAULT_LINK_HREF);
    } else if (element?.sourceLocation) {
      void addElementLink({ ...element, sourceLocation: element.sourceLocation }, pushStructuralUndo);
    }
  }, [isEditingText, elementKey, onLinkChange, element, pushStructuralUndo]);

  const handleRemove = useCallback(() => {
    if (isEditingText) onUnlink();
    else if (linkLocation) void removeElementLink(linkLocation, element, pushStructuralUndo);
  }, [isEditingText, onUnlink, linkLocation, element, pushStructuralUndo]);

  // false = nothing changed: the caller puts its value back. A live session keeps
  // its own DOM until it ends and writes that markup, so it gets the value too.
  const writeAttribute = useCallback(async (attribute: string, value: string): Promise<boolean> => {
    const written = linkLocation
      ? await setElementLinkAttribute(linkLocation, attribute, value, isEditingText ? undefined : element, pushStructuralUndo)
      : isEditingText;
    if (written && isEditingText && linkKey) syncLinkAttrToIframe(linkKey, attribute, value);
    return written;
  }, [isEditingText, linkKey, linkLocation, element, pushStructuralUndo]);

  // false = the link stays what it was (an emptied field, a refused write)
  const commitHref = useCallback(async (value: string): Promise<boolean> => {
    const next = sanitizeUrl(value);
    if (next === null) toast.error(t("That link is not allowed"));
    if (!next) {
      setHref(committedHrefRef.current ?? '');
      return false;
    }
    if (next === committedHrefRef.current) return true;
    committedHrefRef.current = next;
    if (await writeAttribute('href', next)) return true;
    committedHrefRef.current = currentHref;
    setHref(currentHref ?? '');
    return false;
  }, [writeAttribute, currentHref]);

  // Handle input change
  const handleInputChange = useCallback((value: string) => {
    setHref(value);
    setFilterText(value);
    setShowDropdown(true);
  }, []);

  // Handle page selection
  const handleSelectPage = useCallback((option: PageOption) => {
    setHref(option.path);
    setFilterText('');
    setShowDropdown(false);
    updateInteracting(false);
    void commitHref(option.path);
  }, [updateInteracting, commitHref]);

  // Handle input focus - mark as interacting to prevent unmount
  const handleFocus = useCallback(() => {
    updateInteracting(true);
    setShowDropdown(true);
  }, [updateInteracting]);

  // Handle input blur - write now, close dropdown after a delay to allow click events to fire first
  const handleBlur = useCallback(() => {
    void commitHref(href);
    // Clear any existing timeout to prevent duplicates
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    // Use setTimeout to allow click events to fire first. A real blur left the
    // field: the list's own clicks prevent it, and a click on the canvas never
    // reaches the Popover's outside-click.
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      setFilterText('');
      setShowDropdown(false);
      updateInteracting(false);
    }, 100);
  }, [updateInteracting, commitHref, href]);

  const handleNewTabToggle = useCallback((on: boolean) => {
    setOpenInNewTab(on);
    void writeAttribute('target', on ? '_blank' : '').then((written) => {
      if (!written) setOpenInNewTab(!on);
    });
  }, [writeAttribute]);

  // Handle Enter / Escape
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setFilterText('');
      setShowDropdown(false);
      updateInteracting(false);
      void commitHref(href);
      inputRef.current?.blur(); // ⌘Z now undoes the edit, not the typing
    }
    if (e.key === 'Escape') {
      setHref(committedHrefRef.current ?? '');
      setFilterText('');
      setShowDropdown(false);
      updateInteracting(false);
    }
  }, [href, commitHref, updateInteracting]);

  const handleAriaLabelBlur = useCallback(() => {
    if (ariaLabel === currentAriaLabel) return;
    void writeAttribute('aria-label', ariaLabel).then((written) => {
      if (!written) setAriaLabel(currentAriaLabel);
    });
  }, [ariaLabel, currentAriaLabel, writeAttribute]);

  // A page of the site opens in the editor, a web address in the browser.
  const isWebAddress = /^https?:\/\//i.test(href);
  const handleFollow = useCallback(async () => {
    // Written first: the arrow keeps the focus, so no blur wrote what was typed,
    // and a page switch moves the surface out from under the write.
    if (!readOnly && !(await commitHref(href))) return;
    if (matchingPage) setActivePage(matchingPage.id);
    else window.open(href, '_blank', 'noopener,noreferrer'); // desktop main hands it to the system browser
  }, [readOnly, commitHref, matchingPage, setActivePage, href]);

  // Outside-click / Escape close is handled by Popover (onClose below).

  // Prevent focus stealing from iframe
  const preventFocusSteal = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const follow = (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      data-testid="link-follow"
      onClick={handleFollow}
      disabled={!matchingPage && !isWebAddress}
      aria-label="Follow link"
      title={matchingPage ? `Go to ${matchingPage.name}` : 'Follow link'}
      icon={<ArrowUpRightIcon className="w-4 h-4" />}
    />
  );

  return (
    <div data-testid="link-block" onMouseDown={preventFocusSteal}>
      <Row
        title="Link"
        hover={false}
        className="pl-1 pr-0"
        onClick={hasLink ? undefined : handleAdd}
        right={readOnly ? undefined : [{
          type: 'custom',
          unboxed: true,
          node: (
            <Button
              variant="ghost"
              size="md"
              iconOnly
              aria-label={hasLink ? 'Remove link' : 'Add link'}
              title={hasLink ? 'Remove link' : 'Add link'}
              data-testid={hasLink ? 'unlink-btn' : 'add-link-btn'}
              icon={hasLink ? <MinusIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
              onClick={(e) => {
                e.stopPropagation();
                if (hasLink) handleRemove();
                else handleAdd();
              }}
            />
          ),
        }]}
      />

      {readOnly && (
        <div className="flex items-center gap-1 pb-2 pr-1">
          <Field
            readOnly
            className="flex-1"
            value={href}
            onChange={() => {}}
            placeholder="URL or page"
            aria-label="Link URL or page"
            title="Set by a component or a card: open it to change"
          />
          {follow}
        </div>
      )}

      {hasLink && !readOnly && (
        <div className="pb-2 space-y-1">
          {/* URL/Page Combobox with the arrow that follows it */}
          <div className="flex items-center gap-1 pr-1" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}>
            <div className="relative flex-1">
              <div
                ref={inputContainerRef}
                className="cursor-pointer"
                onMouseDown={() => {
                  // Set interacting on mousedown (before blur fires)
                  updateInteracting(true);
                }}
                onClick={() => {
                  setShowDropdown(true);
                  inputRef.current?.focus();
                }}
              >
                <Field
                  ref={inputRef}
                  type="text"
                  value={href}
                  onChange={handleInputChange}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  placeholder="URL or page"
                  aria-label="Link URL or page"
                  trailing={<ChevronDownIcon className="w-4 h-4" />}
                />
              </div>

              {/* Dropdown — Popover portals to body and handles position/flip/outside-click */}
              <Popover
                isOpen={showDropdown}
                onClose={() => {
                  setShowDropdown(false);
                  updateInteracting(false);
                }}
                triggerRef={inputContainerRef}
                placement="bottom-start"
                width="trigger"
                maxHeight={192}
              >
                <div
                  onMouseDown={(e) => {
                    // Prevent blur when clicking dropdown
                    e.preventDefault();
                    updateInteracting(true);
                  }}
                >
                  {filteredOptions.length > 0 ? (
                    filteredOptions.map(option => (
                      <MenuItem
                        key={option.value}
                        label={option.label}
                        shortcut={option.path}
                        onSelect={() => handleSelectPage(option)}
                      />
                    ))
                  ) : (
                    <div className="px-2 py-1.5 text-xs text-text-secondary">
                      Type a URL or create pages first
                    </div>
                  )}
                </div>
              </Popover>
            </div>

            {follow}
          </div>

          <Row
            title="Open in a new tab"
            size="sm"
            hover={false}
            className="pl-1 pr-8"
            right={[{ type: 'toggle', value: openInNewTab, onChange: handleNewTabToggle, 'aria-label': 'Open in a new tab' }]}
          />

          <div className="pr-8" onMouseDown={(e) => { e.stopPropagation(); }}>
            <Row title="Aria label" size="sm" className="pl-1 pr-0" hover={false} />
            <Field value={ariaLabel} onChange={setAriaLabel} onBlur={handleAriaLabelBlur} aria-label="Aria label" />
          </div>
        </div>
      )}
    </div>
  );
};

export default LinkBlock;
