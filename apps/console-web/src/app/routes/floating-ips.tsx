/**
 * Floating IPs.
 *
 * A floating IP is held by the project rather than by a server, so it survives the server it
 * points at and can be re-pointed at another one in the same network zone. That is the whole
 * reason the section exists separately from a server's own addresses.
 *
 * Assignment is edited inline in the table cell rather than in a dialog — it is a single choice
 * from a short list, and keeping it in the row preserves the surrounding context.
 */
import { useState } from 'react';
import { Button, EmptyState } from '../components/primitives';
import { CodeBlock, InfoModal, Modal } from '../components/overlays';
import { ContextMenu, GroupedSelect } from '../components/menus';
import type { SelectGroup } from '../components/menus';
import { FilterIcon, FloatingIpIcon, SlidersIcon } from '../components/icons';
import { Flag } from '../components/flags';
import { FLOATING_IP_PRICE_PER_MONTH, LOCATIONS } from '../data/catalog';
import { useConsole } from '../data/store';
import type { FloatingIp } from '../data/types';

/** Locations grouped by network zone, matching how the console presents them. */
function locationGroups(): readonly SelectGroup<string>[] {
  const zones = [...new Set(LOCATIONS.map((location) => location.networkZone))];
  return zones.map((zone) => ({
    heading: zone,
    options: LOCATIONS.filter((location) => location.networkZone === zone).map((location) => ({
      value: location.id,
      label: location.city,
      prefix: <Flag country={location.countryCode} width={18} />,
    })),
  }));
}

/** The in-cell assignment editor. Only servers in the same zone are offered. */
function AssignCell({
  floatingIp,
  onAssigned,
}: {
  readonly floatingIp: FloatingIp;
  readonly onAssigned: (floatingIp: FloatingIp) => void;
}) {
  const { instances, assignFloatingIp } = useConsole();
  const [editing, setEditing] = useState(false);

  const eligible = instances.filter((instance) => instance.networkZone === floatingIp.networkZone);
  const assigned = instances.find((instance) => instance.id === floatingIp.assignedTo);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={assigned ? 'text-primary hover:underline' : 'text-text-disabled hover:underline'}
      >
        {assigned?.name ?? 'Unassigned'}
      </button>
    );
  }

  const groups: readonly SelectGroup<string>[] = [
    {
      heading: `Server (${floatingIp.networkZone})`,
      options: eligible.map((instance) => ({
        value: instance.id,
        label: instance.name,
        prefix: (
          <span
            className={`block size-2.5 rounded-full ${
              instance.status === 'running' ? 'bg-status-green' : 'bg-status-grey'
            }`}
          />
        ),
      })),
    },
  ];

  return (
    <GroupedSelect
      groups={groups}
      value={floatingIp.assignedTo}
      placeholder="Choose a Server"
      invalid
      className="w-52"
      onChange={(instanceId) => {
        assignFloatingIp(floatingIp.id, instanceId);
        setEditing(false);
        // The guest still needs the address configured on its interface, so hand over the command.
        onAssigned(floatingIp);
      }}
    />
  );
}

export function FloatingIps() {
  const { floatingIps, instances, createFloatingIp, assignFloatingIp, deleteFloatingIp } =
    useConsole();

  const [creating, setCreating] = useState(false);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<'ipv4' | 'ipv6'>('ipv4');
  const [name, setName] = useState('');
  const [configuring, setConfiguring] = useState<FloatingIp | null>(null);

  function openCreate() {
    setLocationId(null);
    setProtocol('ipv4');
    setName('');
    setCreating(true);
  }

  function submit() {
    if (!locationId) return;
    createFloatingIp({ name: name.trim() || 'floating-ip', locationId, protocol });
    setCreating(false);
  }

  const price = FLOATING_IP_PRICE_PER_MONTH[protocol];

  const createDialog = (
    <Modal
      open={creating}
      title="Add Floating IP"
      confirmLabel="Add Floating IP"
      confirmDisabled={!locationId}
      onCancel={() => setCreating(false)}
      onConfirm={submit}
    >
      <div className="flex gap-4">
        <GroupedSelect
          groups={locationGroups()}
          value={locationId}
          onChange={setLocationId}
          label="Location"
          required
          placeholder=""
          invalid={!locationId}
          className="flex-1"
        />
        <label className="flex-1 rounded border border-form-border bg-input-bg px-3 pb-1.5 pt-2">
          <span className="block text-[0.6875rem] text-text-disabled">
            Protocol<span className="text-primary"> *</span>
          </span>
          <select
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as 'ipv4' | 'ipv6')}
            className="w-full cursor-pointer bg-transparent text-[0.9375rem] text-text outline-none"
          >
            <option value="ipv4">IPv4</option>
            <option value="ipv6">IPv6</option>
          </select>
        </label>
      </div>

      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name"
        className="mt-4 h-12 w-full rounded border border-form-border bg-input-bg px-3 text-[0.9375rem] outline-none placeholder:text-text-faint focus:border-primary"
      />

      <p className="mt-4 flex items-center gap-2 text-sm text-text-muted">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-badge-plain text-[0.625rem]">
          i
        </span>
        Only servers from the same network zone can be assigned to a Floating IP
      </p>

      <div className="-mx-card mt-6 border-t border-border px-card pt-5">
        <p className="text-xl font-semibold text-primary">
          €{price.toFixed(2)}
          <span className="text-sm font-normal"> / mo</span>
        </p>
        <p className="mt-1 text-xs text-text-muted">
          All prices excl. VAT. Our{' '}
          <a href="#" className="text-primary hover:underline">
            terms and conditions
          </a>{' '}
          apply.
        </p>
      </div>
    </Modal>
  );

  if (floatingIps.length === 0) {
    return (
      <div className="px-8 py-6">
        <EmptyState
          icon={<FloatingIpIcon size={80} />}
          title="You don't have any Floating IPs yet."
          description="Floating IPs help you to create highly flexible setups. A Floating IP can be assigned and reassigned to any server at any time in any location."
          actionLabel="Add Floating IP"
          onAction={openCreate}
          actionDisabled={instances.length === 0}
          learnMoreHref="#"
        />
        {createDialog}
      </div>
    );
  }

  return (
    <div className="px-8 py-6">
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label="Filter"
          className="flex size-10 items-center justify-center rounded bg-button-secondary text-text-muted transition-colors hover:bg-button-secondary-hover"
        >
          <FilterIcon size={17} />
        </button>
        <Button onClick={openCreate}>Add Floating IP</Button>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[52rem] border-separate border-spacing-y-2">
          <thead>
            <tr className="text-left text-[0.9375rem] text-text-muted">
              <th className="w-10 pb-1 pl-4 font-normal">
                <input type="checkbox" className="size-4 rounded-[3px] border border-form-border" />
              </th>
              <th className="pb-1 font-normal">Name</th>
              <th className="pb-1 font-normal">IP</th>
              <th className="pb-1 font-normal">Assigned to</th>
              <th className="pb-1 font-normal">Reverse DNS</th>
              <th className="pb-1 font-normal">Location</th>
              <th className="w-12 pb-1 pr-4 text-right font-normal">
                <SlidersIcon size={18} className="ml-auto text-text-faint" />
              </th>
            </tr>
          </thead>
          <tbody>
            {floatingIps.map((floatingIp) => (
              <tr key={floatingIp.id} className="bg-surface shadow-card">
                <td className="rounded-l-lg py-5 pl-4">
                  <input
                    type="checkbox"
                    className="size-4 rounded-[3px] border border-form-border"
                  />
                </td>
                <td className="py-5">
                  <p className="font-medium text-text">{floatingIp.name}</p>
                  <p className="mt-0.5 text-sm text-text-muted">{floatingIp.networkZone}</p>
                </td>
                <td className="py-5 text-[0.9375rem]">{floatingIp.address}</td>
                <td className="py-5 text-[0.9375rem]">
                  <AssignCell floatingIp={floatingIp} onAssigned={setConfiguring} />
                </td>
                <td className="py-5 text-[0.9375rem]">{floatingIp.reverseDnsEntries} Entries</td>
                <td className="py-5 text-[0.9375rem]">{floatingIp.locationCity}</td>
                <td className="rounded-r-lg py-5 pr-4 text-right">
                  <ContextMenu
                    label={`Actions for ${floatingIp.name}`}
                    actions={[
                      { label: 'Rename', onSelect: () => undefined },
                      { label: 'Add labels', onSelect: () => undefined },
                      { label: 'Transfer to project', onSelect: () => undefined },
                      {
                        label: floatingIp.assignedTo ? 'Unassign' : 'Assign',
                        onSelect: () =>
                          floatingIp.assignedTo ? assignFloatingIp(floatingIp.id, null) : undefined,
                      },
                      { label: 'Enable protection', onSelect: () => undefined },
                      { label: 'Edit Reverse DNS', onSelect: () => undefined },
                      {
                        label: 'Delete',
                        destructive: true,
                        onSelect: () => deleteFloatingIp(floatingIp.id),
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {createDialog}

      <InfoModal
        open={configuring !== null}
        title="Configure Floating IP"
        onClose={() => setConfiguring(null)}
      >
        <p>
          The Floating IP has been successfully assigned. You now need to configure it on your
          server in order for it to work.
        </p>
        <p className="mt-5 text-[0.6875rem] uppercase tracking-wide text-text-muted">
          Command for temporary configuration
        </p>
        <div className="mt-2">
          <CodeBlock
            command={`sudo ip addr add ${configuring?.address.replace('/64', '::1') ?? ''} dev eth0`}
          />
        </div>
        <p className="mt-5">
          A temporary configuration will only work until the next reboot. To permanently configure
          the IP{' '}
          <a href="#" className="text-primary hover:underline">
            have a look at our Docs
          </a>
          .
        </p>
      </InfoModal>
    </div>
  );
}
