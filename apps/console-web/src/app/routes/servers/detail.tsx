/**
 * Server detail.
 *
 * A header carrying identity and the power control, a tab bar across every management surface,
 * and per-tab panels. The overview combines the spec strip, the activity feed, quick options,
 * and location — the same four-panel arrangement the reference console uses.
 */
import { useState } from 'react';
import { Link, Navigate, Outlet, useNavigate, useParams } from 'react-router';
import {
  Callout,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  StatusDot,
  TabBar,
  TextField,
} from '../../components/primitives';
import type { TabItem } from '../../components/primitives';
import { Modal, ModalNote } from '../../components/overlays';
import { ImageTable } from '../../components/image-table';
import { SNAPSHOT_PRICE_PER_GB } from '../../data/catalog';
import {
  BackupIcon,
  BellIcon,
  CameraIcon,
  CpuIcon,
  EuroIcon,
  FirewallIcon,
  FloatingIpIcon,
  GearIcon,
  GlobeIcon,
  LoadBalancerIcon,
  LockIcon,
  MapPinIcon,
  MemoryIcon,
  ServerIcon,
  TerminalIcon,
  TrafficIcon,
  VolumeIcon,
} from '../../components/icons';
import { relativeTime, useConsole } from '../../data/store';
import { toDiskImage } from '../../data/view-model';
import type { Instance } from '../../data/types';

function serverTabs(id: string): readonly TabItem[] {
  return [
    { label: 'Overview', to: `/servers/${id}`, end: true },
    { label: 'Graphs', to: `/servers/${id}/graphs` },
    { label: 'Backups', to: `/servers/${id}/backups` },
    { label: 'Snapshots', to: `/servers/${id}/snapshots` },
    { label: 'Load Balancers', to: `/servers/${id}/load-balancers` },
    { label: 'Networking', to: `/servers/${id}/networking` },
    { label: 'Firewalls', to: `/servers/${id}/firewalls` },
    { label: 'Volumes', to: `/servers/${id}/volumes` },
    { label: 'Power', to: `/servers/${id}/power` },
    { label: 'Rescue', to: `/servers/${id}/rescue` },
    { label: 'ISO Images', to: `/servers/${id}/iso-images` },
    { label: 'Rescale', to: `/servers/${id}/rescale` },
    { label: 'Rebuild', to: `/servers/${id}/rebuild` },
    { label: 'Delete', to: `/servers/${id}/delete` },
  ];
}

/**
 * Resolves the instance for the current route.
 *
 * Returns `loading` as well as the instance, because the two absences mean different things and
 * conflating them was a real defect: the layout redirected to the list whenever this returned
 * null, and it returns null on the first render of *any* direct navigation — the query has not
 * answered yet. So pasting a link to a server, or reloading its page, bounced the user to the
 * list. A server that genuinely does not exist still redirects, which is the correct answer for
 * that case only.
 */
function useInstance(): { readonly instance: Instance | null; readonly loading: boolean } {
  const { id } = useParams();
  const { instances, loading } = useConsole();
  return { instance: instances.find((instance) => instance.id === id) ?? null, loading };
}

/** On/off switch mirroring the console's pill-shaped power toggle. */
function PowerToggle({ on, onToggle }: { readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`flex h-9 w-[4.5rem] items-center rounded px-2.5 text-xs font-bold tracking-wide text-white transition-colors ${
        on ? 'bg-status-green' : 'bg-[hsl(0_0%_72%)]'
      }`}
    >
      <span className={on ? '' : 'ml-auto'}>{on ? 'ON' : 'OFF'}</span>
      <span className={`flex gap-0.5 ${on ? 'ml-auto' : 'mr-auto order-first'}`}>
        <span className="block h-4 w-0.5 rounded bg-white/70" />
        <span className="block h-4 w-0.5 rounded bg-white/70" />
        <span className="block h-4 w-0.5 rounded bg-white/70" />
      </span>
    </button>
  );
}

export function ServerDetailLayout() {
  const { instance, loading } = useInstance();
  const { setPower } = useConsole();

  // Nothing rather than a spinner: the list is usually already cached, so this is a frame or two.
  if (loading) return null;
  if (!instance) return <Navigate to="/servers" replace />;

  return (
    <div className="px-8 py-6">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div>
          <div className="flex items-center gap-5">
            <h1 className="text-[2.5rem] font-semibold leading-none text-text">
              {instance.flavorName}
            </h1>
            <span className="flex items-center gap-2.5">
              <StatusDot state={instance.status === 'provisioning' ? 'pending' : instance.status} />
              <span className="text-[1.75rem] text-text">{instance.name}</span>
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-6 gap-y-2 pl-1 text-[0.9375rem]">
            <span className="text-sm text-text-muted">#{instance.id}</span>
            {instance.ipv4 ? (
              <span className="flex items-center gap-2 text-text">
                <GlobeIcon size={16} className="text-text-muted" />
                {instance.ipv4}
              </span>
            ) : null}
            {instance.ipv6 ? (
              <span className="flex items-center gap-2 text-text">
                <GlobeIcon size={16} className="text-text-muted" />
                {instance.ipv6}
              </span>
            ) : null}
            {/* The lease state matters: a quarantined address is held back after a failed
                release and is not usable, which looks identical to an active one unless said. */}
            {instance.ipv4State && instance.ipv4State !== 'active' ? (
              <Badge tone="orange">Address {instance.ipv4State}</Badge>
            ) : null}
            <Link
              to="/floating-ips"
              className="flex items-center gap-2 text-text-disabled hover:underline"
            >
              <FloatingIpIcon size={16} />
              Floating IPs
            </Link>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            aria-label="Protection"
            className="flex size-9 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover"
          >
            <LockIcon size={18} />
          </button>
          {/* Opens in its own window, matching how the reference console launches it. */}
          <a
            href={`/console/${instance.id}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open server console"
            className="flex size-9 items-center justify-center rounded bg-console-dark text-white transition-colors hover:opacity-90"
          >
            <TerminalIcon size={18} />
          </a>
          <Button variant="secondary" className="gap-2">
            Actions
            <span className="text-xs">▾</span>
          </Button>
          {/* `shutdown` rather than `stop`: the contract keeps them distinct on purpose —
              `shutdown` asks the guest to stop itself, `stop` cuts power and can lose unflushed
              writes. A single toggle must take the safe one; the Power tab offers both. */}
          <PowerToggle
            on={instance.status === 'running'}
            onToggle={() =>
              void setPower(instance.id, instance.status === 'running' ? 'shutdown' : 'start')
            }
          />
        </div>
      </div>

      <TabBar items={serverTabs(instance.id)} className="mt-6 border-b border-border" />
      <div className="pt-6">
        <Outlet />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

function Stat({
  icon,
  value,
  suffix,
  label,
}: {
  readonly icon: React.ReactNode;
  readonly value: string;
  readonly suffix?: string;
  readonly label: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="flex items-baseline gap-2.5">
        <span className="self-center text-primary">{icon}</span>
        <span className="text-[1.625rem] font-medium leading-none text-text">{value}</span>
        {suffix ? <span className="text-sm text-text-muted">{suffix}</span> : null}
      </span>
      <span className="mt-2 pl-[1.625rem] text-[0.6875rem] uppercase tracking-wide text-text-muted">
        {label}
      </span>
    </div>
  );
}

/**
 * A stat's label, saying so when the provider reported something different from what was asked.
 *
 * WHY surface this at all rather than showing one number: desired and observed disagreeing is
 * exactly what the reconciler exists to detect, and a console that displays only the desired value
 * tells a user their server is the size they ordered when the hypervisor disagrees.
 *
 * @param label The base label.
 * @param desired What was requested.
 * @param observed What the provider reported, or null when it reported nothing.
 * @returns The label, with a drift note appended when the two differ.
 */
function observedLabel(label: string, desired: number | null, observed: number | null): string {
  if (observed === null || desired === null || observed === desired) return label;
  return `${label} · provider reports ${observed}`;
}

export function ServerOverview() {
  const { instance } = useInstance();
  const { activities } = useConsole();
  if (!instance) return null;

  /** The activity feed, narrowed to this server. The API has no per-instance operation filter. */
  const ownActivities = activities.filter((entry) => entry.targetId === instance.id);

  return (
    <div className="space-y-5">
      <Card className="py-7">
        <div className="flex flex-wrap gap-x-14 gap-y-6">
          {/* Requested sizing, with what the provider reported beneath it when the two differ.
              A disagreement here is drift — the reconciler's whole subject — and a strip showing
              only one of the pair cannot express it. Traffic accounting used to sit in this row
              and always read 0.000 TB, because nothing in the control plane measures it. */}
          <Stat
            icon={<CpuIcon size={20} />}
            value={instance.vcpus === null ? '—' : String(instance.vcpus)}
            label={observedLabel('vCPU', instance.vcpus, instance.observedVcpus)}
          />
          <Stat
            icon={<MemoryIcon size={20} />}
            value={instance.memoryGb === null ? '—' : `${instance.memoryGb} GB`}
            label={observedLabel('RAM', instance.memoryGb, instance.observedMemoryGb)}
          />
          <Stat
            icon={<VolumeIcon size={20} />}
            value={instance.diskGb === null ? '—' : `${instance.diskGb} GB`}
            label={observedLabel('Disk local', instance.diskGb, instance.observedDiskGb)}
          />
          <Stat
            icon={<EuroIcon size={20} />}
            value={instance.pricePerMonth.toFixed(2)}
            suffix="/mo"
            label="Price"
          />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle icon={<BellIcon size={18} />}>ACTIVITIES</CardTitle>
            <button type="button" className="mb-5 text-sm text-primary hover:underline">
              View all ›
            </button>
          </div>
          {activities.length === 0 ? (
            <p className="text-[0.9375rem] text-text-muted">No activity recorded yet.</p>
          ) : (
            <ul className="-mx-4">
              {ownActivities.slice(0, 5).map((entry, index) => (
                <li
                  key={entry.id}
                  className={`flex items-center gap-4 px-4 py-3.5 ${index % 2 === 1 ? 'bg-table-even' : ''}`}
                >
                  <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-[hsl(0_0%_93%)] text-text-muted">
                    <ServerIcon size={16} />
                    {/* Outcome marker sits on the icon, as in the reference activity feed. */}
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border-2 border-surface ${
                        entry.state === 'failed'
                          ? 'bg-status-red'
                          : entry.state === 'running'
                            ? 'bg-status-orange'
                            : 'bg-status-green'
                      }`}
                    />
                  </span>
                  <span className="text-[0.9375rem] text-text">{entry.message}</span>
                  <span className="ml-auto whitespace-nowrap text-sm text-text-muted">
                    {relativeTime(entry.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          <Card>
            <CardTitle icon={<GearIcon size={18} />}>OPTIONS</CardTitle>
            <p className="-mt-2 mb-5 text-sm text-text-muted">
              These three are on the roadmap. Snapshots, power, rescale and delete all work today
              and are on their own tabs.
            </p>
            <div className="flex flex-wrap gap-8">
              <div className="flex flex-col items-start gap-2">
                <span className="flex items-center gap-3">
                  <BackupIcon size={20} className="text-text-disabled" />
                  <Button size="sm" disabled>
                    Enable
                  </Button>
                </span>
                <span className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Backups
                </span>
              </div>
              <div className="flex flex-col items-start gap-2">
                <span className="flex items-center gap-3">
                  <FirewallIcon size={20} className="text-text-disabled" />
                  <Button size="sm" disabled>
                    Select group
                  </Button>
                </span>
                <span className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Placement group
                </span>
              </div>
              <div className="flex flex-col items-start gap-2">
                <span className="flex items-center gap-3">
                  <GlobeIcon size={20} className="text-text-disabled" />
                  <Button size="sm" disabled>
                    Disable
                  </Button>
                </span>
                <span className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Public network
                </span>
              </div>
            </div>
          </Card>

          <Card className="relative overflow-hidden">
            {/* Decorative only: the reference shows a silhouette of the server's country here. */}
            <GlobeIcon
              size={150}
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-6 right-2 text-[hsl(0_0%_91%)]"
            />
            {/* NETWORK, not LOCATION. There are no regions, zones or cities in this control
                plane — `control.networks` describes one pre-existing bridge, and the previous
                version derived a city and a continent from the network's identifier. */}
            <CardTitle icon={<MapPinIcon size={18} />}>NETWORK</CardTitle>
            <dl className="relative grid grid-cols-2 gap-y-5 text-[0.9375rem]">
              <div>
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Network
                </dt>
                <dd className="mt-1">{instance.networkName}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Address
                </dt>
                <dd className="mt-1">{instance.ipv4 ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-muted">Lease</dt>
                <dd className="mt-1 capitalize">{instance.ipv4State ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-muted">Image</dt>
                <dd className="mt-1">{instance.imageName}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-tab panels                                                             */
/* -------------------------------------------------------------------------- */

/** Shared shell for the informational tabs: a titled card with copy and one action. */
function InfoPanel({
  title,
  lines,
  action,
}: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly action?: React.ReactNode;
}) {
  return (
    <Card>
      <h2 className="text-sm font-bold tracking-wide text-text">{title}</h2>
      <div className="mt-5 space-y-2.5 text-[0.9375rem] leading-6 text-text">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {action ? <div className="mt-6">{action}</div> : null}
    </Card>
  );
}

/**
 * Automatic backups — on the roadmap.
 *
 * This tab previously maintained a full set of backups in `localStorage`, complete with a
 * seven-slot rotation, a manual-run button and a recurring-charge confirmation. None of it
 * reached the control plane, which has no backup entity, no scheduler and no rotation — only
 * `control.snapshots`, which is a different thing taken on demand.
 */
export function ServerBackups() {
  const { instance } = useInstance();
  if (!instance) return null;

  return (
    <div className="space-y-5">
      <InfoPanel
        title="BACKUPS"
        lines={[
          'Backups are scheduled copies of a server\u2019s disks, kept on a rotation so an older state can be restored.',
          'This is not implemented yet. The control plane has no backup schedule and no rotation.',
          'Snapshots, on the next tab, are available today: they are taken on demand, outlive the server, and can be rolled back.',
        ]}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="orange">On the roadmap</Badge>
            <Button disabled>Enable Backups</Button>
          </div>
        }
      />
    </div>
  );
}

/**
 * Snapshots — real, and the whole lifecycle.
 *
 * Create, list, roll back and delete all reach the control plane. They work on this deployment
 * because the clone template's disk is qcow2: Proxmox refuses to snapshot a `raw` disk, a full
 * clone inherits its template's format, and the provider reports the capability from that format
 * rather than claiming it unconditionally.
 */
export function ServerSnapshots() {
  const { instance } = useInstance();
  const { useSnapshots, takeSnapshot, rollbackSnapshot, deleteSnapshot } = useConsole();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const [name, setName] = useState('');
  const { snapshots } = useSnapshots(instance?.id ?? '');
  if (!instance) return null;

  const mine = snapshots.map(toDiskImage);
  const busy = mine.some((snapshot) => snapshot.status === 'creating');

  /** Pre-fills the name with `<server>-<unix seconds>`, which is unique and sorts usefully. */
  function openDialog() {
    setName(`${instance?.name ?? 'snapshot'}-${Math.floor(Date.now() / 1000)}`);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-5">
      <InfoPanel
        title="SNAPSHOTS"
        lines={[
          'Snapshots are instant copies of your servers disks.',
          'You can create a new server from a snapshot and even transfer them to a different project.',
          'We recommend that you power off your server before taking a snapshot to ensure data consistency.',
          `Snapshots cost €${SNAPSHOT_PRICE_PER_GB}/GB/month (incl. 0 % VAT).`,
          mine.length === 0 ? "You currently don't have any snapshots for this server." : '',
        ].filter(Boolean)}
        action={
          <Button onClick={openDialog} disabled={busy}>
            Take snapshot
          </Button>
        }
      />

      {mine.length > 0 ? (
        <ImageTable
          images={mine}
          showId
          emptyMessage="You currently don't have any snapshots for this server."
          onDelete={(snapshotId) => void deleteSnapshot(instance.id, snapshotId)}
          onRollback={(snapshotId) => setRollbackTarget(snapshotId)}
        />
      ) : null}

      {/* Rollback is confirmed separately from deletion, because it is the destructive one of the
          pair from the guest's point of view: it discards everything written since the snapshot
          was taken. Deleting a snapshot loses the snapshot; rolling back loses the present. */}
      <Modal
        open={rollbackTarget !== null}
        title="Roll back to snapshot"
        confirmLabel="Roll back"
        onCancel={() => setRollbackTarget(null)}
        onConfirm={() => {
          if (rollbackTarget) void rollbackSnapshot(instance.id, rollbackTarget);
          setRollbackTarget(null);
        }}
      >
        <p>
          The server&apos;s disk returns to the state it was in when this snapshot was taken.
          Everything written since is discarded, and that cannot be undone.
        </p>
        <ModalNote>The server is stopped first if it is running.</ModalNote>
      </Modal>

      <Modal
        open={dialogOpen}
        title="Take snapshot"
        confirmLabel="Create &amp; Buy now"
        confirmDisabled={name.trim().length === 0}
        onCancel={() => setDialogOpen(false)}
        onConfirm={() => {
          void takeSnapshot(instance.id, name.trim());
          setDialogOpen(false);
        }}
      >
        <p>
          Take snapshot for €{SNAPSHOT_PRICE_PER_GB}/GB/month (incl. 0 % VAT). Our{' '}
          <a href="#" className="text-primary hover:underline">
            terms and conditions
          </a>{' '}
          apply.
        </p>
        <div className="relative mt-5">
          <TextField
            label="Name"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="border-primary pr-9"
          />
          {name ? (
            <button
              type="button"
              aria-label="Clear name"
              onClick={() => setName('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted transition-colors hover:text-text"
            >
              ×
            </button>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

export function ServerGraphs() {
  return (
    <EmptyState
      roadmap
      icon={<TrafficIcon size={72} />}
      title="No metrics collected yet."
      description="CPU, network, and disk graphs appear here once the server has been running long enough to report telemetry."
    />
  );
}

export function ServerLoadBalancers() {
  return (
    <EmptyState
      roadmap
      icon={<LoadBalancerIcon size={72} />}
      title="This server is not behind a load balancer."
      description="Attach the server to a load balancer to distribute incoming traffic across several targets."
      actionLabel="Attach load balancer"
      actionDisabled
    />
  );
}

/** Section heading used by the networking panels. */
function NetworkCardTitle({
  children,
  icon,
}: {
  readonly children: React.ReactNode;
  readonly icon?: React.ReactNode;
}) {
  return (
    <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold tracking-wide text-text">
      {children}
      {icon}
    </h2>
  );
}

/** Bordered table used inside the networking cards. */
function NetworkTable({
  headers,
  children,
}: {
  readonly headers: readonly string[];
  readonly children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="w-full min-w-[36rem] text-[0.9375rem]">
        <thead>
          <tr className="bg-table-head text-left text-[0.6875rem] uppercase tracking-wide text-text-muted">
            {headers.map((header) => (
              <th key={header} className="px-5 py-3 font-normal">
                {header}
              </th>
            ))}
            <th className="w-14 px-5 py-3" />
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/**
 * Networking.
 *
 * One card has real data behind it and the rest do not, so the rest say so. Previously all five
 * were populated: the private-network card offered an enabled "Create network" button for a
 * capability whose design document says *"DEFERRED — not scheduled, not being implemented"*, the
 * floating-IP card listed `localStorage` entries, the two traffic cards read a counter that was
 * always zero because nothing in the control plane measures traffic, and the reverse-DNS column
 * showed a PTR record synthesised from the address by string reversal, ending in a domain
 * belonging to another company.
 */
export function ServerNetworking() {
  const { instance } = useInstance();
  if (!instance) return null;

  return (
    <div className="space-y-5">
      <Card>
        <NetworkCardTitle icon={<GlobeIcon size={17} className="text-status-green" />}>
          PUBLIC NETWORK
        </NetworkCardTitle>
        <NetworkTable headers={['Primary IP', 'Protocol', 'Lease state']}>
          {instance.ipv4 ? (
            <tr className="border-t border-border">
              <td className="px-5 py-4">{instance.ipv4}</td>
              <td className="px-5 py-4">
                <Badge tone="plain">IPv4</Badge>
              </td>
              <td className="px-5 py-4">
                {/* The lease state, not a reverse-DNS record. There is no PTR management here,
                    and the column previously showed one built by reversing the octets. */}
                <Badge tone={instance.ipv4State === 'active' ? 'green' : 'orange'}>
                  {instance.ipv4State ?? 'unknown'}
                </Badge>
              </td>
            </tr>
          ) : (
            <tr className="border-t border-border">
              <td className="px-5 py-4 text-text-muted" colSpan={3}>
                No address is leased to this server yet.
              </td>
            </tr>
          )}
        </NetworkTable>
        <p className="mt-4 text-sm text-text-muted">
          One IPv4 address is leased from {instance.networkName} for the life of the server. It
          cannot be detached or moved.
        </p>
      </Card>

      <Card>
        <NetworkCardTitle>PRIVATE NETWORK</NetworkCardTitle>
        <div className="flex items-center gap-3">
          <Badge tone="orange">On the roadmap</Badge>
          <p className="text-[0.9375rem] text-text-muted">
            Tenant-defined private networks are designed but not implemented. Every server today
            attaches to the one operator-managed network shown above.
          </p>
        </div>
      </Card>

      <Card>
        <NetworkCardTitle>FLOATING IPS</NetworkCardTitle>
        <div className="flex items-center gap-3">
          <Badge tone="orange">On the roadmap</Badge>
          <p className="text-[0.9375rem] text-text-muted">
            An address that outlives the server it is attached to. Not available yet.
          </p>
        </div>
      </Card>

      <Card>
        <NetworkCardTitle>TRAFFIC</NetworkCardTitle>
        <div className="flex items-center gap-3">
          <Badge tone="orange">On the roadmap</Badge>
          <p className="text-[0.9375rem] text-text-muted">
            Traffic accounting is not measured. These two cards previously showed a fixed 0.000 TB
            against a 20 TB allowance, neither of which came from anywhere.
          </p>
        </div>
      </Card>
    </div>
  );
}

export function ServerFirewalls() {
  return (
    <EmptyState
      roadmap
      icon={<FirewallIcon size={72} />}
      title="No firewall applied."
      description="Firewalls restrict or allow traffic to this server based on rules. Create one in the Firewalls section, then apply it here."
      actionLabel="Apply firewall"
      actionDisabled
    />
  );
}

export function ServerVolumes() {
  return (
    <EmptyState
      roadmap
      icon={<VolumeIcon size={72} />}
      title="No volumes attached."
      description="Volumes are additional network-attached disks. Attach one to extend this server's storage without rebuilding it."
      actionLabel="Create Volume"
      actionDisabled
    />
  );
}

export function ServerPower() {
  const { instance } = useInstance();
  const { setPower } = useConsole();
  const [forceStop, setForceStop] = useState(false);
  if (!instance) return null;
  const on = instance.status === 'running';

  return (
    <>
      <InfoPanel
        title="POWER"
        lines={[
          'Shut down asks the operating system to stop itself, and takes as long as the guest needs.',
          'Force off cuts power immediately and can lose anything not yet written to disk.',
          'A powered-off server keeps its disk and its leased address.',
        ]}
        action={
          <div className="flex flex-wrap gap-3">
            {/* All four contract actions, kept distinct. `shutdown` asks the guest to stop itself
              and may take as long as it needs; `stop` cuts power and can lose unflushed writes.
              The contract keeps them separate rather than as one action with a force flag,
              precisely so a parameter default cannot destroy data — collapsing them here would
              undo that. */}
            {on ? (
              <>
                <Button onClick={() => void setPower(instance.id, 'shutdown')}>Shut down</Button>
                <Button variant="secondary" onClick={() => void setPower(instance.id, 'reboot')}>
                  Reboot
                </Button>
                <Button variant="secondary" onClick={() => setForceStop(true)}>
                  Force off
                </Button>
              </>
            ) : (
              <Button onClick={() => void setPower(instance.id, 'start')}>Power on</Button>
            )}
          </div>
        }
      />

      {/* Force off is confirmed because it is the one power action that can lose data. */}
      <Modal
        open={forceStop}
        title="Force off"
        confirmLabel="Force off"
        onCancel={() => setForceStop(false)}
        onConfirm={() => {
          void setPower(instance.id, 'stop');
          setForceStop(false);
        }}
      >
        <p>
          This cuts power immediately, without asking the operating system to stop. Anything not yet
          written to disk is lost. Use Shut down unless the server is unresponsive.
        </p>
      </Modal>
    </>
  );
}

export function ServerRescue() {
  return (
    <InfoPanel
      title="RESCUE"
      lines={[
        'Boot the server into a rescue system to repair a broken installation.',
        'The rescue system runs entirely in memory and leaves the disks untouched until you mount them.',
      ]}
      action={<Button variant="secondary">Enable rescue &amp; power cycle</Button>}
    />
  );
}

export function ServerIsoImages() {
  return (
    <EmptyState
      roadmap
      icon={<CameraIcon size={72} />}
      title="No ISO image mounted."
      description="Mount an ISO image to install an operating system manually or to boot a recovery environment."
      actionLabel="Mount ISO image"
      actionDisabled
    />
  );
}

/**
 * Rescale — real, with the disk guard enforced before the request is sent.
 *
 * SAFE-026: a disk can grow but never shrink. The API refuses one with `DISK_SHRINK_FORBIDDEN`
 * and bpg refuses it again at apply time, but refusing it here as well is what stops a user
 * choosing a smaller flavour, waiting, and being told no — and the control plane's own note on
 * this is worth respecting: a refused shrink still writes the rejected size into Terraform state.
 */
export function ServerRescale() {
  const { instance } = useInstance();
  const { flavors, resizeInstance } = useConsole();
  const [target, setTarget] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  if (!instance) return null;

  const chosen = flavors.find((flavor) => flavor.id === target);
  const currentDisk = instance.diskGb;
  const wouldShrink =
    chosen !== undefined && currentDisk !== null && chosen.minimumDiskGiB < currentDisk;

  return (
    <>
      <InfoPanel
        title="RESCALE"
        lines={[
          `This server runs as ${instance.flavorName}${
            instance.vcpus === null ? '' : ` with ${instance.vcpus} vCPU`
          }${instance.memoryGb === null ? '' : ` and ${instance.memoryGb} GB RAM`}.`,
          'Rescaling stops the server, changes it, and starts it again.',
          'The disk can only grow. A flavour with a smaller disk cannot be applied.',
        ]}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={target ?? ''}
              onChange={(event) => setTarget(event.target.value || null)}
              aria-label="New server type"
              className="h-10 rounded border border-form-border bg-input-bg px-3 text-[0.9375rem] text-text"
            >
              <option value="">Choose a new type…</option>
              {flavors
                .filter((flavor) => flavor.id !== instance.flavorId)
                .map((flavor) => (
                  <option key={flavor.id} value={flavor.id}>
                    {flavor.name} — {flavor.cpuCount} vCPU, {flavor.memoryMiB / 1024} GB RAM,{' '}
                    {flavor.minimumDiskGiB} GB disk
                  </option>
                ))}
            </select>
            <Button disabled={!chosen || wouldShrink} onClick={() => setConfirming(true)}>
              Rescale
            </Button>
          </div>
        }
      />

      {wouldShrink && chosen ? (
        <div className="mt-5">
          <Callout tone="error" title="That type has a smaller disk.">
            {chosen.name} offers {chosen.minimumDiskGiB} GB and this server already has{' '}
            {currentDisk} GB. A disk can grow but never shrink, so this change cannot be applied.
          </Callout>
        </div>
      ) : null}

      <Modal
        open={confirming}
        title="Rescale server"
        confirmLabel="Rescale"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          if (chosen) void resizeInstance(instance.id, chosen.id, chosen.minimumDiskGiB);
          setConfirming(false);
        }}
      >
        <p>
          The server is stopped, changed to {chosen?.name}, and started again. It will be
          unavailable while that happens.
        </p>
        <ModalNote>
          The disk grows to {chosen?.minimumDiskGiB} GB and cannot be reduced later.
        </ModalNote>
      </Modal>
    </>
  );
}

export function ServerRebuild() {
  return (
    <InfoPanel
      title="REBUILD"
      lines={[
        'Rebuilding replaces the server disk with a fresh copy of the selected image.',
        'All data on the disk is lost. Snapshots and volumes are not affected.',
      ]}
      action={<Button variant="secondary">Select an image</Button>}
    />
  );
}

/**
 * Delete — real, and a soft delete, which the copy has to say plainly.
 *
 * SAFE-028: normal delete detaches access and **retains** the provider resource for review. The
 * virtual machine is not destroyed. The only destroy is an administrative purge, which requires
 * both database ownership and matching live provider ownership markers (SAFE-006) and is not
 * exposed to a customer at all.
 *
 * Calling this "delete" while it retains the machine would be misleading in the other direction,
 * so the button says what happens rather than what the route is called.
 */
export function ServerDelete() {
  const { instance } = useInstance();
  const { retainInstance } = useConsole();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  if (!instance) return null;

  return (
    <>
      <InfoPanel
        title="DELETE"
        lines={[
          'Deleting this server detaches it and releases its leased address.',
          'The virtual machine itself is retained for a review period rather than destroyed, so a mistake can be recovered by an administrator.',
          'Snapshots are never removed as a side effect of deleting a server.',
        ]}
        action={
          <Button
            onClick={() => {
              setTyped('');
              setConfirming(true);
            }}
          >
            Delete server
          </Button>
        }
      />

      <Modal
        open={confirming}
        title="Delete server"
        confirmLabel="Delete server"
        confirmDisabled={typed.trim() !== instance.name}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          void retainInstance(instance.id).then(async (result) => {
            if (result.ok) await navigate('/servers');
          });
          setConfirming(false);
        }}
      >
        <p>
          {instance.name} will be detached and its address released. The virtual machine is retained
          for review and is not destroyed.
        </p>
        {/* Typing the hostname, because this is the only irreversible-feeling action a customer
            can take and a single click is too little friction for it. */}
        <div className="mt-5">
          <TextField
            label={`Type ${instance.name} to confirm`}
            required
            autoFocus
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <ModalNote>
          Permanently destroying a retained server is an administrative action and is not available
          here.
        </ModalNote>
      </Modal>
    </>
  );
}
