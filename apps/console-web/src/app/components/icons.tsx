/**
 * Icon set.
 *
 * The console draws every icon from an inline SVG sprite at `--hc-icon-size: 16px`, stroked
 * rather than filled. These reproduce the shapes used across the navigation, stat strip, and
 * empty states at the same weight so the visual rhythm matches.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

/** Shared wrapper: 24-unit viewBox, 1.5 stroke, rounded caps — the console's icon weight. */
function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function ServerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <rect x="3" y="10" width="18" height="5" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
      <circle cx="6.5" cy="6.5" r=".6" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".6" fill="currentColor" />
      <circle cx="6.5" cy="18" r=".6" fill="currentColor" />
    </Icon>
  );
}

export function DashboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9.5h13V10" />
    </Icon>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3 21 8v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </Icon>
  );
}

export function FloatingIpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 13a4 4 0 0 1 1-7.9 5 5 0 0 1 9.6-.6A4 4 0 0 1 19 13" />
      <path d="M8 17h8M9.5 20.5h5" />
    </Icon>
  );
}

export function FirewallIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <rect x="3" y="9" width="18" height="5" rx="1" />
      <rect x="3" y="14" width="18" height="5" rx="1" />
      <path d="M9 4v5M15 9v5M9 14v5" />
    </Icon>
  );
}

export function LoadBalancerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 7v4M5 17v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2" />
    </Icon>
  );
}

export function NetworkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 6h18M8 6v4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6" />
      <path d="M12 12v6" />
      <rect x="9" y="18" width="6" height="3" rx="1" />
    </Icon>
  );
}

export function DnsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
    </Icon>
  );
}

export function ObjectStorageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h16l-1.5 13.5a1.5 1.5 0 0 1-1.5 1.3H7a1.5 1.5 0 0 1-1.5-1.3z" />
      <path d="M3 3h18v3H3z" />
    </Icon>
  );
}

export function StorageBoxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="6" rx="1" />
      <rect x="3" y="13" width="18" height="6" rx="1" />
      <path d="M7 8h.01M7 16h.01" />
    </Icon>
  );
}

export function SecurityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="12" r="3" />
      <path d="M11 12h10M18 12v3M15 12v2" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M13.7 20a2 2 0 0 1-3.4 0" />
    </Icon>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2}>
      {[4, 11, 18].map((y) =>
        [4, 11, 18].map((x) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill="currentColor" />
        )),
      )}
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2.5}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </Icon>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 7 5 5-5 5M12 17h7" />
    </Icon>
  );
}

export function CpuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </Icon>
  );
}

export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8.5 12 4l8 4.5-8 4.5z" />
      <path d="M4 8.5v7L12 20l8-4.5v-7" />
    </Icon>
  );
}

export function EuroIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16.5 6.5a6 6 0 1 0 0 11" />
      <path d="M4.5 10.5h8M4.5 13.5h8" />
    </Icon>
  );
}

export function TrafficIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 20V9M7 9 4 12M7 9l3 3" />
      <path d="M17 4v11M17 15l3-3M17 15l-3-3" />
    </Icon>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8h3.5l1.5-2.5h8L17.5 8H21v11H3z" />
      <circle cx="12" cy="13" r="3.5" />
    </Icon>
  );
}

export function BackupIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12a8 8 0 1 0 2.5-5.8" />
      <path d="M4 4v4h4" />
      <path d="M12 8v4.5l3 1.8" />
    </Icon>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </Icon>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Icon>
  );
}

export function DotsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </Icon>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
  );
}

export function MapPinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </Icon>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2" />
    </Icon>
  );
}

export function PlacementGroupIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </Icon>
  );
}
