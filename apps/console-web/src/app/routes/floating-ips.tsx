/**
 * Floating IPs — on the roadmap, and deliberately inert.
 *
 * WHY this file shrank from 309 lines to this. It was the most complete-looking section in the
 * console: a table with inline assignment, a create dialog with pricing, a seven-item context
 * menu, zone-filtered target selection, and a post-assignment modal carrying the `ip addr add`
 * command. All of it ran against `localStorage`. Nothing reached the control plane, because there
 * is no floating-IP concept anywhere in it — no entity, no route, no table, no provider-port
 * method.
 *
 * `control.ipv4_leases` is the nearest thing and is not this: an internal allocator for the single
 * address each instance receives from its network's CIDR, surfaced read-only as
 * `Instance.ipv4Lease`. It cannot be detached, reassigned, or created on its own.
 *
 * A section that looks finished and persists to the browser is worse than one that says it is not
 * built. The first invites someone to depend on it and lose their work at the next cache clear;
 * the second is merely honest. The full design is recoverable from the `console-web-original` tag
 * when an endpoint exists to put behind it.
 */
import { FloatingIpIcon } from '../components/icons';
import { EmptyState } from '../components/primitives';

export function FloatingIps() {
  return (
    <div className="px-8 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-[2rem] font-semibold text-text">Floating IPs</h1>
      </div>
      <EmptyState
        roadmap
        icon={<FloatingIpIcon size={80} />}
        title="Floating IPs are not available yet."
        description="A floating IP belongs to the project rather than to a server, so it survives the server it is attached to and can be moved to another one. Today each server receives one address leased from its network, shown on the server's own page."
        actionLabel="Create Floating IP"
        actionDisabled
      />
    </div>
  );
}
