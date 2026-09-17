/**
 * Route table.
 *
 * Project-level tabs live under `/servers`, and each server owns a nested set of management tabs
 * under `/servers/:id`.
 *
 * Two routes sit outside the shell: the server console, which is launched into its own window, and
 * sign-in, which has no project to render a navigation rail for. Everything else is behind
 * `RequireSession`, which remembers where the user was going so a shared link survives an expired
 * session.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ConsoleProvider } from './data/store';
import { RequireSession, SessionProvider } from './data/session';
import { Login } from './routes/login';
import { Shell } from './shell/shell';
import { ServerList } from './routes/servers/list';
import { CreateServer } from './routes/servers/create';
import { VncConsole } from './routes/servers/vnc-console';
import {
  ProjectBackups,
  ProjectLayout,
  ProjectPlacementGroups,
  ProjectPrimaryIps,
  ProjectSnapshots,
} from './routes/servers/project-layout';
import {
  ServerBackups,
  ServerDelete,
  ServerDetailLayout,
  ServerFirewalls,
  ServerGraphs,
  ServerIsoImages,
  ServerLoadBalancers,
  ServerNetworking,
  ServerOverview,
  ServerPower,
  ServerRebuild,
  ServerRescale,
  ServerRescue,
  ServerSnapshots,
  ServerVolumes,
} from './routes/servers/detail';
import { FloatingIps } from './routes/floating-ips';
import {
  Dashboard,
  Dns,
  Firewalls,
  LoadBalancers,
  Networks,
  NotFound,
  ObjectStorage,
  Security,
  StorageBoxes,
  Volumes,
} from './routes/sections';

export function App() {
  return (
    // The query client wraps the session provider, because the session is itself a query — and
    // the session provider wraps the router, because the route guard reads it.
    <ConsoleProvider>
      <BrowserRouter>
        <SessionProvider>
          <Routes>
            <Route path="login" element={<Login />} />

            {/* Launched into its own window, so it sits outside the application shell. */}
            <Route
              path="console/:id"
              element={
                <RequireSession>
                  <VncConsole />
                </RequireSession>
              }
            />

            <Route
              element={
                <RequireSession>
                  <Shell />
                </RequireSession>
              }
            >
              <Route index element={<Navigate to="/servers" replace />} />
              <Route path="dashboard" element={<Dashboard />} />

              {/* The create wizard sits outside the tabbed project layout. */}
              <Route path="servers/create" element={<CreateServer />} />

              <Route path="servers" element={<ProjectLayout />}>
                <Route index element={<ServerList />} />
                <Route path="snapshots" element={<ProjectSnapshots />} />
                <Route path="backups" element={<ProjectBackups />} />
                <Route path="placement-groups" element={<ProjectPlacementGroups />} />
                <Route path="primary-ips" element={<ProjectPrimaryIps />} />
              </Route>

              <Route path="servers/:id" element={<ServerDetailLayout />}>
                <Route index element={<ServerOverview />} />
                <Route path="graphs" element={<ServerGraphs />} />
                <Route path="backups" element={<ServerBackups />} />
                <Route path="snapshots" element={<ServerSnapshots />} />
                <Route path="load-balancers" element={<ServerLoadBalancers />} />
                <Route path="networking" element={<ServerNetworking />} />
                <Route path="firewalls" element={<ServerFirewalls />} />
                <Route path="volumes" element={<ServerVolumes />} />
                <Route path="power" element={<ServerPower />} />
                <Route path="rescue" element={<ServerRescue />} />
                <Route path="iso-images" element={<ServerIsoImages />} />
                <Route path="rescale" element={<ServerRescale />} />
                <Route path="rebuild" element={<ServerRebuild />} />
                <Route path="delete" element={<ServerDelete />} />
              </Route>

              <Route path="volumes" element={<Volumes />} />
              <Route path="floating-ips" element={<FloatingIps />} />
              <Route path="firewalls" element={<Firewalls />} />
              <Route path="load-balancers" element={<LoadBalancers />} />
              <Route path="networks" element={<Networks />} />
              <Route path="dns" element={<Dns />} />
              <Route path="object-storage" element={<ObjectStorage />} />
              <Route path="storage-boxes" element={<StorageBoxes />} />
              <Route path="security" element={<Security />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </SessionProvider>
      </BrowserRouter>
    </ConsoleProvider>
  );
}
