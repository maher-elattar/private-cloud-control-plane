/**
 * Who the browser is, and the gate in front of every other route.
 *
 * The session lives on the server. This provider asks `/auth/session` who the current user is and
 * caches the answer; it never holds an access token, because the console never receives one — the
 * browser's only credential is an opaque httpOnly cookie it cannot read.
 *
 * @see apps/console-bff/src/app/session.ts
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { configureProject, getSession, signIn, signOut, type Session } from './api';
import type { ApiResult } from './problem';

interface SessionState {
  readonly session: Session | null;
  readonly loading: boolean;
  readonly signIn: (credentials: {
    readonly username: string;
    readonly password: string;
  }) => Promise<ApiResult<Session>>;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const result = await getSession();
      // A 401 here is the normal unauthenticated state, not a failure worth retrying or logging.
      // Returning null rather than throwing keeps the "signed out" path off the error branch.
      return result.ok ? result.value : null;
    },
    // Re-checked on focus so a session that expired while the tab was in the background is
    // noticed when the user comes back, rather than at their next click.
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 30_000,
  });

  const session = query.data ?? null;

  // The API client is scoped per project, and the project comes from the session rather than from
  // a build-time constant. The predecessor read `VITE_PROJECT_ID` with a default of `'default'`,
  // which is not a project id anything would accept.
  if (session) configureProject(session.projectId);

  const value = useMemo<SessionState>(
    () => ({
      session,
      loading: query.isPending,
      signIn: async (credentials) => {
        const result = await signIn(credentials);
        if (result.ok) {
          configureProject(result.value.projectId);
          client.setQueryData(['session'], result.value);
          // Everything cached belonged to whoever was signed in before. Clearing rather than
          // refetching means no chance of the previous project's rows being shown to the new user.
          await client.invalidateQueries();
        }
        return result;
      },
      signOut: async () => {
        await signOut();
        client.setQueryData(['session'], null);
        client.clear();
      },
    }),
    [client, query.isPending, session],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used within a SessionProvider');
  return value;
}

/**
 * Wraps the routes that need a session.
 *
 * The intended path is remembered so that signing in returns the user to where they were going
 * rather than to a default page — which matters most for the case that produces it: a link shared
 * with someone whose session has expired.
 */
export function RequireSession({ children }: { readonly children: ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();

  if (loading) {
    // Deliberately blank rather than a spinner. The session check is a single local request and a
    // spinner that appears for 30ms reads as a flash of broken layout.
    return null;
  }
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/** The path a redirected sign-in should return to, if there was one. */
export function useIntendedPath(): string {
  const location = useLocation();
  const state = location.state as { from?: unknown } | null;
  return typeof state?.from === 'string' ? state.from : '/servers';
}

/** Re-exported so callers do not need the API module for a type. */
export type { Session };

/** Clears the client-side cache on sign-out. Exported for the tests. */
export function useClearCache(): () => void {
  const client = useQueryClient();
  return useCallback(() => client.clear(), [client]);
}
