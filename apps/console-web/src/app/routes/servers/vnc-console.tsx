/**
 * Server console (VNC).
 *
 * Opens outside the application shell — no top bar, no navigation — because it is launched into
 * its own window and the remote framebuffer should own the viewport. The framebuffer fills the
 * space above a dark information bar carrying identity, addresses, and the two controls that
 * cannot be sent through the guest itself: display mode and the Ctrl+Alt+Del sequence.
 *
 * The canvas here renders a local placeholder terminal. Wiring a real framebuffer means pointing
 * a VNC client at the provider's websocket endpoint; the control plane exposes no such endpoint
 * today, so the chrome is built and the transport is left unattached.
 */
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { useConsole } from '../../data/store';

/** Lines the placeholder framebuffer prints before the login prompt. */
const BOOT_LINES = ['Ubuntu 26.04.1 LTS'] as const;

function InfoPair({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-[0.9375rem] font-semibold uppercase tracking-wide text-white/70">
        {label}:
      </dt>
      <dd className="text-[0.9375rem] text-white">{value}</dd>
    </>
  );
}

export function VncConsole() {
  const { id } = useParams();
  const { instances } = useConsole();
  const [guiMode, setGuiMode] = useState(false);
  const [focused, setFocused] = useState(false);

  const instance = instances.find((candidate) => candidate.id === id) ?? null;

  useEffect(() => {
    document.title = instance ? `${instance.name} · Console` : 'Console';
  }, [instance]);

  if (!instance) return <Navigate to="/servers" replace />;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-black">
      {/* Framebuffer. Clicking focuses it, mirroring the "press any key" hint below. */}
      <button
        type="button"
        onClick={() => setFocused(true)}
        aria-label="Server console framebuffer"
        className="flex min-h-0 flex-1 cursor-text flex-col items-start justify-start overflow-auto bg-black p-3 text-left font-mono text-sm leading-5 text-[hsl(0_0%_85%)]"
      >
        {focused ? (
          <>
            {BOOT_LINES.map((line) => (
              <p key={line}>
                {line} {instance.name} tty1
              </p>
            ))}
            <p className="mt-4">
              {instance.name} login: <span className="animate-pulse">_</span>
            </p>
          </>
        ) : (
          <p className="text-[hsl(0_0%_45%)]">Console inactive &mdash; click to connect.</p>
        )}
      </button>

      <div className="flex shrink-0 flex-col gap-3 bg-console-dark px-6 py-5">
        <div className="flex flex-wrap items-start gap-x-12 gap-y-3">
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-2">
            <InfoPair label="Server" value={instance.name} />
            <InfoPair label="Location" value={`${instance.locationCity} DC Park 1`} />
          </dl>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-2">
            <InfoPair label="IPv4" value={instance.ipv4 ?? '—'} />
            <InfoPair label="IPv6" value={instance.ipv6 ?? '—'} />
          </dl>

          <div className="ml-auto flex flex-col items-end gap-3">
            <label className="flex cursor-pointer items-center gap-2.5 text-[0.9375rem] text-white">
              <input
                type="checkbox"
                checked={guiMode}
                onChange={(event) => setGuiMode(event.target.checked)}
                className="size-4 appearance-none rounded-[3px] border border-white/40 bg-transparent checked:border-primary checked:bg-primary"
              />
              GUI-Mode
            </label>
            <button
              type="button"
              className="rounded bg-[hsl(0_0%_86%)] px-4 py-2.5 text-[0.9375rem] font-semibold text-text transition-colors hover:bg-[hsl(0_0%_91%)]"
            >
              Ctrl + Alt + Del
            </button>
          </div>
        </div>

        <p className="text-center text-sm text-white/60">
          If you see a black screen just click on it and press any key to activate the console
        </p>
      </div>
    </div>
  );
}
