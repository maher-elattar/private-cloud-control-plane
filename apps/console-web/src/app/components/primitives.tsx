/**
 * Shared UI primitives.
 *
 * These reproduce the console's building blocks: buttons, badges, cards, callouts, tab bars,
 * empty states, and the determinate progress bar shown while a server provisions. Visual values
 * come from the captured design tokens in `styles.css` — prefer extending a primitive here over
 * re-styling ad hoc in a route.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { NavLink } from 'react-router';
import { CheckIcon, ExternalLinkIcon, PlusIcon, WarningIcon } from './icons';

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md';
};

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // WHY: disabled uses a lighter red rather than grey — the console keeps unavailable primary
  // actions recognisably "the primary action" instead of demoting them to a neutral colour.
  primary:
    'bg-primary text-white hover:bg-primary-hover disabled:bg-primary-disabled disabled:cursor-not-allowed',
  secondary:
    'bg-button-secondary text-text hover:bg-button-secondary-hover disabled:bg-button-secondary-disabled disabled:text-text-disabled disabled:cursor-not-allowed',
  ghost: 'bg-transparent text-text hover:bg-surface-hover',
};

/** Console button. Primary is the red CTA; secondary is the neutral grey action. */
export function Button({ variant = 'primary', size = 'md', className = '', ...rest }: ButtonProps) {
  const sizing = size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-5 text-[0.9375rem]';
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded font-semibold transition-colors ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

type BadgeTone = 'grey' | 'green' | 'orange' | 'red' | 'plain';

const BADGE_TONES: Record<BadgeTone, string> = {
  grey: 'bg-badge-grey-bg text-badge-grey-fg',
  green: 'bg-badge-green-bg text-badge-green-fg',
  orange: 'bg-badge-orange-bg text-badge-orange-fg',
  red: 'bg-badge-red-bg text-badge-red-fg',
  plain: 'bg-badge-plain text-text-muted',
};

/** Small pill used for spec tags, architecture labels, and status. */
export function Badge({
  tone = 'grey',
  children,
  className = '',
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-[0.1875rem] text-xs font-medium ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** The purple "NEW" marker the console puts on recently released server types. */
export function NewBadge() {
  return (
    <span className="inline-flex items-center rounded bg-[#6f42c1] px-1.5 py-[0.125rem] text-[0.625rem] font-bold tracking-wide text-white">
      NEW
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

/** White surface with the console's 2rem padding. */
export function Card({
  children,
  className = '',
  padded = true,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly padded?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-border bg-surface ${padded ? 'p-card' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

/** Uppercase section heading used inside cards (ACTIVITIES, OPTIONS, LOCATION). */
export function CardTitle({
  icon,
  children,
}: {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold tracking-wide text-text">
      {icon ? <span className="text-primary">{icon}</span> : null}
      {children}
    </h2>
  );
}

/* -------------------------------------------------------------------------- */
/* Callout                                                                    */
/* -------------------------------------------------------------------------- */

type CalloutTone = 'info' | 'warning' | 'error';

const CALLOUT_TONES: Record<CalloutTone, string> = {
  info: 'bg-callout-info-bg text-callout-info-fg border-[hsl(0_0%_15%/0.1)]',
  warning: 'bg-callout-warning-bg text-callout-warning-fg border-[hsl(37_91%_35%/0.15)]',
  error: 'bg-callout-error-bg text-callout-error-fg border-[hsl(0_100%_40%/0.1)]',
};

/** Inline advisory block — the amber "No SSH key selected" notice is a warning callout. */
export function Callout({
  tone = 'info',
  title,
  children,
}: {
  readonly tone?: CalloutTone;
  readonly title?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={`flex gap-2.5 rounded border px-4 py-3 text-sm ${CALLOUT_TONES[tone]}`}>
      <WarningIcon size={18} className="mt-px shrink-0" />
      <div>
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="[&>p]:mt-0.5">{children}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

export type TabItem = { readonly label: string; readonly to: string; readonly end?: boolean };

/** Underlined tab bar. The active tab is red with a 2px red underline. */
export function TabBar({
  items,
  className = '',
}: {
  readonly items: readonly TabItem[];
  readonly className?: string;
}) {
  return (
    <nav className={`flex gap-6 overflow-x-auto ${className}`}>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          className={({ isActive }) =>
            `-mb-px whitespace-nowrap border-b-2 pb-2.5 text-[0.9375rem] transition-colors ${
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-text hover:text-text-muted'
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Segmented control used for Shared / Dedicated Resources and OS Images / Apps. */
export function SegmentedTabs({
  options,
  value,
  onChange,
}: {
  readonly options: readonly string[];
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  return (
    <div className="flex gap-5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`flex-1 rounded border bg-surface py-2.5 text-center text-[0.9375rem] transition-colors ${
            value === option
              ? 'border-border-dark font-medium text-text'
              : 'border-border text-text-muted hover:bg-surface-hover'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Centred empty state: a 10rem grey disc holding a 5rem icon, headline, muted body copy, a
 * primary CTA, and a red "Learn more" external link.
 *
 * `roadmap` marks a section the control plane does not implement yet.
 *
 * WHY the distinction is drawn in the UI and not only in a comment: an empty state and an
 * unimplemented feature look identical to a user — both are a page with nothing on it and a button
 * that does not work. One means "you have not created anything", the other means "this cannot be
 * created here yet", and a console that cannot tell them apart invites a support ticket for a
 * feature that was never shipped. The `EmptyState` already carried `actionDisabled` for exactly
 * these pages; this says out loud what that disabled button meant.
 */
export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  actionDisabled = false,
  learnMoreHref,
  roadmap = false,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly actionDisabled?: boolean;
  readonly learnMoreHref?: string;
  readonly roadmap?: boolean;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-24 text-center">
      <div className="flex size-40 items-center justify-center rounded-full bg-empty-state text-[hsl(0_0%_72%)]">
        {icon}
      </div>
      {roadmap ? (
        <span className="mt-7 rounded bg-badge-orange-bg px-2.5 py-[0.1875rem] text-[0.6875rem] font-semibold uppercase tracking-wide text-badge-orange-fg">
          On the roadmap
        </span>
      ) : null}
      <h2 className={`${roadmap ? 'mt-3' : 'mt-9'} text-lg font-bold text-text`}>{title}</h2>
      <div className="mt-2 max-w-xl text-[0.9375rem] leading-6 text-text">{description}</div>
      {roadmap ? (
        <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">
          This capability is planned but not implemented yet, so there is nothing behind this page
          to act on. Nothing here is broken.
        </p>
      ) : null}
      {actionLabel ? (
        <Button className="mt-7" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      ) : null}
      {learnMoreHref ? (
        <a
          href={learnMoreHref}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex items-center gap-2 text-[0.9375rem] text-primary hover:underline"
        >
          <ExternalLinkIcon size={15} />
          Learn more
        </a>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** Dashed "add" affordance — Add SSH key, Create Volume, Create placement group, Add labels. */
export function DashedButton({
  children,
  onClick,
  disabled = false,
  className = '',
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded border border-dashed border-border-dark px-5 py-4 text-[0.9375rem] text-dashed-content transition-colors hover:enabled:bg-dashed-hover disabled:cursor-not-allowed ${className}`}
    >
      <PlusIcon size={16} />
      {children}
    </button>
  );
}

/** Coloured dot preceding a server name. */
export function StatusDot({ state }: { readonly state: 'running' | 'off' | 'pending' | 'error' }) {
  const tone = {
    running: 'bg-status-green',
    off: 'bg-status-grey',
    pending: 'bg-status-orange',
    error: 'bg-status-red',
  }[state];
  return <span className={`inline-block size-2.5 shrink-0 rounded-full ${tone}`} />;
}

/**
 * Determinate progress bar shown in a server row while it provisions.
 *
 * WHY: the console replaces the status column with this while an operation is in flight, which
 * is the clearest signal that creation is asynchronous — the row exists before the server does.
 */
export function ProgressBar({ percent }: { readonly percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="relative h-5 w-full overflow-hidden rounded-sm bg-[hsl(0_0%_93%)]">
      <div
        className="h-full bg-primary transition-[width] duration-500"
        style={{ width: `${clamped}%` }}
      />
      <span className="absolute inset-0 flex items-center justify-end pr-2 text-xs font-medium text-text">
        {Math.round(clamped)} %
      </span>
    </div>
  );
}

/** Checkbox matching the console's red-filled checked state. */
export function Checkbox({
  label,
  description,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly label: ReactNode;
  readonly description?: ReactNode;
}) {
  return (
    <label className={`flex cursor-pointer gap-3 ${className}`}>
      <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          className="peer size-4 appearance-none rounded-[3px] border border-form-border bg-input-bg checked:border-primary checked:bg-primary disabled:cursor-not-allowed disabled:bg-form-border-disabled"
          {...rest}
        />
        <CheckIcon
          size={11}
          className="pointer-events-none absolute text-white opacity-0 peer-checked:opacity-100"
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[0.9375rem] text-text">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-sm leading-6 text-text">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

/** Labelled text input using the console's floating-label field style. */
export function TextField({
  label,
  required = false,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly required?: boolean;
}) {
  return (
    <label
      className={`block rounded border border-form-border bg-input-bg px-3 pb-1.5 pt-2 ${className}`}
    >
      <span className="block text-[0.6875rem] text-text-disabled">
        {label}
        {required ? <span className="text-primary"> *</span> : null}
      </span>
      <input
        className="w-full bg-transparent text-[0.9375rem] text-text outline-none placeholder:text-text-faint"
        {...rest}
      />
    </label>
  );
}
