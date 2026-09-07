/**
 * Unit coverage for the capability registry.
 *
 * The rotation is the part worth pinning. Reconciliation and purge sweeps can be continuously
 * ready, so a registry that always started from the first executor would let one capability starve
 * every capability registered after it — a failure that shows up as "power requests are slow"
 * rather than as anything obviously wrong with the registry.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRegistry, type WorkflowExecutor } from './workflow-registry.js';
import type { WorkflowAction } from './workflow-stage.js';

/** An executor that reports whether it had work, and counts how often it was asked. */
function executor(action: WorkflowAction, ready: boolean): WorkflowExecutor & { calls: number } {
  const stub = {
    action,
    calls: 0,
    runOne: vi.fn(async () => {
      stub.calls += 1;
      return ready;
    }),
  };
  return stub;
}

describe('WorkflowRegistry', () => {
  it('refuses two executors for the same action', () => {
    // Routing would be ambiguous, and which one ran would depend on registration order.
    expect(
      () =>
        new WorkflowRegistry([
          executor('create_instance', false),
          executor('create_instance', false),
        ]),
    ).toThrowError(/Duplicate/);
  });

  it('reports the actions it can execute, in registration order', () => {
    const registry = new WorkflowRegistry([
      executor('create_instance', false),
      executor('power_instance', false),
    ]);
    expect(registry.actions).toEqual(['create_instance', 'power_instance']);
  });

  it('reports idle when every executor is idle, having asked each once', () => {
    const first = executor('create_instance', false);
    const second = executor('power_instance', false);
    const registry = new WorkflowRegistry([first, second]);

    return registry.runOne().then((handled) => {
      expect(handled).toBe(false);
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(1);
    });
  });

  it('stops at the first executor that advances a workflow', async () => {
    const first = executor('create_instance', true);
    const second = executor('power_instance', true);
    const registry = new WorkflowRegistry([first, second]);

    expect(await registry.runOne()).toBe(true);
    expect(first.calls).toBe(1);
    // One transition per tick: asking the next executor as well would hold two leases at once.
    expect(second.calls).toBe(0);
  });

  it('rotates so a continuously ready capability cannot starve the others', async () => {
    const first = executor('create_instance', true);
    const second = executor('power_instance', true);
    const third = executor('resize_instance', true);
    const registry = new WorkflowRegistry([first, second, third]);

    await registry.runOne();
    await registry.runOne();
    await registry.runOne();

    // Each got exactly one turn across three ticks, rather than the first taking all three.
    expect([first.calls, second.calls, third.calls]).toEqual([1, 1, 1]);
  });

  it('skips past idle executors without losing its place in the rotation', async () => {
    const idle = executor('create_instance', false);
    const busy = executor('power_instance', true);
    const registry = new WorkflowRegistry([idle, busy]);

    expect(await registry.runOne()).toBe(true);
    expect(idle.calls).toBe(1);
    expect(busy.calls).toBe(1);

    // The cursor advanced past the executor that worked, so the idle one is asked first again.
    await registry.runOne();
    expect(idle.calls).toBe(2);
  });
});
