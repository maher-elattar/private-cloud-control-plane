/**
 * Project-level Servers section: the tab bar shared by Servers, Snapshots, Backups, Placement
 * groups, and Primary IPs, plus the empty states for the tabs that have no resources yet.
 */
import { Outlet } from 'react-router';
import { TabBar } from '../../components/primitives';
import type { TabItem } from '../../components/primitives';
import { EmptyState } from '../../components/primitives';
import { BackupIcon, CameraIcon, FloatingIpIcon, PlacementGroupIcon } from '../../components/icons';
import { ImageTable } from '../../components/image-table';
import { useConsole } from '../../data/store';

const PROJECT_TABS: readonly TabItem[] = [
  { label: 'Servers', to: '/servers', end: true },
  { label: 'Snapshots', to: '/servers/snapshots' },
  { label: 'Backups', to: '/servers/backups' },
  { label: 'Placement groups', to: '/servers/placement-groups' },
  { label: 'Primary IPs', to: '/servers/primary-ips' },
];

export function ProjectLayout() {
  return (
    <div className="px-8 py-6">
      <TabBar items={PROJECT_TABS} className="border-b border-border" />
      <Outlet />
    </div>
  );
}

export function ProjectSnapshots() {
  const { allSnapshots, instances, deleteSnapshot } = useConsole();
  const snapshots = allSnapshots;

  if (snapshots.length === 0) {
    return (
      <EmptyState
        roadmap
        icon={<CameraIcon size={80} />}
        title="You haven't taken a snapshot yet."
        description="A snapshot is a full copy of your server's disk. Snapshots are not bound to the server and will be kept, even if the server is deleted. You can create new servers from a snapshot, or transfer it to another project."
        actionLabel="Take snapshot"
        actionDisabled={instances.length === 0}
        learnMoreHref="#"
      />
    );
  }

  return (
    <div className="mt-6">
      <ImageTable
        images={snapshots}
        showId
        emptyMessage="You haven't taken a snapshot yet."
        onDelete={(snapshotId) => {
          // `deleteSnapshot` is scoped to the instance that owns the snapshot, because that is how
          // the route is shaped. The project-wide table carries the owner on each row.
          const owner = snapshots.find((snapshot) => snapshot.id === snapshotId);
          if (owner) void deleteSnapshot(owner.instanceId, snapshotId);
        }}
      />
    </div>
  );
}

/**
 * Automatic backups — on the roadmap.
 *
 * Distinct from snapshots, which do exist: a backup is one of a rotating set of scheduled copies,
 * and the control plane has no scheduler, no rotation and no backup entity — only
 * `control.snapshots`. This page previously maintained a full set of backups in `localStorage`,
 * which made an unbuilt feature look finished.
 */
export function ProjectBackups() {
  {
    return (
      <EmptyState
        roadmap
        icon={<BackupIcon size={80} />}
        title="Automatic backups are not available yet."
        description="Backups are scheduled daily copies of a server's disk, kept on a rotation. Snapshots, which you can take on demand from a server's own page, are available today."
        actionLabel="Enable Backups"
        actionDisabled
      />
    );
  }
}

export function ProjectPlacementGroups() {
  return (
    <EmptyState
      roadmap
      icon={<PlacementGroupIcon size={72} />}
      title="You don't have any placement groups yet."
      description="Placement groups let you influence how your servers are distributed across physical hosts, so a single host failure cannot take all of them down at once."
      actionLabel="Create placement group"
      learnMoreHref="#"
    />
  );
}

export function ProjectPrimaryIps() {
  const { instances } = useConsole();
  const withIp = instances.filter((instance) => instance.ipv4);

  if (withIp.length === 0) {
    return (
      <EmptyState
        roadmap
        icon={<FloatingIpIcon size={72} />}
        title="You don't have any Primary IPs yet."
        description="Primary IPs are permanently assigned to a server and stay reserved for your project even while the server they belong to is rebuilt."
        actionLabel="Create Primary IP"
        learnMoreHref="#"
      />
    );
  }

  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full min-w-[40rem] text-[0.9375rem]">
        <thead>
          <tr className="text-left text-sm text-text-muted">
            <th className="pb-3 font-normal">IP address</th>
            <th className="pb-3 font-normal">Type</th>
            <th className="pb-3 font-normal">Assigned to</th>
            <th className="pb-3 font-normal">Location</th>
          </tr>
        </thead>
        <tbody>
          {withIp.map((instance) => (
            <tr key={instance.id} className="border-b border-border last:border-0">
              <td className="py-4 font-medium">{instance.ipv4}</td>
              <td className="py-4">IPv4</td>
              <td className="py-4 text-primary">{instance.name}</td>
              <td className="py-4">{instance.networkName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
