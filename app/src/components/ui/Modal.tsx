/**
 * Modal - THE overlay. One dim layer (bg-black/50, z-modal), one panel style
 * (rounded-outer, shadow-modal), sizes sm|md|lg (or 'auto' for legacy
 * self-sized content).
 *
 * An open window owns the keyboard: focus moves into the panel (a field that
 * autofocuses keeps it), Tab cycles inside it, Escape closes it and goes no
 * further (the canvas behind never also deselects), and closing hands focus
 * back to whatever had it.
 *
 * Popovers/Menus inside it (portaled to body) register with it like nested
 * popovers do: a click inside one is inside the modal, Escape closes the
 * popover first, and they stack above the modal.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { tx } from '@/i18n';
import { cx } from './cx';
import { PopoverLayer, PopoverNesting, type RegisterPanel } from './Popover';

const ABOVE_MODAL = 'calc(var(--z-modal) + 1)';
/** What Tab can land on (disabled and unrendered ones are filtered out). */
const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export type ModalSize = 'sm' | 'md' | 'lg' | 'picker' | 'auto';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The window's name for assistive tech: its visible title. */
  'aria-label': string;
  children: React.ReactNode;
  size?: ModalSize;
  className?: string;
}

const sizes: Record<ModalSize, string> = {
  sm: 'w-[400px] max-w-[90vw]',
  md: 'w-[560px] max-w-[90vw]',
  lg: 'w-[800px] max-w-[90vw]',
  // ⌘K-family pickers (ComponentPickerModal, StylePickerModal) share this shell
  picker: 'w-[602px] h-[500px] max-w-[90vw] flex flex-col',
  auto: '',
};

export const Modal: React.FC<ModalProps> = ({ isOpen, ...props }) => (isOpen ? <OpenModal {...props} /> : null);

function OpenModal({ onClose, children, size = 'auto', className = '', 'aria-label': label }: Omit<ModalProps, 'isOpen'>) {
  const name = tx(label);
  const modalRef = useRef<HTMLDivElement>(null);
  const panels = useRef(new Set<HTMLElement>());
  const register = useCallback<RegisterPanel>((el) => { panels.current.add(el); return () => { panels.current.delete(el); }; }, []);
  // Read while the open renders, before a child's autoFocus moves focus inside.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const panel = modalRef.current!;
    if (!panel.contains(document.activeElement)) panel.focus();
    // Closed (the panel left the page) and nothing else took the focus: it goes back. A StrictMode re-run keeps the panel.
    return () => { if (!panel.isConnected && document.activeElement === document.body) opener?.focus(); };
  }, [opener]);

  useEffect(() => {
    const inside = (node: Node | null) =>
      !!node && (!!modalRef.current?.contains(node) || [...panels.current].some((el) => el.contains(node)));
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !inside(event.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      const panel = modalRef.current;
      if (!panel) return;
      if (e.key === 'Escape' && !panels.current.size) { // an open popover closes first (its own Escape)
        e.preventDefault();
        e.stopPropagation(); // the window's Escape — the canvas's own (on window) never also runs
        onClose();
      } else if (e.key === 'Tab' && !e.defaultPrevented) { // off either end, Tab wraps to the other
        const items = [...panel.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => !el.matches(':disabled') && el.checkVisibility?.() !== false);
        const first = items[0] ?? panel;
        const last = items[items.length - 1] ?? panel;
        const active = document.activeElement;
        if (!inside(active) || (e.shiftKey ? active === first || active === panel : active === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 pointer-events-auto">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
        className={cx(
          'bg-bg rounded-outer shadow-modal max-h-[90vh] overflow-y-auto transition-all duration-300 outline-none',
          sizes[size],
          className,
        )}
      >
        <PopoverNesting.Provider value={register}>
          <PopoverLayer.Provider value={ABOVE_MODAL}>{children}</PopoverLayer.Provider>
        </PopoverNesting.Provider>
      </div>
    </div>
  );
}

export default Modal;
