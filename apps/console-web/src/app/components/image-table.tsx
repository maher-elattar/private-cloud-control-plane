/**
 * Table of stored disk images, shared by the snapshots and backups tabs.
 *
 * A row that is still being written shows a determinate progress bar with a spinner in its status
 * cell instead of a status word — the same treatment the servers list gives a provisioning
 * instance, so "work in flight" reads identically everywhere in the console.
 */
import { ChevronDownIcon, DotsIcon } from './icons';
import { ProgressBar } from './primitives';
import { Spinner } from './overlays';
import { relativeTime } from '../data/store';
import type { DiskImage } from '../data/types';

export function ImageTable({
  images,
  showId = false,
  emptyMessage,
  onDelete,
}: {
  readonly images: readonly DiskImage[];
  readonly showId?: boolean;
  readonly emptyMessage: string;
  readonly onDelete?: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[46rem] text-[0.9375rem]">
        <thead>
          <tr className="bg-table-head text-left text-[0.6875rem] uppercase tracking-wide text-text-muted">
            {showId ? <th className="px-6 py-3.5 font-normal">ID</th> : null}
            <th className="px-6 py-3.5 font-normal">Description</th>
            <th className="px-6 py-3.5 font-normal">
              <span className="inline-flex items-center gap-1">
                Created
                <ChevronDownIcon size={13} />
              </span>
            </th>
            <th className="px-6 py-3.5 font-normal">Image size</th>
            <th className="px-6 py-3.5 font-normal">Status</th>
            <th className="w-16 px-6 py-3.5" />
          </tr>
        </thead>
        <tbody>
          {images.length === 0 ? (
            <tr>
              <td colSpan={showId ? 6 : 5} className="px-6 py-8 text-center text-text-muted">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            images.map((image) => (
              <tr key={image.id} className="border-t border-border">
                {showId ? <td className="px-6 py-5">{image.id}</td> : null}
                <td className="px-6 py-5">
                  {/* Dotted underline marks the description as editable in place. */}
                  <span className="border-b border-dotted border-border-dark">
                    {image.description}
                  </span>
                </td>
                <td className="px-6 py-5">{relativeTime(image.createdAt)}</td>
                <td className="px-6 py-5">{image.sizeGb.toFixed(2)} GB</td>
                <td className="px-6 py-5">
                  {image.status === 'creating' ? (
                    <span className="flex items-center gap-3">
                      <span className="w-56">
                        <ProgressBar percent={image.progressPercent ?? 0} />
                      </span>
                      <Spinner className="text-primary" />
                    </span>
                  ) : (
                    'Available'
                  )}
                </td>
                <td className="px-6 py-5 text-right">
                  {onDelete && image.status === 'available' ? (
                    <button
                      type="button"
                      aria-label={`Actions for ${image.description}`}
                      onClick={() => onDelete(image.id)}
                      className="text-text-faint transition-colors hover:text-text"
                    >
                      <DotsIcon size={20} />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
