/**
 * Console state.
 *
 * Holds instances, the activity feed, disk images (snapshots and backups), and transient toasts.
 * On mount it tries the control API and falls back to local state when the backend is absent.
 *
 * Long-running work is modelled the way the control plane actually behaves: the resource appears
 * immediately in a pending state and converges in the background, rather than the caller blocking
 * until it exists. That applies to instance creation and to image creation alike.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  FLOATING_IP_PRICE_PER_MONTH,
  IPV4_PRICE_PER_MONTH,
  findFlavor,
  findLocation,
} from './catalog';
import { listInstances } from './api';
import type { Toast } from '../components/overlays';
import type { ActivityEntry, CreateInstanceInput, DiskImage, FloatingIp, Instance } from './types';

/** Milliseconds between simulated convergence ticks when no control API is attached. */
const PROVISION_TICK_MS = 900;
const PROVISION_STEP_PERCENT = 12;
const IMAGE_TICK_MS = 700;
const IMAGE_STEP_PERCENT = 9;
const TOAST_TTL_MS = 6000;

/** Fraction of a server's disk a fresh image typically occupies once compressed. */
const IMAGE_SIZE_RATIO = 0.021;

type ConsoleState = {
  readonly instances: readonly Instance[];
  readonly activities: readonly ActivityEntry[];
  readonly snapshots: readonly DiskImage[];
  readonly backups: readonly DiskImage[];
  readonly backupsEnabled: ReadonlySet<string>;
  readonly toasts: readonly Toast[];
  readonly createInstance: (input: CreateInstanceInput) => string;
  readonly setPower: (id: string, on: boolean) => void;
  readonly takeSnapshot: (instanceId: string, description: string) => void;
  readonly deleteSnapshot: (snapshotId: string) => void;
  readonly setBackups: (instanceId: string, enabled: boolean) => void;
  readonly runManualBackup: (instanceId: string) => void;
  readonly deleteBackup: (backupId: string) => void;
  readonly floatingIps: readonly FloatingIp[];
  readonly createFloatingIp: (input: {
    name: string;
    locationId: string;
    protocol: 'ipv4' | 'ipv6';
  }) => void;
  readonly assignFloatingIp: (floatingIpId: string, instanceId: string | null) => void;
  readonly deleteFloatingIp: (floatingIpId: string) => void;
};

const ConsoleContext = createContext<ConsoleState | null>(null);

/** Formats an ISO timestamp as the console's relative label. */
export function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'less than a minute ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Marks a finished record as settled and drops its progress field.
 *
 * WHY: the key is removed rather than set to `undefined` — under `exactOptionalPropertyTypes` an
 * absent optional property and one explicitly set to `undefined` are different types, and only
 * the former matches the target type.
 */
function settleInstance(instance: Instance): Instance {
  const next = { ...instance, status: 'running' as const };
  delete (next as { progressPercent?: number }).progressPercent;
  return next;
}

function settleImage(image: DiskImage): DiskImage {
  const next = { ...image, status: 'available' as const };
  delete (next as { progressPercent?: number }).progressPercent;
  return next;
}

/** Advances every pending image, settling those that reach 100%. */
function tickImages(images: readonly DiskImage[]): readonly DiskImage[] {
  return images.map((image) => {
    if (image.status !== 'creating') return image;
    const next = (image.progressPercent ?? 0) + IMAGE_STEP_PERCENT;
    return next < 100 ? { ...image, progressPercent: next } : settleImage(image);
  });
}

/** Deterministic pseudo-IPv4 so offline instances still render a plausible address. */
function syntheticIpv4(seed: number): string {
  return `62.238.${(seed * 37) % 256}.${(seed * 91) % 256}`;
}

const STORAGE_KEY = 'console-web:state:v1';

type PersistedState = {
  instances: readonly Instance[];
  snapshots: readonly DiskImage[];
  backups: readonly DiskImage[];
  backupsEnabled: readonly string[];
  floatingIps?: readonly FloatingIp[];
};

/** Builds a plausible address for a newly allocated floating IP. */
function syntheticFloatingAddress(protocol: 'ipv4' | 'ipv6', seed: number): string {
  return protocol === 'ipv4'
    ? `159.69.${(seed * 53) % 256}.${(seed * 17) % 256}`
    : `2a01:4f9:c01f:${(4096 + seed * 7).toString(16)}::/64`;
}

/**
 * Reads locally held console state.
 *
 * WHY this exists: without a control API the store is the only source of truth, and the server
 * console opens in a separate window. Keeping state in memory alone would make that window — and
 * any page reload — see an empty project. Persisting keeps the mock coherent across both.
 */
function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

function savePersisted(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode, quota). The console still works in memory.
  }
}

export function ConsoleProvider({ children }: { readonly children: ReactNode }) {
  const restored = useRef(loadPersisted());
  const [instances, setInstances] = useState<readonly Instance[]>(
    () => restored.current?.instances ?? [],
  );
  const [activities, setActivities] = useState<readonly ActivityEntry[]>([]);
  const [snapshots, setSnapshots] = useState<readonly DiskImage[]>(
    () => restored.current?.snapshots ?? [],
  );
  const [backups, setBackups] = useState<readonly DiskImage[]>(
    () => restored.current?.backups ?? [],
  );
  const [backupsEnabled, setBackupsEnabled] = useState<ReadonlySet<string>>(
    () => new Set(restored.current?.backupsEnabled ?? []),
  );
  const [floatingIps, setFloatingIps] = useState<readonly FloatingIp[]>(
    () => restored.current?.floatingIps ?? [],
  );
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  // Ids continue past whatever was restored so a reload cannot mint a duplicate.
  const counter = useRef(restored.current?.instances.length ?? 0);
  const floatingCounter = useRef(restored.current?.floatingIps?.length ?? 0);
  const imageCounter = useRef(
    425005488 + (restored.current?.snapshots.length ?? 0) + (restored.current?.backups.length ?? 0),
  );

  /** Mirrors durable console state into local storage on every change. */
  useEffect(() => {
    savePersisted({
      instances,
      snapshots,
      backups,
      backupsEnabled: [...backupsEnabled],
      floatingIps,
    });
  }, [instances, snapshots, backups, backupsEnabled, floatingIps]);

  useEffect(() => {
    let cancelled = false;
    void listInstances().then((live) => {
      if (!cancelled && live) setInstances(live);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pushToast = useCallback((message: string) => {
    const toast: Toast = { id: crypto.randomUUID(), message, scope: 'Test Project' };
    setToasts((prev) => [...prev, toast]);
    setTimeout(
      () => setToasts((prev) => prev.filter((item) => item.id !== toast.id)),
      TOAST_TTL_MS,
    );
  }, []);

  const pushActivity = useCallback(
    (message: string, state: ActivityEntry['state'] = 'succeeded') => {
      setActivities((prev) =>
        [{ id: crypto.randomUUID(), message, at: new Date().toISOString(), state }, ...prev].slice(
          0,
          40,
        ),
      );
    },
    [],
  );

  /** Advances every provisioning instance until it reaches 100% and flips to running. */
  useEffect(() => {
    if (!instances.some((instance) => instance.status === 'provisioning')) return undefined;
    const timer = setInterval(() => {
      setInstances((prev) =>
        prev.map((instance) => {
          if (instance.status !== 'provisioning') return instance;
          const next = (instance.progressPercent ?? 0) + PROVISION_STEP_PERCENT;
          return next < 100 ? { ...instance, progressPercent: next } : settleInstance(instance);
        }),
      );
    }, PROVISION_TICK_MS);
    return () => clearInterval(timer);
  }, [instances]);

  /** Advances every in-flight snapshot and backup. */
  useEffect(() => {
    const pending =
      snapshots.some((image) => image.status === 'creating') ||
      backups.some((image) => image.status === 'creating');
    if (!pending) return undefined;
    const timer = setInterval(() => {
      setSnapshots((prev) => tickImages(prev));
      setBackups((prev) => tickImages(prev));
    }, IMAGE_TICK_MS);
    return () => clearInterval(timer);
  }, [snapshots, backups]);

  /** Emits the activity trail as instances leave the provisioning state. */
  const previousStatuses = useRef(new Map<string, string>());
  useEffect(() => {
    for (const instance of instances) {
      if (
        previousStatuses.current.get(instance.id) === 'provisioning' &&
        instance.status === 'running'
      ) {
        pushActivity('Server started');
      }
      previousStatuses.current.set(instance.id, instance.status);
    }
  }, [instances, pushActivity]);

  const createInstance = useCallback(
    (input: CreateInstanceInput): string => {
      const id = String(163790818 + counter.current);
      counter.current += 1;
      const flavor = findFlavor(input.flavorId);
      const location = findLocation(input.locationId);

      const instance: Instance = {
        id,
        name: input.name,
        status: 'provisioning',
        progressPercent: 0,
        flavorId: flavor.id,
        flavorName: flavor.name,
        architecture: 'x86',
        diskGb: flavor.diskGb,
        vcpus: flavor.vcpus,
        memoryGb: flavor.memoryGb,
        imageName: `${input.imageId} ${input.imageVersion}`,
        locationId: location.id,
        locationCity: location.city,
        networkZone: location.networkZone,
        ipv4: input.useIpv4 ? syntheticIpv4(counter.current) : null,
        ipv6: input.useIpv6 ? '2a01:4f9:c013:eadf::/64' : null,
        pricePerMonth: flavor.pricePerMonth + (location.surchargePerMonth ?? 0),
        trafficUsedTb: 0,
        trafficIncludedTb: flavor.trafficTb,
        createdAt: new Date().toISOString(),
        labels: input.labels,
      };

      setInstances((prev) => [...prev, instance]);
      if (input.backups) setBackupsEnabled((prev) => new Set(prev).add(id));
      pushActivity('Primary IP is being assigned', 'running');
      pushActivity('Primary IP assigned');
      return id;
    },
    [pushActivity],
  );

  const setPower = useCallback(
    (id: string, on: boolean) => {
      setInstances((prev) =>
        prev.map((instance) =>
          instance.id === id ? { ...instance, status: on ? 'running' : 'off' } : instance,
        ),
      );
      pushActivity(on ? 'Server started' : 'Server powered off');
    },
    [pushActivity],
  );

  /** Builds a pending image record for the given instance. */
  const newImage = useCallback(
    (instanceId: string, description: string): DiskImage => {
      const instance = instances.find((candidate) => candidate.id === instanceId);
      imageCounter.current += 1;
      return {
        id: String(imageCounter.current),
        description,
        sizeGb: Number(((instance?.diskGb ?? 40) * IMAGE_SIZE_RATIO).toFixed(2)),
        createdAt: new Date().toISOString(),
        instanceId,
        status: 'creating',
        progressPercent: 0,
      };
    },
    [instances],
  );

  const takeSnapshot = useCallback(
    (instanceId: string, description: string) => {
      setSnapshots((prev) => [...prev, newImage(instanceId, description)]);
      pushActivity('Snapshot is being created', 'running');
      pushToast('Image is being created');
    },
    [newImage, pushActivity, pushToast],
  );

  const deleteSnapshot = useCallback((snapshotId: string) => {
    setSnapshots((prev) => prev.filter((snapshot) => snapshot.id !== snapshotId));
  }, []);

  const setBackupsFor = useCallback(
    (instanceId: string, enabled: boolean) => {
      setBackupsEnabled((prev) => {
        const next = new Set(prev);
        if (enabled) next.add(instanceId);
        else next.delete(instanceId);
        return next;
      });
      pushActivity(enabled ? 'Backups enabled' : 'Backups disabled');
      pushToast(enabled ? 'Backups enabled' : 'Backups disabled');
    },
    [pushActivity, pushToast],
  );

  const runManualBackup = useCallback(
    (instanceId: string) => {
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      setBackups((prev) => [...prev, newImage(instanceId, `Backup ${stamp}`)]);
      pushActivity('Backup is being created', 'running');
      pushToast('Image is being created');
    },
    [newImage, pushActivity, pushToast],
  );

  const deleteBackup = useCallback((backupId: string) => {
    setBackups((prev) => prev.filter((backup) => backup.id !== backupId));
  }, []);

  const createFloatingIp = useCallback(
    (input: { name: string; locationId: string; protocol: 'ipv4' | 'ipv6' }) => {
      floatingCounter.current += 1;
      const location = findLocation(input.locationId);
      setFloatingIps((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: input.name,
          address: syntheticFloatingAddress(input.protocol, floatingCounter.current),
          protocol: input.protocol,
          locationId: location.id,
          locationCity: location.city,
          networkZone: location.networkZone,
          assignedTo: null,
          reverseDnsEntries: 0,
          pricePerMonth: FLOATING_IP_PRICE_PER_MONTH[input.protocol],
        },
      ]);
      pushActivity('Floating IP created');
      pushToast('Floating IP created');
    },
    [pushActivity, pushToast],
  );

  const assignFloatingIp = useCallback(
    (floatingIpId: string, instanceId: string | null) => {
      setFloatingIps((prev) =>
        prev.map((ip) => (ip.id === floatingIpId ? { ...ip, assignedTo: instanceId } : ip)),
      );
      pushActivity(instanceId ? 'Floating IP is being assigned' : 'Floating IP unassigned');
      pushToast(instanceId ? 'Floating IP is being assigned' : 'Floating IP unassigned');
    },
    [pushActivity, pushToast],
  );

  const deleteFloatingIp = useCallback((floatingIpId: string) => {
    setFloatingIps((prev) => prev.filter((ip) => ip.id !== floatingIpId));
  }, []);

  const value = useMemo<ConsoleState>(
    () => ({
      instances,
      activities,
      snapshots,
      backups,
      backupsEnabled,
      toasts,
      createInstance,
      setPower,
      takeSnapshot,
      deleteSnapshot,
      setBackups: setBackupsFor,
      runManualBackup,
      deleteBackup,
      floatingIps,
      createFloatingIp,
      assignFloatingIp,
      deleteFloatingIp,
    }),
    [
      instances,
      activities,
      snapshots,
      backups,
      backupsEnabled,
      toasts,
      createInstance,
      setPower,
      takeSnapshot,
      deleteSnapshot,
      setBackupsFor,
      runManualBackup,
      deleteBackup,
      floatingIps,
      createFloatingIp,
      assignFloatingIp,
      deleteFloatingIp,
    ],
  );

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

/** Reads console state. Throws when used outside the provider, which is always a wiring bug. */
export function useConsole(): ConsoleState {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('useConsole must be used within a ConsoleProvider');
  return value;
}

export { IPV4_PRICE_PER_MONTH };
