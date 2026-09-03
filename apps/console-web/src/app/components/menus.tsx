/**
 * Menu primitives: the row overflow menu and the grouped select.
 *
 * Both anchor a floating panel to a trigger and close on outside click or Escape. The console
 * uses the overflow menu for per-row actions and the grouped select wherever options carry a
 * category — locations grouped by network zone, servers grouped by the zone they can serve.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDownIcon, DotsIcon } from './icons';

/** Closes the panel when focus or a click lands outside the wrapper, or Escape is pressed. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return ref;
}

export type MenuAction = {
  readonly label: string;
  readonly onSelect: () => void;
  /** Renders the item in the primary colour, reserved for destructive actions. */
  readonly destructive?: boolean;
  readonly disabled?: boolean;
};

/** The `⋯` overflow menu shown at the end of a table row. */
export function ContextMenu({
  actions,
  label,
}: {
  readonly actions: readonly MenuAction[];
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex size-8 items-center justify-center rounded-full transition-colors ${
          open
            ? 'bg-[hsl(0_0%_91%)] text-text'
            : 'text-text-faint hover:bg-surface-hover hover:text-text'
        }`}
      >
        <DotsIcon size={20} />
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[11rem] overflow-hidden rounded-lg border border-border bg-surface py-2 shadow-overlay">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled ?? false}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              className={`block w-full px-5 py-2.5 text-left text-[0.9375rem] transition-colors disabled:cursor-not-allowed disabled:text-text-disabled ${
                action.destructive ? 'text-primary' : 'text-text'
              } hover:enabled:bg-surface-hover`}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type SelectGroup<T extends string> = {
  readonly heading: string;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly prefix?: ReactNode;
  }[];
};

/**
 * Select whose options are organised under sticky category headings.
 *
 * Rendered as a button plus panel rather than a native `<select>` because the console's options
 * carry a leading glyph — a flag, or a server's status dot — which a native option cannot show.
 */
export function GroupedSelect<T extends string>({
  groups,
  value,
  placeholder,
  label,
  required = false,
  invalid = false,
  onChange,
  className = '',
}: {
  readonly groups: readonly SelectGroup<T>[];
  readonly value: T | null;
  readonly placeholder: string;
  readonly label?: string;
  readonly required?: boolean;
  readonly invalid?: boolean;
  readonly onChange: (next: T) => void;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  const selected = groups
    .flatMap((group) => group.options)
    .find((option) => option.value === value);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded border bg-input-bg px-3 text-left ${
          label ? 'pb-1.5 pt-2' : 'h-10'
        } ${open || invalid ? 'border-primary' : 'border-form-border hover:border-border-dark'}`}
      >
        <span className="min-w-0 flex-1">
          {label ? (
            <span className="block text-[0.6875rem] text-text-disabled">
              {label}
              {required ? <span className="text-primary"> *</span> : null}
            </span>
          ) : null}
          <span className="flex items-center gap-2 truncate text-[0.9375rem]">
            {selected?.prefix}
            <span className={selected ? 'text-text' : 'text-text-faint'}>
              {selected?.label ?? placeholder}
            </span>
          </span>
        </span>
        <ChevronDownIcon size={16} className="shrink-0 text-text-muted" />
      </button>

      {open ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded border border-border bg-surface shadow-overlay scrollbar-thin">
          {groups.map((group) => (
            <div key={group.heading}>
              <p className="sticky top-0 bg-dropdown-header px-4 py-2 text-[0.6875rem] uppercase tracking-wide text-text-muted">
                {group.heading}
              </p>
              {group.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[0.9375rem] transition-colors hover:bg-dropdown-hover ${
                    option.value === value ? 'bg-dropdown-active' : ''
                  }`}
                >
                  {option.prefix}
                  {option.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
