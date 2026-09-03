/**
 * Global top bar: product mark, project switcher, global search, and the right-hand utilities.
 *
 * Fixed at `--top-bar-element-height` (4rem) with a white surface and a bottom hairline. The
 * wordmark is deliberately this product's own, not the reference console's brand.
 */
import { BellIcon, ChevronDownIcon, GridIcon, SearchIcon, UserIcon } from '../components/icons';

/** Trigger with a chevron, used for each utility cluster on the right of the bar. */
function UtilityButton({
  children,
  badge,
  label,
}: {
  readonly children: React.ReactNode;
  readonly badge?: number;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="relative flex h-9 items-center gap-1 rounded px-2 text-text-muted transition-colors hover:bg-surface-hover"
    >
      <span className="relative">
        {children}
        {badge ? (
          <span className="absolute -right-2 -top-2 flex size-4 items-center justify-center rounded-full bg-primary text-[0.625rem] font-bold text-white">
            {badge}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon size={14} />
    </button>
  );
}

export function TopBar({
  projectName,
  activityCount,
}: {
  readonly projectName: string;
  readonly activityCount: number;
}) {
  return (
    <header className="flex h-topbar shrink-0 items-center gap-4 border-b border-border bg-surface px-6">
      <div className="flex items-center gap-3">
        <span className="text-xl font-extrabold tracking-[0.12em] text-primary">CONTROL</span>
        <span className="text-xl font-normal text-text">Console</span>
      </div>

      <span className="h-7 w-px bg-border" />

      <button
        type="button"
        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[0.9375rem] text-text transition-colors hover:bg-surface-hover"
      >
        {projectName}
        <ChevronDownIcon size={14} />
      </button>

      <div className="mx-auto w-full max-w-[28rem]">
        <div className="flex h-9 items-center gap-2 rounded bg-[hsl(0_0%_93%)] px-3 text-text-disabled transition-colors hover:bg-[hsl(0_0%_95%)]">
          <SearchIcon size={16} />
          <input
            placeholder="Search…"
            className="w-full bg-transparent text-[0.9375rem] text-text outline-none placeholder:text-text-disabled"
          />
          <kbd className="shrink-0 whitespace-nowrap rounded bg-[hsl(0_0%_88%)] px-1.5 py-0.5 text-[0.6875rem] text-text-muted">
            Ctrl K
          </kbd>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <UtilityButton label="Activities" badge={activityCount}>
          <BellIcon size={19} />
        </UtilityButton>
        <UtilityButton label="Products">
          <GridIcon size={19} />
        </UtilityButton>
        <UtilityButton label="Account">
          <UserIcon size={19} />
        </UtilityButton>
      </div>
    </header>
  );
}
