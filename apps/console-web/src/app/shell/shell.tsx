/**
 * Application chrome: top bar, incident strip, navigation rail, and the routed content column.
 *
 * The page itself never scrolls — the content column owns its scrollbar so the top bar and nav
 * stay pinned, which is what keeps the order summary in the create wizard usable on short screens.
 */
import { Outlet } from 'react-router';
import { TopBar } from './top-bar';
import { IncidentsBar } from './incidents-bar';
import type { IncidentSummary } from './incidents-bar';
import { MainNav } from './main-nav';
import { ToastStack } from '../components/overlays';
import { useConsole } from '../data/store';

const INCIDENTS: IncidentSummary = {
  outage: 1,
  maintenance: 1,
  other: 2,
  lastUpdated: '1 day ago',
};

export function Shell() {
  const { activities, toasts } = useConsole();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar projectName="Test Project" activityCount={activities.length} />
      <IncidentsBar summary={INCIDENTS} />
      <div className="flex min-h-0 flex-1">
        <MainNav />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <ToastStack toasts={toasts} />
    </div>
  );
}
