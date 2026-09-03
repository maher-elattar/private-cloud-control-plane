/**
 * Servers list.
 *
 * Empty until the project holds an instance, then a row per server. A row that is still
 * provisioning shows a determinate progress bar in place of its created-at column — the list is
 * the first place the asynchronous nature of creation becomes visible to a tenant.
 */
import { Link, useNavigate } from 'react-router';
import { Button, EmptyState, ProgressBar, StatusDot } from '../../components/primitives';
import { DotsIcon, FilterIcon, ServerIcon, SlidersIcon } from '../../components/icons';
import { relativeTime, useConsole } from '../../data/store';

function Toolbar({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label="Filter"
        className="flex size-10 items-center justify-center rounded bg-button-secondary text-text-muted transition-colors hover:bg-button-secondary-hover"
      >
        <FilterIcon size={17} />
      </button>
      <Button onClick={onAdd}>Add Server</Button>
    </div>
  );
}

export function ServerList() {
  const { instances } = useConsole();
  const navigate = useNavigate();

  if (instances.length === 0) {
    return (
      <>
        <div className="flex justify-end pt-4" />
        <EmptyState
          icon={<ServerIcon size={80} />}
          title="You don't have any servers yet."
          description="Go ahead and create your first server now – it only takes a few seconds."
          actionLabel="Add Server"
          onAction={() => {
            void navigate('/servers/create');
          }}
          learnMoreHref="#"
        />
      </>
    );
  }

  return (
    <div className="pt-4">
      <div className="flex justify-end">
        <Toolbar
          onAdd={() => {
            void navigate('/servers/create');
          }}
        />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[52rem] border-separate border-spacing-y-2">
          <thead>
            <tr className="text-left text-[0.9375rem] text-text-muted">
              <th className="w-10 pb-1 pl-4 font-normal">
                <input type="checkbox" className="size-4 rounded-[3px] border border-form-border" />
              </th>
              <th className="pb-1 font-normal">Name</th>
              <th className="pb-1 font-normal">Public IP</th>
              <th className="pb-1 font-normal">Location</th>
              <th className="pb-1 font-normal">Created</th>
              <th className="w-12 pb-1 pr-4 text-right font-normal">
                <SlidersIcon size={18} className="ml-auto text-text-faint" />
              </th>
            </tr>
          </thead>
          <tbody>
            {instances.map((instance) => (
              <tr key={instance.id} className="bg-surface shadow-card">
                <td className="rounded-l-lg py-5 pl-4 align-middle">
                  <input
                    type="checkbox"
                    className="size-4 rounded-[3px] border border-form-border"
                  />
                </td>
                <td className="py-5 align-middle">
                  <div className="flex items-center gap-2.5">
                    <StatusDot
                      state={instance.status === 'provisioning' ? 'pending' : instance.status}
                    />
                    <div>
                      <Link
                        to={`/servers/${instance.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {instance.name}
                      </Link>
                      <p className="mt-0.5 text-sm text-text-muted">
                        {instance.flavorName} | {instance.architecture} | {instance.diskGb} GB |{' '}
                        {instance.networkZone}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="py-5 align-middle text-[0.9375rem]">{instance.ipv4 ?? '—'}</td>
                <td className="py-5 align-middle text-[0.9375rem]">{instance.locationCity}</td>
                <td className="py-5 pr-6 align-middle text-[0.9375rem] text-text-muted">
                  {instance.status === 'provisioning' ? (
                    <ProgressBar percent={instance.progressPercent ?? 0} />
                  ) : (
                    relativeTime(instance.createdAt)
                  )}
                </td>
                <td className="rounded-r-lg py-5 pr-4 text-right align-middle">
                  <button
                    type="button"
                    aria-label={`Actions for ${instance.name}`}
                    className="text-text-faint transition-colors hover:text-text"
                  >
                    <DotsIcon size={20} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
