/**
 * Server detail.
 *
 * A header carrying identity and the power control, a tab bar across every management surface,
 * and per-tab panels. The overview combines the spec strip, the activity feed, quick options,
 * and location — the same four-panel arrangement the reference console uses.
 */
import { useState } from 'react';
import { Link, Navigate, Outlet, useParams } from 'react-router';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  DashedButton,
  EmptyState,
  ProgressBar,
  StatusDot,
  TabBar,
  TextField,
} from '../../components/primitives';
import { ContextMenu } from '../../components/menus';
import type { TabItem } from '../../components/primitives';
import { Modal, ModalNote, Spinner } from '../../components/overlays';
import { ImageTable } from '../../components/image-table';
import { BACKUP_PRICE_RATIO, SNAPSHOT_PRICE_PER_GB } from '../../data/catalog';
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
import type { Instance } from '../../data/types';

/** Formats a euro amount, symbol first, with the console's two-decimal convention. */
function euro(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

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

/** Resolves the instance for the current route, or null when the id is unknown. */
function useInstance(): Instance | null {
  const { id } = useParams();
  const { instances } = useConsole();
  return instances.find((instance) => instance.id === id) ?? null;
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
  const instance = useInstance();
  const { setPower, floatingIps } = useConsole();

  if (!instance) return <Navigate to="/servers" replace />;

  const attachedFloatingIps = floatingIps.filter((ip) => ip.assignedTo === instance.id);

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
            {attachedFloatingIps.map((ip) => (
              <span key={ip.id} className="flex items-center gap-2 text-text">
                <FloatingIpIcon size={16} className="text-text-muted" />
                {ip.address}
              </span>
            ))}
            <Link
              to="/floating-ips"
              className="flex items-center gap-2 text-primary hover:underline"
            >
              <FloatingIpIcon size={16} />
              Add Floating IP
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
          <PowerToggle
            on={instance.status === 'running'}
            onToggle={() => setPower(instance.id, instance.status !== 'running')}
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

export function ServerOverview() {
  const instance = useInstance();
  const { activities, backupsEnabled, setBackups } = useConsole();
  if (!instance) return null;

  const hasBackups = backupsEnabled.has(instance.id);

  return (
    <div className="space-y-5">
      <Card className="py-7">
        <div className="flex flex-wrap gap-x-14 gap-y-6">
          <Stat icon={<CpuIcon size={20} />} value={String(instance.vcpus)} label="vCPU" />
          <Stat icon={<MemoryIcon size={20} />} value={`${instance.memoryGb} GB`} label="RAM" />
          <Stat
            icon={<VolumeIcon size={20} />}
            value={`${instance.diskGb} GB`}
            label="Disk local"
          />
          <Stat
            icon={<EuroIcon size={20} />}
            value={instance.trafficUsedTb.toFixed(2)}
            label="Usage"
          />
          <Stat
            icon={<TrafficIcon size={20} />}
            value={`${instance.trafficUsedTb}/${instance.trafficIncludedTb} TB`}
            label="Traffic out"
          />
          <Stat
            icon={<EuroIcon size={20} />}
            value={instance.pricePerMonth.toFixed(2)}
            suffix="/mo"
            label="Price"
          />
        </div>
        <div className="mt-6">
          <DashedButton className="px-4 py-2 text-sm">Add labels</DashedButton>
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
              {activities.slice(0, 5).map((entry, index) => (
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
            <div className="flex flex-wrap gap-8">
              <div className="flex flex-col items-start gap-2">
                <span className="flex items-center gap-3">
                  <BackupIcon size={20} className="text-primary" />
                  <Button
                    size="sm"
                    variant={hasBackups ? 'secondary' : 'primary'}
                    onClick={() => setBackups(instance.id, !hasBackups)}
                  >
                    {hasBackups ? 'Disable' : 'Enable'}
                  </Button>
                </span>
                <span className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Backups
                </span>
              </div>
              <div className="flex flex-col items-start gap-2">
                <span className="flex items-center gap-3">
                  <FirewallIcon size={20} className="text-primary" />
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
                  <GlobeIcon size={20} className="text-primary" />
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
            <CardTitle icon={<MapPinIcon size={18} />}>LOCATION</CardTitle>
            <dl className="relative grid grid-cols-2 gap-y-5 text-[0.9375rem]">
              <div>
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Network zone
                </dt>
                <dd className="mt-1">{instance.networkZone}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-muted">City</dt>
                <dd className="mt-1">{instance.locationCity}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  Country
                </dt>
                <dd className="mt-1">
                  {instance.networkZone.startsWith('eu') ? 'Europe' : 'United States'}
                </dd>
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

export function ServerBackups() {
  const instance = useInstance();
  const { backups, backupsEnabled, setBackups, runManualBackup, deleteBackup } = useConsole();
  const [confirming, setConfirming] = useState(false);
  if (!instance) return null;

  const enabled = backupsEnabled.has(instance.id);
  const mine = backups.filter((backup) => backup.instanceId === instance.id);
  const busy = mine.some((backup) => backup.status === 'creating');
  const monthlyCost = instance.pricePerMonth * BACKUP_PRICE_RATIO;

  return (
    <div className="space-y-5">
      <InfoPanel
        title="BACKUPS"
        lines={[
          'Backups are automatic copies of your servers disks. For every server there are seven slots for backups.',
          'If all slots are full and an additional one is created, then the oldest backup will be deleted.',
          'We recommend that you power off your server before creating a backup to ensure data consistency on the disks.',
          'Enabling Backups for your server will cost 20 % of your server plan per month.',
        ]}
        action={
          enabled ? (
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => runManualBackup(instance.id)} disabled={busy}>
                {busy ? <Spinner /> : null}
                Run Manual Backup
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setBackups(instance.id, false)}
              >
                Disable Backups
              </Button>
            </div>
          ) : (
            <Button onClick={() => setConfirming(true)}>Enable Backups</Button>
          )
        }
      />

      {enabled ? (
        <ImageTable
          images={mine}
          emptyMessage="No backups were created from this server yet."
          onDelete={deleteBackup}
        />
      ) : null}

      <Modal
        open={confirming}
        title="Enable Backups"
        confirmLabel="Enable &amp; Buy now"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setBackups(instance.id, true);
          setConfirming(false);
        }}
      >
        <p>
          Enabling backups will be recurringly billed, for {BACKUP_PRICE_RATIO * 100} % per month of
          your current plan &mdash; {euro(monthlyCost)}/mo. Our{' '}
          <a href="#" className="text-primary hover:underline">
            terms and conditions
          </a>{' '}
          apply.
        </p>
        <ModalNote>Volumes are not included in backups.</ModalNote>
      </Modal>
    </div>
  );
}

export function ServerSnapshots() {
  const instance = useInstance();
  const { snapshots, takeSnapshot, deleteSnapshot } = useConsole();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [description, setDescription] = useState('');
  if (!instance) return null;

  const mine = snapshots.filter((snapshot) => snapshot.instanceId === instance.id);

  /** The console pre-fills the description with `<server>-<unix seconds>`. */
  function openDialog() {
    setDescription(`${instance?.name ?? 'snapshot'}-${Math.floor(Date.now() / 1000)}`);
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
        action={<Button onClick={openDialog}>Take snapshot</Button>}
      />

      {mine.length > 0 ? (
        <ImageTable
          images={mine}
          showId
          emptyMessage="You currently don't have any snapshots for this server."
          onDelete={deleteSnapshot}
        />
      ) : null}

      <Modal
        open={dialogOpen}
        title="Take snapshot"
        confirmLabel="Create &amp; Buy now"
        confirmDisabled={description.trim().length === 0}
        onCancel={() => setDialogOpen(false)}
        onConfirm={() => {
          takeSnapshot(instance.id, description.trim());
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
            label="Description"
            required
            autoFocus
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="border-primary pr-9"
          />
          {description ? (
            <button
              type="button"
              aria-label="Clear description"
              onClick={() => setDescription('')}
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
      icon={<TrafficIcon size={72} />}
      title="No metrics collected yet."
      description="CPU, network, and disk graphs appear here once the server has been running long enough to report telemetry."
    />
  );
}

export function ServerLoadBalancers() {
  return (
    <EmptyState
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

export function ServerNetworking() {
  const instance = useInstance();
  const { floatingIps } = useConsole();
  if (!instance) return null;

  const attached = floatingIps.filter((ip) => ip.assignedTo === instance.id);
  const trafficPercent = (instance.trafficUsedTb / instance.trafficIncludedTb) * 100;

  return (
    <div className="space-y-5">
      <Card>
        <NetworkCardTitle icon={<GlobeIcon size={17} className="text-status-green" />}>
          PUBLIC NETWORK
        </NetworkCardTitle>
        <NetworkTable headers={['Primary IP', 'Protocol', 'Reverse DNS']}>
          {instance.ipv4 ? (
            <tr className="border-t border-border">
              <td className="px-5 py-4">{instance.ipv4}</td>
              <td className="px-5 py-4">
                <Badge tone="plain">IPv4</Badge>
              </td>
              <td className="px-5 py-4">
                static.{instance.ipv4.split('.').reverse().join('.')}.clients.your-server.de
              </td>
              <td className="px-5 py-4 text-right">
                <ContextMenu
                  label="IPv4 actions"
                  actions={[{ label: 'Edit Reverse DNS', onSelect: () => undefined }]}
                />
              </td>
            </tr>
          ) : null}
          {instance.ipv6 ? (
            <tr className="border-t border-border">
              <td className="px-5 py-4">{instance.ipv6}</td>
              <td className="px-5 py-4">
                <Badge tone="plain">IPv6</Badge>
              </td>
              <td className="px-5 py-4">0 Entries</td>
              <td className="px-5 py-4 text-right">
                <ContextMenu
                  label="IPv6 actions"
                  actions={[{ label: 'Edit Reverse DNS', onSelect: () => undefined }]}
                />
              </td>
            </tr>
          ) : null}
        </NetworkTable>
        <Button className="mt-5" disabled>
          Disable public network
        </Button>
      </Card>

      <Card>
        <NetworkCardTitle>PRIVATE NETWORK</NetworkCardTitle>
        <p className="mb-5 text-[0.9375rem] leading-6 text-text">
          Private IPs identify your server in a network. Private networks allow your servers to talk
          to each other over a dedicated link.
        </p>
        <NetworkTable headers={['Private IP', 'Network']}>
          <tr className="border-t border-border">
            <td colSpan={3} className="px-5 py-6 text-center text-text-muted">
              There is no private IP assigned to this server.
            </td>
          </tr>
        </NetworkTable>
        <div className="mt-5 flex gap-3">
          <Button>Create network</Button>
          <Button disabled>Attach to network</Button>
        </div>
      </Card>

      <Card>
        <NetworkCardTitle>FLOATING IPS</NetworkCardTitle>
        <div className="mb-5 space-y-2.5 text-[0.9375rem] leading-6 text-text">
          <p>
            Floating IPs help you to create highly flexible setups. A Floating IP can be assigned
            and reassigned to any server at any time as long as they are in the same network zone.
          </p>
          <p>
            For optimal routing and latency, Floating IPs should be used in the location they were
            created in.
          </p>
          <p>
            Floating IPs need to be configured on your server in order to work. You can find a short
            example configuration in our{' '}
            <a href="#" className="text-primary hover:underline">
              Docs
            </a>
            .
          </p>
        </div>
        <NetworkTable headers={['Name', 'IP', 'Reverse DNS']}>
          {attached.length === 0 ? (
            <tr className="border-t border-border">
              <td colSpan={4} className="px-5 py-6 text-center text-text-muted">
                No Floating IP is assigned to this server.
              </td>
            </tr>
          ) : (
            attached.map((ip) => (
              <tr key={ip.id} className="border-t border-border">
                <td className="px-5 py-4">{ip.name}</td>
                <td className="px-5 py-4">{ip.address}</td>
                <td className="px-5 py-4">{ip.reverseDnsEntries} Entries</td>
                <td className="px-5 py-4 text-right">
                  <ContextMenu
                    label={`Actions for ${ip.name}`}
                    actions={[{ label: 'Unassign', onSelect: () => undefined }]}
                  />
                </td>
              </tr>
            ))
          )}
        </NetworkTable>
        <div className="mt-5 flex gap-3">
          <Link to="/floating-ips">
            <Button>Add Floating IP</Button>
          </Link>
          <Button disabled>Assign Floating IP</Button>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="flex items-baseline justify-between">
            <NetworkCardTitle>OUTGOING TRAFFIC</NetworkCardTitle>
            <span className="text-[0.9375rem] text-text-muted">
              {instance.trafficUsedTb.toFixed(3)} TB / {instance.trafficIncludedTb} TB
            </span>
          </div>
          <ProgressBar percent={trafficPercent} />
          <p className="mt-4 text-[0.9375rem] leading-6 text-text">
            If you exceed the included traffic, the cost for every commenced TB extra is €1.00
            (incl. 0 % VAT).
          </p>
        </Card>

        <Card>
          <div className="flex items-baseline justify-between">
            <NetworkCardTitle>INCOMING TRAFFIC</NetworkCardTitle>
            <span className="text-[0.9375rem] text-text-muted">0.000 TB</span>
          </div>
          <p className="text-[0.9375rem] leading-6 text-text">
            Any incoming traffic is free and does not cause additional charges.
          </p>
        </Card>
      </div>
    </div>
  );
}

export function ServerFirewalls() {
  return (
    <EmptyState
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
      icon={<VolumeIcon size={72} />}
      title="No volumes attached."
      description="Volumes are additional network-attached disks. Attach one to extend this server's storage without rebuilding it."
      actionLabel="Create Volume"
      actionDisabled
    />
  );
}

export function ServerPower() {
  const instance = useInstance();
  const { setPower } = useConsole();
  if (!instance) return null;
  const on = instance.status === 'running';

  return (
    <InfoPanel
      title="POWER"
      lines={[
        'Power the server on or off, or send an ACPI shutdown signal to the running operating system.',
        'A powered-off server keeps its disks and its Primary IP, and continues to be billed.',
      ]}
      action={
        <div className="flex gap-3">
          <Button onClick={() => setPower(instance.id, !on)}>
            {on ? 'Power off' : 'Power on'}
          </Button>
          <Button variant="secondary" disabled={!on}>
            Reboot
          </Button>
        </div>
      }
    />
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
      icon={<CameraIcon size={72} />}
      title="No ISO image mounted."
      description="Mount an ISO image to install an operating system manually or to boot a recovery environment."
      actionLabel="Mount ISO image"
      actionDisabled
    />
  );
}

export function ServerRescale() {
  const instance = useInstance();
  if (!instance) return null;

  return (
    <InfoPanel
      title="RESCALE"
      lines={[
        `This server currently runs as ${instance.flavorName} with ${instance.vcpus} vCPU and ${instance.memoryGb} GB RAM.`,
        'Rescaling requires a power cycle. Upgrading the disk is irreversible; CPU and RAM can be changed in both directions.',
      ]}
      action={<Button variant="secondary">Choose a new type</Button>}
    />
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

export function ServerDelete() {
  return (
    <InfoPanel
      title="DELETE"
      lines={[
        'Deleting a server releases its resources and stops billing at the end of the current hour.',
        'This console does not perform destructive actions automatically — deletion must be confirmed explicitly, and snapshots are never removed as a side effect.',
      ]}
      action={
        <Button variant="secondary" disabled>
          Delete server
        </Button>
      }
    />
  );
}
