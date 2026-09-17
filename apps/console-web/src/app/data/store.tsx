/**
 * Console state.
 *
 * Everything the routes read comes from the control plane through TanStack Query. The only state
 * this file owns is the toast list, which is genuinely client-side.
 *
 * WHY this replaced a hand-rolled store: the previous version was 465 lines that simulated the
 * system rather than reading it — `setInterval` advanced a provisioning percentage by 12% every
 * 900ms, IP addresses were generated arithmetically from a counter, and the whole thing was
 * mirrored into `localStorage` under `console-web:state:v1`. It produced a convincing demonstration
 * of a control plane that was not running. Caching, retry, deduplication and background refresh
 * are the four things that store was slowly reimplementing, and they are what a query library is.
 *
 * **Polling is conditional on there being something to watch.** An instance with an active
 * operation, or an operation still running, means the server state is changing and the console
 * refetches; an idle project settles to no traffic at all. A fixed interval would hammer a real
 * Proxmox server for nothing.
 */
import {
  QueryClient,
  QueryClientProvider,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  actOnInstance,
  createInstance as createInstanceRequest,
  createSnapshot as createSnapshotRequest,
  currentProject,
  deleteSnapshot as deleteSnapshotRequest,
  getProject,
  getQuota,
  listFlavors,
  listImages,
  listInstances,
  listNetworks,
  listOperations,
  listSnapshots,
  retainInstance as retainInstanceRequest,
  rollbackSnapshot as rollbackSnapshotRequest,
  type ApiResult,
  type Flavor,
  type Image,
  type InstanceActionBody,
  type Network,
  type Operation,
  type Problem,
  type Project,
  type QuotaSet,
  type Snapshot,
} from './api';
import { problemMessage } from './problem';
import { toActivity, toDiskImage, toInstance } from './view-model';
import type { Toast } from '../components/overlays';
import type { ActivityEntry, CreateInstanceInput, DiskImage, Instance } from './types';

/** How long a toast stays on screen. */
const TOAST_TTL_MS = 6000;

/** Refetch cadence while something is converging. Matched to how fast operations actually move. */
const ACTIVE_POLL_MS = 2500;

/** How many operations the activity feed reads. The route filters this page client-side. */
const ACTIVITY_PAGE_SIZE = 50;

/**
 * Unwraps a result, throwing the problem so Query treats it as a failure.
 *
 * WHY throw here when the client deliberately returns results: those two shapes serve different
 * callers. A component asking "did this work" wants a value it can branch on; Query wants a
 * rejected promise so it can drive `isError`, retry and cache invalidation. Converting at this
 * one boundary keeps both honest.
 */
async function unwrap<T>(promise: Promise<ApiResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw result.problem;
  return result.value;
}

/** A single query client. Defaults chosen for a console watching a live system. */
function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data is refetched on focus because a console left open in a tab is the normal case and
        // stale instance state is the thing that misleads.
        refetchOnWindowFocus: true,
        staleTime: 5_000,
        // One retry, not three. Most failures here are problem documents that will answer
        // identically — a full quota, a denied project — and retrying those wastes a round trip
        // and delays the message the user needs to see.
        retry: (failureCount, error) => {
          const problem = error as unknown as Problem;
          const worthRetrying =
            problem?.code === 'DEPENDENCY_UNAVAILABLE' || problem?.status === 503;
          return worthRetrying && failureCount < 2;
        },
      },
    },
  });
}

type ConsoleState = {
  readonly project: Project | undefined;
  readonly quota: QuotaSet | undefined;
  readonly instances: readonly Instance[];
  readonly activities: readonly ActivityEntry[];
  readonly flavors: readonly Flavor[];
  readonly images: readonly Image[];
  readonly networks: readonly Network[];
  readonly operations: readonly Operation[];
  /** True until the first load of instances and the catalog has settled. */
  readonly loading: boolean;
  /** The problem that stopped the last load, if one did. Never a silent fallback to mock data. */
  readonly error: Problem | null;
  readonly toasts: readonly Toast[];
  readonly notify: (message: string) => void;

  readonly createInstance: (input: CreateInstanceInput) => Promise<ApiResult<string>>;
  readonly setPower: (
    instanceId: string,
    action: 'start' | 'shutdown' | 'stop' | 'reboot',
  ) => Promise<ApiResult<void>>;
  readonly resizeInstance: (
    instanceId: string,
    flavorId: string,
    diskGiB?: number,
  ) => Promise<ApiResult<void>>;
  readonly retainInstance: (instanceId: string) => Promise<ApiResult<void>>;
  readonly useSnapshots: (instanceId: string) => {
    readonly snapshots: readonly Snapshot[];
    readonly loading: boolean;
  };
  /**
   * Every snapshot in the project, flattened across instances.
   *
   * WHY this fans out rather than calling one endpoint: `listSnapshots` is scoped to an instance
   * and there is no project-wide snapshot route. With a three-instance quota the fan-out is three
   * requests, which is cheaper than adding an endpoint the contract does not have.
   */
  readonly allSnapshots: readonly DiskImage[];
  readonly takeSnapshot: (instanceId: string, name: string) => Promise<ApiResult<void>>;
  readonly rollbackSnapshot: (instanceId: string, snapshotId: string) => Promise<ApiResult<void>>;
  readonly deleteSnapshot: (instanceId: string, snapshotId: string) => Promise<ApiResult<void>>;
};

const ConsoleContext = createContext<ConsoleState | null>(null);

/** Formats an ISO timestamp as the console's relative label. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Everything a mutation can invalidate. Instances and operations always move together. */
const LIVE_KEYS = [['instances'], ['operations'], ['quota']] as const;

function ConsoleData({ children }: { readonly children: ReactNode }) {
  const client = useQueryClient();
  const projectId = currentProject();
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const notify = useCallback((message: string, scope = '') => {
    const toast: Toast = { id: crypto.randomUUID(), message, scope };
    setToasts((current) => [...current, toast]);
    setTimeout(
      () => setToasts((current) => current.filter((entry) => entry.id !== toast.id)),
      TOAST_TTL_MS,
    );
  }, []);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => unwrap(getProject()),
  });
  const quota = useQuery({ queryKey: ['quota', projectId], queryFn: () => unwrap(getQuota()) });
  const flavors = useQuery({
    queryKey: ['flavors', projectId],
    queryFn: () => unwrap(listFlavors({ limit: 100 })),
    // The catalog is operator-curated and changes rarely; refetching it every few seconds would
    // be pure noise.
    staleTime: 5 * 60_000,
  });
  const images = useQuery({
    queryKey: ['images', projectId],
    queryFn: () => unwrap(listImages({ limit: 100 })),
    staleTime: 5 * 60_000,
  });
  const networks = useQuery({
    queryKey: ['networks', projectId],
    queryFn: () => unwrap(listNetworks({ limit: 100 })),
    staleTime: 5 * 60_000,
  });

  const instances = useQuery({
    queryKey: ['instances', projectId],
    queryFn: () => unwrap(listInstances({ limit: 100 })),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((instance) => instance.activeOperationId)
        ? ACTIVE_POLL_MS
        : false,
  });

  const operations = useQuery({
    queryKey: ['operations', projectId],
    queryFn: () => unwrap(listOperations({ limit: ACTIVITY_PAGE_SIZE })),
    refetchInterval: (query) =>
      // The operation states that mean "still moving". `OperationState` has ten values and these
      // are the five that are not terminal — a list that must be spelled out, because polling on
      // `!== 'succeeded'` would poll forever on a failure.
      (query.state.data?.items ?? []).some((operation) =>
        ['accepted', 'queued', 'running', 'retry_wait', 'compensating'].includes(operation.state),
      )
        ? ACTIVE_POLL_MS
        : false,
  });

  // Snapshots for every instance, fanned out. `useQueries` keeps each instance's list in its own
  // cache entry, so a snapshot taken on one server does not invalidate another's.
  const snapshotQueries = useQueries({
    queries: (instances.data?.items ?? []).map((instance) => ({
      queryKey: ['snapshots', projectId, instance.id],
      queryFn: () => unwrap(listSnapshots(instance.id, { limit: 100 })),
    })),
  });

  const allSnapshots = useMemo(
    () =>
      snapshotQueries
        .flatMap((query) => query.data?.items ?? [])
        .map(toDiskImage)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [snapshotQueries],
  );

  /** Refetches everything a mutation could have changed. */
  const invalidateLive = useCallback(async () => {
    await Promise.all(LIVE_KEYS.map((key) => client.invalidateQueries({ queryKey: [...key] })));
  }, [client]);

  /**
   * Runs a mutation, refreshes what it touched, and reports the outcome as a toast.
   *
   * Every mutation on this API answers 202 with an operation rather than a finished result, so
   * "succeeded" here means accepted. The list's progress bar is what shows the rest.
   */
  const submit = useCallback(
    async <T,>(promise: Promise<ApiResult<T>>, accepted: string): Promise<ApiResult<T>> => {
      const result = await promise;
      if (result.ok) {
        notify(accepted);
        await invalidateLive();
      } else {
        notify(problemMessage(result.problem));
      }
      return result;
    },
    [invalidateLive, notify],
  );

  const mapped = useMemo(() => {
    const context = {
      flavors: flavors.data?.items ?? [],
      images: images.data?.items ?? [],
      networks: networks.data?.items ?? [],
      operations: operations.data?.items ?? [],
    };
    return (instances.data?.items ?? []).map((instance) => toInstance(instance, context));
  }, [instances.data, flavors.data, images.data, networks.data, operations.data]);

  const activities = useMemo(
    () => (operations.data?.items ?? []).map(toActivity),
    [operations.data],
  );

  const useSnapshots = useCallback(
    (instanceId: string) => {
      // A hook returned from context, so a route can ask for one instance's snapshots without the
      // provider fetching every instance's up front.
      const query = useQuery({
        queryKey: ['snapshots', projectId, instanceId],
        queryFn: () => unwrap(listSnapshots(instanceId, { limit: 100 })),
        enabled: Boolean(instanceId),
        refetchInterval: (inner) =>
          (inner.state.data?.items ?? []).some(
            (snapshot) => snapshot.state === 'creating' || snapshot.state === 'deleting',
          )
            ? ACTIVE_POLL_MS
            : false,
      });
      return { snapshots: query.data?.items ?? [], loading: query.isPending };
    },
    [projectId],
  );

  const value = useMemo<ConsoleState>(
    () => ({
      project: project.data,
      quota: quota.data,
      instances: mapped,
      activities,
      flavors: flavors.data?.items ?? [],
      images: images.data?.items ?? [],
      networks: networks.data?.items ?? [],
      operations: operations.data?.items ?? [],
      loading: instances.isPending || flavors.isPending,
      error:
        (instances.error as unknown as Problem | null) ??
        (flavors.error as unknown as Problem | null) ??
        (project.error as unknown as Problem | null) ??
        null,
      toasts,
      notify,
      createInstance: async (input) => {
        const result = await submit(
          createInstanceRequest({
            imageId: input.imageId,
            flavorId: input.flavorId,
            networkId: input.networkId,
            hostname: input.hostname,
            ...(input.sshPublicKeys.length > 0 ? { sshPublicKeys: [...input.sshPublicKeys] } : {}),
          }),
          'Server creation accepted.',
        );
        return result.ok ? { ok: true, value: result.value.targetId } : result;
      },
      setPower: async (instanceId, action) => {
        const result = await submit(
          actOnInstance(instanceId, { action } as InstanceActionBody),
          `${action} accepted.`,
        );
        return result.ok ? { ok: true, value: undefined } : result;
      },
      resizeInstance: async (instanceId, flavorId, diskGiB) => {
        const result = await submit(
          actOnInstance(instanceId, {
            action: 'resize',
            flavorId,
            ...(diskGiB === undefined ? {} : { diskGiB }),
          }),
          'Rescale accepted.',
        );
        return result.ok ? { ok: true, value: undefined } : result;
      },
      retainInstance: async (instanceId) => {
        const result = await submit(
          retainInstanceRequest(instanceId),
          'Delete accepted. The server is retained for review.',
        );
        return result.ok ? { ok: true, value: undefined } : result;
      },
      useSnapshots,
      allSnapshots,
      takeSnapshot: async (instanceId, name) => {
        const result = await submit(
          createSnapshotRequest(instanceId, { name }),
          'Snapshot accepted.',
        );
        if (result.ok) await client.invalidateQueries({ queryKey: ['snapshots'] });
        return result.ok ? { ok: true, value: undefined } : result;
      },
      rollbackSnapshot: async (instanceId, snapshotId) => {
        const result = await submit(
          rollbackSnapshotRequest(instanceId, snapshotId),
          'Rollback accepted.',
        );
        if (result.ok) await client.invalidateQueries({ queryKey: ['snapshots'] });
        return result.ok ? { ok: true, value: undefined } : result;
      },
      deleteSnapshot: async (instanceId, snapshotId) => {
        const result = await submit(
          deleteSnapshotRequest(instanceId, snapshotId),
          'Snapshot deletion accepted.',
        );
        if (result.ok) await client.invalidateQueries({ queryKey: ['snapshots'] });
        return result.ok ? { ok: true, value: undefined } : result;
      },
    }),
    [
      activities,
      client,
      flavors.data,
      flavors.error,
      flavors.isPending,
      images.data,
      instances.error,
      instances.isPending,
      mapped,
      networks.data,
      notify,
      operations.data,
      project.data,
      project.error,
      quota.data,
      submit,
      toasts,
      useSnapshots,
      allSnapshots,
    ],
  );

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

/** Wraps the app in a query client and the console's own state. */
export function ConsoleProvider({ children }: { readonly children: ReactNode }) {
  const [client] = useState(createClient);
  return (
    <QueryClientProvider client={client}>
      <ConsoleData>{children}</ConsoleData>
    </QueryClientProvider>
  );
}

export function useConsole(): ConsoleState {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('useConsole must be used within a ConsoleProvider');
  return value;
}
