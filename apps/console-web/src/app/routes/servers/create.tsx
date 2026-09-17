/**
 * Create-server wizard.
 *
 * The twelve-step stepper and the order-summary rail are kept exactly as designed. What changed is
 * what fills them: flavours, images and networks now come from
 * `/v1/projects/{id}/catalog/{flavors,images,networks}` instead of a hardcoded table of another
 * provider's products, and the steps with nothing behind them say so.
 *
 * Four steps are real, because `CreateInstanceRequest` is exactly
 * `{ imageId, flavorId, networkId, hostname, sshPublicKeys }` and the API sets
 * `forbidNonWhitelisted` — one extra property is a hard rejection, not a field quietly ignored.
 * The rest are roadmap-marked rather than removed, so the shape of the finished flow stays visible.
 *
 * SSH keys are among the real four. There is no stored key entity to pick from, but the create
 * request accepts up to five inline public keys, so the step takes them as text.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Badge, Button, Callout, TextField } from '../../components/primitives';
import { StepMarker, StepperStep } from '../../components/stepper';
import type { StepState } from '../../components/stepper';
import { ArrowLeftIcon, MinusIcon, PlusIcon } from '../../components/icons';
import { IPV4_PRICE_PER_MONTH, priceFor, suggestedHostname } from '../../data/catalog';
import { useConsole } from '../../data/store';

/** MiB per GiB, for rendering a flavour's memory. */
const MIB_PER_GIB = 1024;

/** The API's cap on inline public keys in one create request. */
const MAXIMUM_SSH_KEYS = 5;

/** Formats a euro amount, symbol first. */
function euro(amount: number, decimals = 2): string {
  return `€ ${amount.toFixed(decimals)}`;
}

function money(amount: number, unit: string) {
  return (
    <span className="whitespace-nowrap">
      {euro(amount)}
      <span className="text-xs text-text-muted"> {unit}</span>
    </span>
  );
}

/**
 * Splits pasted key text into individual keys.
 *
 * One per line, blanks dropped. Validation is the server's job — `validateCreateInstance` checks
 * each key's structure, and duplicating that here would mean two definitions of a valid key that
 * could disagree. What this does check is the count, because exceeding it is a whole-request
 * failure the user can fix before submitting.
 */
function parseKeys(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A step the control plane does not implement yet. */
function RoadmapStep({ note }: { readonly note: string }) {
  return (
    <div className="flex items-center gap-3">
      <Badge tone="orange">On the roadmap</Badge>
      <p className="text-[0.9375rem] text-text-muted">{note}</p>
    </div>
  );
}

export function CreateServer() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { flavors, images, networks, quota, createInstance, loading, error } = useConsole();

  const [flavorId, setFlavorId] = useState(params.get('flavor') ?? '');
  const [imageId, setImageId] = useState(params.get('image') ?? '');
  const [networkId, setNetworkId] = useState(params.get('network') ?? '');
  const [hostname, setHostname] = useState('');
  const [hostnameTouched, setHostnameTouched] = useState(false);
  const [sshKeys, setSshKeys] = useState('');
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  // The first entry of each catalog is the default, so a wizard opened cold is already valid.
  const flavor = flavors.find((entry) => entry.id === flavorId) ?? flavors[0];
  const image = images.find((entry) => entry.id === imageId) ?? images[0];
  const network = networks.find((entry) => entry.id === networkId) ?? networks[0];

  const keys = useMemo(() => parseKeys(sshKeys), [sshKeys]);
  const tooManyKeys = keys.length > MAXIMUM_SSH_KEYS;

  const derivedHostname = useMemo(() => (image ? suggestedHostname(image.id) : 'server'), [image]);
  const effectiveHostname = hostnameTouched ? hostname : derivedHostname;

  /**
   * How many more instances the project's quota allows.
   *
   * Shown and enforced before submitting, because the real quota here is three: without this the
   * count stepper would happily offer ten and the fourth create would be refused with
   * `QUOTA_EXCEEDED` after three had already been accepted.
   */
  const headroom = quota ? Math.max(0, quota.limits.instances - quota.usage.instances) : null;
  const maximumCount = headroom === null ? 1 : Math.max(1, Math.min(10, headroom));

  function remember(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  }

  const monthly = useMemo(() => {
    const server = flavor ? priceFor(flavor.id) : 0;
    return { server, ipv4: IPV4_PRICE_PER_MONTH, total: (server + IPV4_PRICE_PER_MONTH) * count };
  }, [flavor, count]);

  const summaryRows: readonly { label: string; value: string; state: StepState }[] = [
    { label: 'Type', value: flavor?.name ?? '', state: flavor ? 'done' : 'optional' },
    { label: 'Network', value: network?.name ?? '', state: network ? 'done' : 'optional' },
    { label: 'Image', value: image?.name ?? '', state: image ? 'done' : 'optional' },
    {
      label: 'SSH keys',
      value: keys.length === 0 ? 'None — password login only' : `${keys.length} key(s)`,
      state: keys.length === 0 ? 'warning' : 'done',
    },
    { label: 'Volumes', value: 'On the roadmap', state: 'optional' },
    { label: 'Firewalls', value: 'On the roadmap', state: 'optional' },
    { label: 'Backups', value: 'On the roadmap', state: 'optional' },
    { label: 'Placement groups', value: 'On the roadmap', state: 'optional' },
    { label: 'Labels', value: 'On the roadmap', state: 'optional' },
    { label: 'Cloud config', value: 'On the roadmap', state: 'optional' },
    { label: 'Name', value: effectiveHostname, state: 'done' },
  ];

  const ready = Boolean(flavor && image && network) && !tooManyKeys && !submitting;

  async function submit() {
    if (!flavor || !image || !network) return;
    setSubmitting(true);
    try {
      // One request per server: the API has no batch create. Each carries its own hostname, which
      // also gives each its own idempotency key — the same key for two different hostnames would
      // be an `IDEMPOTENCY_CONFLICT`.
      for (let index = 0; index < count; index += 1) {
        const result = await createInstance({
          hostname: count === 1 ? effectiveHostname : `${effectiveHostname}-${index + 1}`,
          flavorId: flavor.id,
          imageId: image.id,
          networkId: network.id,
          sshPublicKeys: keys,
        });
        // Stop at the first refusal rather than pushing the rest into the same wall. The toast
        // already carries the reason.
        if (!result.ok) return;
      }
      await navigate('/servers');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="px-8 py-6">
        <p className="text-[0.9375rem] text-text-muted">Loading the catalog…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-8 py-6">
        <Callout tone="error" title="The catalog could not be loaded.">
          {error.detail ?? error.title} Reference {error.traceId}.
        </Callout>
      </div>
    );
  }

  return (
    <div className="flex gap-8 px-8 py-6">
      <div className="min-w-0 flex-1">
        <Link
          to="/servers"
          className="inline-flex items-center gap-2 text-[0.9375rem] text-primary hover:underline"
        >
          <ArrowLeftIcon size={15} />
          Back to servers
        </Link>
        <h1 className="mt-4 text-[2.5rem] font-semibold leading-none text-text">Create a server</h1>

        <div className="mt-10">
          <StepperStep state={flavor ? 'done' : 'optional'} title="Type">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-left">
                <thead>
                  <tr className="text-[0.6875rem] uppercase tracking-wide text-text-disabled">
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-4 py-2 font-semibold">vCPU</th>
                    <th className="px-4 py-2 font-semibold">RAM</th>
                    <th className="px-4 py-2 font-semibold">Disk</th>
                    <th className="px-4 py-2 font-semibold">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {flavors.map((candidate) => {
                    const selected = candidate.id === flavor?.id;
                    return (
                      <tr
                        key={candidate.id}
                        onClick={() => {
                          setFlavorId(candidate.id);
                          remember('flavor', candidate.id);
                        }}
                        className={`cursor-pointer text-[0.9375rem] transition-colors ${
                          selected
                            ? 'bg-select-bg-default text-text'
                            : 'text-text hover:bg-surface-hover'
                        }`}
                      >
                        <td className="border-t border-border px-4 py-4">
                          <span className="flex items-center gap-2.5">
                            <StepMarker state={selected ? 'done' : 'optional'} />
                            {candidate.name}
                          </span>
                        </td>
                        <td className="border-t border-border px-4 py-4">{candidate.cpuCount}</td>
                        <td className="border-t border-border px-4 py-4">
                          {(candidate.memoryMiB / MIB_PER_GIB).toFixed(0)} GB
                        </td>
                        <td className="border-t border-border px-4 py-4">
                          {candidate.minimumDiskGiB} GB
                        </td>
                        <td className="border-t border-border px-4 py-4">
                          {money(priceFor(candidate.id), '/mo')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </StepperStep>

          <StepperStep state={network ? 'done' : 'optional'} title="Network">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {networks.map((candidate) => {
                const selected = candidate.id === network?.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => {
                      setNetworkId(candidate.id);
                      remember('network', candidate.id);
                    }}
                    className={`relative rounded-lg border p-5 text-left transition-colors ${
                      selected
                        ? 'border-2 border-primary bg-surface'
                        : 'border-border bg-surface hover:bg-surface-hover'
                    }`}
                  >
                    {selected ? (
                      <StepMarker state="done" className="absolute -left-2.5 -top-2.5" />
                    ) : null}
                    <span className="block text-[1.0625rem] text-text">{candidate.name}</span>
                    <span className="mt-1 block text-sm text-text-muted">{candidate.ipv4Cidr}</span>
                    <span className="mt-1 block text-sm text-text-muted">
                      Gateway {candidate.gateway}
                    </span>
                  </button>
                );
              })}
            </div>
          </StepperStep>

          <StepperStep state={image ? 'done' : 'optional'} title="Image">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {images.map((candidate) => {
                const selected = candidate.id === image?.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => {
                      setImageId(candidate.id);
                      remember('image', candidate.id);
                    }}
                    className={`relative rounded-lg border p-5 text-left transition-colors ${
                      selected
                        ? 'border-2 border-primary bg-surface'
                        : 'border-border bg-surface hover:bg-surface-hover'
                    }`}
                  >
                    {selected ? (
                      <StepMarker state="done" className="absolute -left-2.5 -top-2.5" />
                    ) : null}
                    <span className="block text-[1.0625rem] text-text">{candidate.name}</span>
                    <span className="mt-1 block text-sm text-text-muted">
                      {candidate.architecture}
                    </span>
                  </button>
                );
              })}
            </div>
          </StepperStep>

          <StepperStep state={keys.length === 0 ? 'warning' : 'done'} title="SSH keys">
            {keys.length === 0 ? (
              <Callout tone="warning" title="No SSH key selected.">
                Without a key you will have to sign in with the image's cloud-init password. Paste
                one public key per line.
              </Callout>
            ) : null}
            <textarea
              value={sshKeys}
              onChange={(event) => setSshKeys(event.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="ssh-ed25519 AAAA… you@example.com"
              aria-label="SSH public keys, one per line"
              className="mt-4 w-full rounded border border-form-border bg-input-bg p-3 font-mono text-sm text-text"
            />
            {tooManyKeys ? (
              <Callout tone="error" title="Too many keys.">
                A create request accepts at most {MAXIMUM_SSH_KEYS}; you have pasted {keys.length}.
              </Callout>
            ) : null}
          </StepperStep>

          <StepperStep state="optional" title="Volumes">
            <RoadmapStep note="Network-attached disks that can be moved between servers." />
          </StepperStep>

          <StepperStep state="optional" title="Firewalls">
            <RoadmapStep note="Stateful packet filters applied to a server's interfaces." />
          </StepperStep>

          <StepperStep state="optional" title="Backups">
            <RoadmapStep note="Scheduled daily copies on a rotation. Snapshots are available today." />
          </StepperStep>

          <StepperStep state="optional" title="Placement groups">
            <RoadmapStep note="Spreading servers across hosts so one failure cannot take all of them." />
          </StepperStep>

          <StepperStep state="optional" title="Labels">
            <RoadmapStep note="Key-value metadata for grouping and filtering servers." />
          </StepperStep>

          <StepperStep state="optional" title="Cloud config">
            <RoadmapStep note="A cloud-init document applied on first boot." />
          </StepperStep>

          <StepperStep state="done" title="Name" last>
            <div className="max-w-md">
              <TextField
                label="Hostname"
                required
                value={effectiveHostname}
                onChange={(event) => {
                  setHostnameTouched(true);
                  setHostname(event.target.value);
                }}
                className="w-80"
              />
              <p className="mt-2 text-sm text-text-muted">
                Lower case, digits and hyphens, up to 63 characters. This is the server's hostname;
                there is no separate display name.
              </p>
              {count > 1 ? (
                <p className="mt-2 text-sm text-text-muted">
                  Creating {count} servers, numbered from {effectiveHostname}-1.
                </p>
              ) : null}
            </div>
          </StepperStep>
        </div>
      </div>

      {/* Order summary ------------------------------------------------------- */}
      <aside className="hidden w-stepper-nav shrink-0 xl:block">
        <div className="sticky top-6 rounded-lg border border-border bg-surface">
          <ul className="max-h-[26rem] overflow-y-auto p-6 scrollbar-thin">
            {summaryRows.map((row) => (
              <li key={row.label} className="flex items-start gap-3 py-2.5">
                <StepMarker state={row.state} className="mt-0.5" />
                <span className="min-w-0">
                  <span
                    className={`block text-[1.0625rem] ${
                      row.state === 'optional' ? 'text-text-disabled' : 'text-text'
                    }`}
                  >
                    {row.label}
                  </span>
                  {row.value ? (
                    <span className="block text-sm text-text-muted">{row.value}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between border-y border-border px-4 py-3">
            <button
              type="button"
              aria-label="Fewer servers"
              onClick={() => setCount((value) => Math.max(1, value - 1))}
              className="flex size-8 items-center justify-center rounded bg-button-secondary text-text transition-colors hover:bg-button-secondary-hover"
            >
              <MinusIcon size={16} />
            </button>
            <span className="text-[1.0625rem] text-text">
              {count} Server{count === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              aria-label="More servers"
              disabled={count >= maximumCount}
              onClick={() => setCount((value) => Math.min(maximumCount, value + 1))}
              className="flex size-8 items-center justify-center rounded bg-button-secondary text-text transition-colors hover:bg-button-secondary-hover disabled:cursor-not-allowed disabled:bg-button-secondary-disabled disabled:text-text-disabled"
            >
              <PlusIcon size={16} />
            </button>
          </div>

          {headroom !== null ? (
            <p className="px-4 pt-3 text-center text-xs text-text-muted">
              {headroom === 0
                ? 'This project is at its instance quota.'
                : `${headroom} of ${quota?.limits.instances} instances remaining in this project.`}
            </p>
          ) : null}

          <div className="p-6">
            <dl className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="uppercase tracking-wide text-text-muted">{count} Server</dt>
                <dd>{money(monthly.server * count, '/mo')}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="uppercase tracking-wide text-text-muted">{count} IPv4</dt>
                <dd>{money(monthly.ipv4 * count, '/mo')}</dd>
              </div>
            </dl>

            <div className="mt-4 flex items-center justify-between">
              <span className="text-xl font-semibold text-text">TOTAL</span>
              <span className="text-xl font-semibold text-primary">
                {euro(monthly.total)}
                <span className="text-xs font-normal"> /mo</span>
              </span>
            </div>

            <Button
              className="mt-5 h-12 w-full text-base"
              onClick={() => void submit()}
              disabled={!ready || headroom === 0}
            >
              {submitting ? 'Creating…' : 'Create & Buy now'}
            </Button>
            <p className="mt-3 text-center text-xs leading-5 text-text-muted">
              All prices excl. VAT. Our{' '}
              <a href="#" className="text-primary hover:underline">
                terms and conditions
              </a>{' '}
              apply.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
