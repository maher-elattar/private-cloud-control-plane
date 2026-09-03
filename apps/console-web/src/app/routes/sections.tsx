/**
 * Sections of the navigation that the control plane does not implement yet.
 *
 * Each renders the console's standard empty state so the shell is navigable end to end. They are
 * intentionally inert: there is no endpoint behind them in
 * `packages/contracts/openapi/control-plane.v1.yaml`, so offering an enabled action would promise
 * something the API cannot honour.
 */
import { Card, EmptyState } from '../components/primitives';
import {
  DnsIcon,
  FirewallIcon,
  LoadBalancerIcon,
  NetworkIcon,
  ObjectStorageIcon,
  SecurityIcon,
  ServerIcon,
  StorageBoxIcon,
  VolumeIcon,
} from '../components/icons';
import { useConsole } from '../data/store';

/** Wraps an empty state in the standard page padding. */
function Section({ children }: { readonly children: React.ReactNode }) {
  return <div className="px-8 py-6">{children}</div>;
}

export function Dashboard() {
  const { instances } = useConsole();
  const running = instances.filter((instance) => instance.status === 'running').length;
  const spend = instances.reduce((total, instance) => total + instance.pricePerMonth, 0);

  return (
    <Section>
      <h1 className="text-[2rem] font-semibold text-text">Dashboard</h1>
      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Servers', value: String(instances.length) },
          { label: 'Running', value: String(running) },
          {
            label: 'Provisioning',
            value: String(instances.filter((i) => i.status === 'provisioning').length),
          },
          { label: 'Monthly spend', value: `€${spend.toFixed(2)}` },
        ].map((stat) => (
          <Card key={stat.label}>
            <p className="text-[0.6875rem] uppercase tracking-wide text-text-muted">{stat.label}</p>
            <p className="mt-2 text-3xl font-medium text-text">{stat.value}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

export function Volumes() {
  return (
    <Section>
      <EmptyState
        icon={<VolumeIcon size={80} />}
        title="You don't have any volumes yet."
        description="Volumes are additional network-attached disks that can be moved between servers in the same location."
        actionLabel="Create Volume"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function Firewalls() {
  return (
    <Section>
      <EmptyState
        icon={<FirewallIcon size={80} />}
        title="You don't have any firewalls yet."
        description="Firewalls secure your servers by restricting or allowing traffic based on rules, and can be applied to several servers at once."
        actionLabel="Create Firewall"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function LoadBalancers() {
  return (
    <Section>
      <EmptyState
        icon={<LoadBalancerIcon size={80} />}
        title="You don't have any load balancers yet."
        description="Load balancers distribute incoming traffic across several servers and take unhealthy targets out of rotation automatically."
        actionLabel="Create Load Balancer"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function Networks() {
  return (
    <Section>
      <EmptyState
        icon={<NetworkIcon size={80} />}
        title="You don't have any networks yet."
        description="Private networks let your servers communicate over a dedicated link that never traverses the public internet."
        actionLabel="Create Network"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function Dns() {
  return (
    <Section>
      <EmptyState
        icon={<DnsIcon size={80} />}
        title="You don't have any DNS zones yet."
        description="Manage authoritative DNS records for your domains alongside the servers they point at."
        actionLabel="Add Zone"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function ObjectStorage() {
  return (
    <Section>
      <EmptyState
        icon={<ObjectStorageIcon size={80} />}
        title="You don't have any buckets yet."
        description="S3-compatible object storage for backups, static assets, and large media, billed per stored gigabyte."
        actionLabel="Create Bucket"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function StorageBoxes() {
  return (
    <Section>
      <EmptyState
        icon={<StorageBoxIcon size={80} />}
        title="You don't have any storage boxes yet."
        description="Storage Boxes offer large, inexpensive network storage reachable over SFTP, SMB, and WebDAV."
        actionLabel="Create Storage Box"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function Security() {
  return (
    <Section>
      <EmptyState
        icon={<SecurityIcon size={80} />}
        title="You haven't added an SSH key yet."
        description="SSH keys added here can be selected when creating a server, so no root password ever needs to be emailed."
        actionLabel="Add SSH key"
        actionDisabled
        learnMoreHref="#"
      />
    </Section>
  );
}

export function NotFound() {
  return (
    <Section>
      <EmptyState
        icon={<ServerIcon size={80} />}
        title="Page not found."
        description="The page you are looking for does not exist in this console."
      />
    </Section>
  );
}
