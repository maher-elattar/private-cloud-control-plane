/**
 * Platform status strip pinned under the top bar.
 *
 * Summarises open incidents by category. Sits on the canvas colour rather than a card so it reads
 * as chrome rather than content.
 */
import { ChevronDownIcon, WarningIcon } from '../components/icons';

export type IncidentSummary = {
  readonly outage: number;
  readonly maintenance: number;
  readonly other: number;
  readonly lastUpdated: string;
};

function Count({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <span className="flex gap-1.5">
      <span className="text-text-muted">{label}:</span>
      <span className="font-medium text-text">{value}</span>
    </span>
  );
}

export function IncidentsBar({ summary }: { readonly summary: IncidentSummary }) {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-border bg-[hsl(0_0%_93%)] px-8 py-4">
      <WarningIcon size={22} className="text-status-orange" />
      <div>
        <p className="text-lg font-semibold text-text">Important status messages</p>
        <div className="mt-0.5 flex gap-5 text-[0.9375rem]">
          <Count label="Outage" value={summary.outage} />
          <Count label="Maintenance" value={summary.maintenance} />
          <Count label="Other" value={summary.other} />
        </div>
      </div>
      <button
        type="button"
        className="ml-auto flex items-center gap-2 text-[0.9375rem] text-text-muted transition-colors hover:text-text"
      >
        Last updated: {summary.lastUpdated}
        <ChevronDownIcon size={16} />
      </button>
    </div>
  );
}
