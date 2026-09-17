/**
 * Application chrome: top bar, navigation rail, and the routed content column.
 *
 * The page itself never scrolls — the content column owns its scrollbar so the top bar and nav
 * stay pinned, which is what keeps the order summary in the create wizard usable on short screens.
 *
 * The incident strip is gone. It reported a hardcoded `{outage: 1, maintenance: 1, other: 2}` and
 * "Last updated: 1 day ago" on every page load. There is no status endpoint behind it, and a
 * console that permanently claims an ongoing outage teaches its users to ignore the one place that
 * would tell them about a real one.
 */
import { Outlet } from 'react-router';
import { TopBar } from './top-bar';
import { MainNav } from './main-nav';
import { ToastStack } from '../components/overlays';
import { useConsole } from '../data/store';
import { useSession } from '../data/session';

export function Shell() {
  const { activities, toasts, project } = useConsole();
  const { session, signOut } = useSession();

  /** Operations still in flight, which is what a notification count should mean. */
  const running = activities.filter((entry) => entry.state === 'running').length;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar
        projectName={project?.name ?? session?.projectId ?? '—'}
        activityCount={running}
        userName={session?.displayName ?? ''}
        onSignOut={() => void signOut()}
      />
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
