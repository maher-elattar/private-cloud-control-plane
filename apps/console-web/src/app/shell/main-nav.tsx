/**
 * Left navigation rail.
 *
 * Fixed at `--main-nav-width-pinned` (14rem). Items are grouped under muted uppercase category
 * headings; the active item takes a grey fill with a 3px primary bar on its leading edge.
 */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import {
  ChevronDownIcon,
  DashboardIcon,
  DnsIcon,
  FirewallIcon,
  FloatingIpIcon,
  LoadBalancerIcon,
  NetworkIcon,
  ObjectStorageIcon,
  SecurityIcon,
  ServerIcon,
  StorageBoxIcon,
  VolumeIcon,
} from '../components/icons';

type NavEntry = { readonly label: string; readonly to: string; readonly icon: ReactNode };
type NavGroup = { readonly heading?: string; readonly entries: readonly NavEntry[] };

const NAV_GROUPS: readonly NavGroup[] = [
  { entries: [{ label: 'Dashboard', to: '/dashboard', icon: <DashboardIcon size={17} /> }] },
  {
    heading: 'Pinned',
    entries: [{ label: 'Servers', to: '/servers', icon: <ServerIcon size={17} /> }],
  },
  {
    heading: 'Cloud',
    entries: [
      { label: 'Servers', to: '/servers', icon: <ServerIcon size={17} /> },
      { label: 'Volumes', to: '/volumes', icon: <VolumeIcon size={17} /> },
      { label: 'Floating IPs', to: '/floating-ips', icon: <FloatingIpIcon size={17} /> },
      { label: 'Firewalls', to: '/firewalls', icon: <FirewallIcon size={17} /> },
    ],
  },
  {
    heading: 'Networking',
    entries: [
      { label: 'Load Balancers', to: '/load-balancers', icon: <LoadBalancerIcon size={17} /> },
      { label: 'Networks', to: '/networks', icon: <NetworkIcon size={17} /> },
      { label: 'DNS', to: '/dns', icon: <DnsIcon size={17} /> },
    ],
  },
  {
    heading: 'Storage',
    entries: [
      { label: 'Object Storage', to: '/object-storage', icon: <ObjectStorageIcon size={17} /> },
      { label: 'Storage Boxes', to: '/storage-boxes', icon: <StorageBoxIcon size={17} /> },
    ],
  },
  {
    entries: [{ label: 'Security', to: '/security', icon: <SecurityIcon size={17} /> }],
  },
];

function GroupHeading({ label }: { readonly label: string }) {
  return (
    <div className="flex items-center justify-between px-4 pb-2 pt-6">
      <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-text-disabled">
        {label}
      </span>
      <ChevronDownIcon size={14} className="text-text-disabled" />
    </div>
  );
}

export function MainNav() {
  return (
    <nav className="w-nav shrink-0 overflow-y-auto border-r border-border bg-surface pb-8 scrollbar-thin">
      {NAV_GROUPS.map((group, index) => (
        <div key={group.heading ?? `group-${index}`}>
          {group.heading ? <GroupHeading label={group.heading} /> : <div className="pt-4" />}
          {group.entries.map((entry) => (
            <NavLink
              key={`${group.heading ?? 'root'}-${entry.label}`}
              to={entry.to}
              className={({ isActive }) =>
                `relative flex items-center gap-3 py-2.5 pl-4 pr-3 text-[0.9375rem] transition-colors ${
                  isActive
                    ? 'bg-nav-active text-text before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary'
                    : 'text-text hover:bg-nav-hover'
                }`
              }
            >
              <span className="text-nav-icon">{entry.icon}</span>
              {entry.label}
            </NavLink>
          ))}
          {group.heading || index === 0 ? (
            <div className="mx-4 mt-4 border-b border-border" />
          ) : null}
        </div>
      ))}
    </nav>
  );
}
