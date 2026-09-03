/**
 * Overlay and feedback primitives: modal dialogs, toasts, and the inline button spinner.
 *
 * The console uses two modal shapes — a confirmation (copy plus an optional advisory line) and a
 * form (a single required field). Both share the same frame: a blurred page behind a dark scrim,
 * a white card, and a grey footer bar holding Cancel plus the primary action.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './primitives';
import { WarningIcon } from './icons';

/** Spinner sized to sit inside a button label. */
export function Spinner({
  size = 16,
  className = '',
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`animate-spin ${className}`}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Modal dialog.
 *
 * WHY the page is blurred rather than only dimmed: the console blurs the underlying content so a
 * billing confirmation cannot be misread as part of the page behind it.
 */
export function Modal({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  confirmDisabled = false,
  busy = false,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly confirmDisabled?: boolean;
  readonly busy?: boolean;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-white/40 backdrop-blur-[3px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-[36rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg bg-surface shadow-overlay"
      >
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="absolute right-4 top-4 text-lg leading-none text-text-muted transition-colors hover:text-text"
        >
          ×
        </button>
        <div className="px-card pb-7 pt-7">
          <h2 className="text-[1.75rem] font-semibold text-text">{title}</h2>
          <div className="mt-4 text-[0.9375rem] leading-6 text-text">{children}</div>
        </div>
        <div className="flex justify-end gap-3 bg-modal-footer px-card py-4">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={confirmDisabled || busy}>
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Modal with no action bar — it reports an outcome rather than asking for a decision.
 *
 * WHY it has no confirm button: the work has already happened by the time this appears, so the
 * only affordance that makes sense is dismissal.
 */
export function InfoModal({
  open,
  title,
  children,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-white/40 backdrop-blur-[3px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-[36rem] max-w-[calc(100vw-2rem)] rounded-lg bg-surface px-card py-7 shadow-overlay"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-lg leading-none text-text-muted transition-colors hover:text-text"
        >
          ×
        </button>
        <h2 className="text-[1.75rem] font-semibold text-text">{title}</h2>
        <div className="mt-4 text-[0.9375rem] leading-6 text-text">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Dark click-to-copy command block.
 *
 * Shown when the console hands the user a shell command they must run themselves — configuring a
 * floating IP on the guest, for instance, which the control plane cannot do from outside.
 */
export function CodeBlock({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="Click to copy"
      className="flex w-full items-center gap-3 overflow-x-auto rounded bg-console-dark px-5 py-4 text-left font-mono text-sm text-[hsl(0_0%_88%)] transition-opacity hover:opacity-90"
    >
      <span className="whitespace-nowrap">
        <span className="select-none text-[hsl(0_0%_55%)]">$ </span>
        {command}
      </span>
      <span className="ml-auto shrink-0 text-xs text-[hsl(0_0%_60%)]">
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

/** Muted advisory line inside a modal, e.g. "Volumes are not included in backups." */
export function ModalNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="mt-4 flex items-center gap-2 text-sm text-text-muted">
      <WarningIcon size={15} className="shrink-0" />
      {children}
    </p>
  );
}

export type Toast = { readonly id: string; readonly message: string; readonly scope: string };

/**
 * Transient notification stack, bottom-centred.
 *
 * The console anchors these to the bottom of the viewport with a dark leading bar so they read as
 * system feedback rather than page content.
 */
export function ToastStack({ toasts }: { readonly toasts: readonly Toast[] }) {
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex w-[24rem] max-w-[calc(100vw-2rem)] items-center gap-3 overflow-hidden rounded bg-surface py-4 pl-5 pr-4 shadow-raised before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-console-dark"
          style={{ position: 'relative' }}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[hsl(0_0%_93%)] text-[0.6875rem] text-text-muted">
            i
          </span>
          <span className="text-[0.9375rem] text-text">{toast.message}</span>
          <span className="ml-auto shrink-0 text-sm text-text-disabled">{toast.scope}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
