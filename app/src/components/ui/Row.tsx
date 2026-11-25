import { GripIcon as SharedGripIcon } from '@/assets/icons';
/**
 * Row - THE list atom. Every list-like piece of chrome (tree items, panel
 * lists, section headers, menu items, SEO rows) is a Row.
 *
 * Superset of the old DesignBar/inputs/Row + common/Row + tree behavior
 * (depth indent, dnd wiring, drop indicators) that used to live in TreeRow.
 *
 * @example Typed slots
 * <Row
 *   title="Hero"
 *   left={[{ type: 'chevron', expanded, onToggle }, { type: 'icon', icon: <BoxIcon /> }]}
 *   right={[{ type: 'toggle', value, onChange }, { type: 'custom', node: <Button …/>, unboxed: true, showOnHover: true }]}
 *   depth={2}
 *   dnd={{ id, dragType: 'layer' }}
 *   selected
 * />
 *
 * @example Section header (legacy alias props still work)
 * <Row title="Layout" expandable expanded={open} onExpandChange={setOpen}>…</Row>
 */
import React, { forwardRef, useCallback, useState } from 'react';
import { tx } from '@/i18n';
import { ChevronDownBigIcon } from '@/assets/icons';
import { cx } from './cx';
import { renderSlot, renderSlotSkeleton, type RowSlotSpec, type SlotSize } from './Slot';
import { SkeletonText } from './Skeleton';
import { useTreeNodeDnd, TreeDropIndicator } from './SortableTree';
import { Button } from './Button';

export type RowSize = 'md' | 'sm';

export interface RowDnd {
  id: string;
  dragType: string;
  disabled?: boolean;
}

export interface RowProps {
  /** Row title (string or node) */
  title?: React.ReactNode;
  /** Optional caption/subtitle */
  caption?: string;
  /** Right-aligned text (e.g., value display) */
  rightText?: string;

  /** Typed slot controls before the title (or any ReactNode, rendered as-is) */
  left?: RowSlotSpec[] | React.ReactNode;
  /** Typed slot controls after rightText (or any ReactNode, rendered as-is) */
  right?: RowSlotSpec[] | React.ReactNode;

  /** @deprecated legacy alias for `left` as ReactNode (DesignBar/inputs/Row) */
  leftIcons?: React.ReactNode;
  /** @deprecated legacy alias for `right` as ReactNode (DesignBar/inputs/Row) */
  rightIcons?: React.ReactNode;

  /** Enable expand/collapse behavior (adds trailing chevron button) */
  expandable?: boolean;
  /** Controlled expanded state; omit for uncontrolled */
  expanded?: boolean;
  /** Initial state when uncontrolled (default true, matching DesignBar/inputs/Row) */
  defaultExpanded?: boolean;
  onExpandChange?: (expanded: boolean) => void;

  /** Tree indent level (28px rows; 8 + depth*20 px left padding) */
  depth?: number;
  /** dnd-kit wiring; requires a SortableTreeProvider ancestor */
  dnd?: RowDnd;

  size?: RowSize;
  disabled?: boolean;
  selected?: boolean;
  /** The loading state: this same row as pulsing shapes — each slot keeps its box, the title/caption/rightText become bars
   *  exactly as wide as their words — not interactive, hidden from readers (wrap the list in role="status"). */
  skeleton?: boolean;
  /** Hover highlight (default true when the row is interactive) */
  hover?: boolean;

  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;

  /** Tailwind pass-through — twMerge, caller overrides win */
  className?: string;
  /** Extra attributes spread onto the inner row div (data-* attrs, external
   *  dnd listeners for trees that manage their own drag wiring) */
  rowProps?: React.HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, unknown>;
  /** Expandable content */
  children?: React.ReactNode;

  /** @deprecated legacy drag handle (DesignBar/inputs/Row) */
  draggable?: boolean;
  /** @deprecated */
  onDragStart?: () => void;
  /** @deprecated */
  onDragEnd?: () => void;
}

const sizeConfig: Record<RowSize, {
  verticalPadding: string;
  buttonSize: 'md' | 'sm';
  titleGap: string;
  titleText: string;
  /** The title's line height (a skeleton bar is centered in it) */
  titleLine: string;
  slotSize: SlotSize;
}> = {
  md: {
    verticalPadding: 'py-2.5',
    buttonSize: 'md',
    titleGap: 'ml-1.5',
    titleText: 'text-sm',
    titleLine: 'h-5',
    slotSize: 'md',
  },
  sm: {
    verticalPadding: 'py-2',
    buttonSize: 'sm',
    titleGap: 'ml-1',
    titleText: 'text-xs',
    titleLine: 'h-4',
    slotSize: 'sm',
  },
};

function renderSide(
  side: RowSlotSpec[] | React.ReactNode,
  slotSize: SlotSize,
  skeleton = false,
): React.ReactNode {
  if (side == null) return null;
  if (skeleton) { // hover actions don't exist yet; legacy ReactNode sides have no known shape
    return Array.isArray(side)
      ? side.map((spec, i) => (spec.showOnHover ? null : <React.Fragment key={i}>{renderSlotSkeleton(spec, slotSize)}</React.Fragment>))
      : null;
  }
  if (Array.isArray(side)) {
    return side.map((spec, i) => (
      <React.Fragment key={i}>
        {/* Opacity, not visibility: a hidden action stays in the Tab order and shows while focus is in it. */}
        <span className={cx('contents', spec.showOnHover && '[&>*]:opacity-0 group-hover/row:[&>*]:opacity-100 focus-within:[&>*]:opacity-100')}>
          {renderSlot(spec, slotSize)}
        </span>
      </React.Fragment>
    ));
  }
  return side;
}

/** Inner row without dnd hooks so useTreeNodeDnd is only called when wired. */
const RowBase = forwardRef<HTMLDivElement, RowProps & { dndState?: ReturnType<typeof useTreeNodeDnd> }>(
  (
    {
      title,
      caption,
      rightText,
      left,
      right,
      leftIcons,
      rightIcons,
      expandable = false,
      expanded: controlledExpanded,
      defaultExpanded = true,
      onExpandChange,
      depth,
      size = 'md',
      disabled = false,
      selected = false,
      skeleton = false,
      hover,
      onClick,
      onDoubleClick,
      onContextMenu,
      className = '',
      rowProps,
      children,
      draggable = false,
      onDragStart,
      onDragEnd,
      dndState,
    },
    ref,
  ) => {
    const config = sizeConfig[size];

    const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
    const isControlled = controlledExpanded !== undefined;
    const isExpanded = isControlled ? controlledExpanded : internalExpanded;

    const toggle = useCallback(() => {
      if (!isControlled) setInternalExpanded((v) => !v);
      onExpandChange?.(!isExpanded);
    }, [isControlled, isExpanded, onExpandChange]);

    const handleRowClick = useCallback(
      (e: React.MouseEvent) => {
        if (disabled) return;
        if (expandable) toggle();
        onClick?.(e);
      },
      [disabled, expandable, toggle, onClick],
    );

    const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

    const isInteractive = !skeleton && !disabled && (expandable || !!onClick || !!dndState);
    const hoverEnabled = hover ?? isInteractive;

    const leftContent = renderSide(left ?? leftIcons, config.slotSize, skeleton);
    const rightContent = renderSide(right ?? rightIcons, config.slotSize, skeleton);

    const dropZone = dndState?.dropZone ?? null;

    const rowClasses = cx(
      'relative flex items-center pl-1 pr-2 group/row',
      config.verticalPadding,
      isInteractive && 'cursor-pointer group',
      hoverEnabled && 'hover:bg-bg-hover',
      'transition-colors',
      disabled && !skeleton && 'opacity-50',
      selected && !skeleton && 'bg-bg-selected hover:bg-bg-selected-hover text-text',
      dndState?.isDragging && 'opacity-40',
      dropZone === 'inside' && 'bg-info-subtle',
      className,
    );

    const titleTextClass = cx(
      'font-normal truncate',
      config.titleText,
      isInteractive ? 'text-text-muted group-hover:text-text' : 'text-text-muted',
      selected && 'text-text',
    );

    const indentStyle = depth !== undefined ? { paddingLeft: `${8 + depth * 20}px` } : undefined;

    return (
      <div ref={ref}>
        <div
          ref={dndState?.setNodeRef}
          className={rowClasses}
          style={indentStyle}
          onClick={skeleton ? undefined : handleRowClick}
          onDoubleClick={skeleton ? undefined : onDoubleClick}
          onContextMenu={skeleton ? undefined : onContextMenu}
          {...(dndState ? { ...dndState.attributes, ...dndState.listeners } : {})}
          {...rowProps}
          {...(skeleton ? { 'aria-hidden': true } : {})}
        >
          {dropZone === 'above' && <TreeDropIndicator position="above" />}
          {dropZone === 'below' && <TreeDropIndicator position="below" />}

          {/* Left section */}
          {((draggable && !skeleton) || leftContent) && (
            <div className="flex items-center gap-1" onClick={Array.isArray(left ?? leftIcons) ? undefined : stop}>
              {draggable && !skeleton && (
                <Button
                  variant="ghost"
                  size={config.buttonSize}
                  iconOnly
                  aria-label="Drag"
                  className="cursor-grab active:cursor-grabbing text-text-secondary"
                  onMouseDown={onDragStart}
                  onMouseUp={onDragEnd}
                >
                  <SharedGripIcon className="w-4 h-4" />
                </Button>
              )}
              {leftContent}
            </div>
          )}

          {/* Title section */}
          <div className={cx('flex-1 min-w-0', (leftContent || (draggable && !skeleton)) ? config.titleGap : false)}>
            {title !== undefined && <div className={titleTextClass}>{skeleton ? <SkeletonText line={config.titleLine}>{title}</SkeletonText> : title}</div>}
            {caption && <div className="text-xs truncate text-text-secondary">{skeleton ? <SkeletonText line="h-4" bar="h-2.5">{tx(caption)}</SkeletonText> : tx(caption)}</div>}
          </div>

          {/* Right section */}
          <div className="flex items-center gap-1">
            {rightText && <span className={cx(config.titleText, 'text-text-secondary mr-1')}>
              {skeleton ? <SkeletonText line={config.titleLine}>{rightText}</SkeletonText> : rightText}</span>}
            {rightContent && (
              <div className="flex items-center gap-1" onClick={Array.isArray(right ?? rightIcons) ? undefined : stop}>
                {rightContent}
              </div>
            )}
            {expandable && !skeleton && (
              <Button
                variant="ghost"
                size={config.buttonSize}
                iconOnly
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
              >
                <ChevronDownBigIcon
                  className={cx('w-4 h-4 transition-transform duration-150', isExpanded ? 'rotate-0' : '-rotate-90')}
                />
              </Button>
            )}
          </div>
        </div>

        {/* Expanded content */}
        {expandable && isExpanded && children && <div>{children}</div>}
      </div>
    );
  },
);
RowBase.displayName = 'RowBase';

const DndRow = forwardRef<HTMLDivElement, RowProps>((props, ref) => {
  const dndState = useTreeNodeDnd(props.dnd!.id, props.dnd!.dragType, props.dnd!.disabled || props.disabled);
  return <RowBase ref={ref} {...props} dndState={dndState} />;
});
DndRow.displayName = 'DndRow';

export const Row = forwardRef<HTMLDivElement, RowProps>((props, ref) =>
  props.dnd ? <DndRow ref={ref} {...props} /> : <RowBase ref={ref} {...props} />,
);
Row.displayName = 'Row';

export default Row;
