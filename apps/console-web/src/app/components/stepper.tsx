/**
 * Wizard stepper chrome.
 *
 * Each section is preceded by a status marker and connected by a dashed vertical rail. The marker
 * distinguishes three states the console treats differently: satisfied (filled primary check),
 * needs attention (amber warning), and optional-and-untouched (hollow grey ring).
 */
import type { ReactNode } from 'react';
import { CheckIcon, WarningIcon } from './icons';

export type StepState = 'done' | 'warning' | 'optional';

/** The 24px circular marker rendered at the head of a step and in the summary list. */
export function StepMarker({
  state,
  className = '',
}: {
  readonly state: StepState;
  readonly className?: string;
}) {
  if (state === 'done') {
    return (
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-white ${className}`}
      >
        <CheckIcon size={12} />
      </span>
    );
  }
  if (state === 'warning') {
    return (
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full bg-status-orange text-white ${className}`}
      >
        <WarningIcon size={13} strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span
      className={`block size-5 shrink-0 rounded-full border-2 border-[hsl(0_0%_78%)] ${className}`}
    />
  );
}

/**
 * One wizard section.
 *
 * The dashed rail is drawn on the content column rather than the marker so it lines up with the
 * marker's centre and stops cleanly at the last step.
 */
export function StepperStep({
  state,
  title,
  description,
  children,
  last = false,
}: {
  readonly state: StepState;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly last?: boolean;
}) {
  return (
    <section className="relative">
      <header className="flex items-center gap-4">
        <StepMarker state={state} />
        <h2 className="text-2xl font-semibold text-text">{title}</h2>
      </header>
      <div
        className={`ml-2.5 pb-12 pl-[1.375rem] pt-5 ${
          last ? '' : 'border-l border-dashed border-primary'
        }`}
      >
        {description ? (
          <div className="mb-6 max-w-4xl text-[0.9375rem] leading-6 text-text">{description}</div>
        ) : null}
        {children}
      </div>
    </section>
  );
}
