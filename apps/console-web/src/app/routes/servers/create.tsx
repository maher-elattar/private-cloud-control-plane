/**
 * Create-server wizard.
 *
 * A single scrolling form of twelve sections with a sticky order summary. Selection state is
 * mirrored into the query string so a configured order can be linked or reloaded, matching the
 * reference console's `?location=…&type=…&useIPv4=…` behaviour.
 *
 * Submitting calls `createInstance`, which returns as soon as intent is durably recorded — the
 * resulting instance appears in the list in a provisioning state rather than blocking here.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  DashedButton,
  NewBadge,
  SegmentedTabs,
  TextField,
} from '../../components/primitives';
import { StepMarker, StepperStep } from '../../components/stepper';
import type { StepState } from '../../components/stepper';
import { ArrowLeftIcon, ChevronDownIcon, MinusIcon, PlusIcon } from '../../components/icons';
import { Flag } from '../../components/flags';
import {
  BACKUP_PRICE_RATIO,
  FLAVORS,
  IMAGES,
  IPV4_PRICE_PER_MONTH,
  LOCATIONS,
  defaultInstanceName,
  findFlavor,
  findImage,
  findLocation,
  latestVersion,
} from '../../data/catalog';
import { useConsole } from '../../data/store';

const CATEGORY_LABELS = { shared: 'Shared Resources', dedicated: 'Dedicated Resources' } as const;

/**
 * Formats a euro amount, symbol first.
 *
 * Monthly figures carry two decimals; hourly rates carry three, because at these prices two
 * would collapse €0.018 and €0.022 into the same displayed value.
 */
function euro(amount: number, decimals = 2): string {
  return `€${amount.toFixed(decimals)}`;
}

function money(amount: number, unit: string) {
  return (
    <span className="whitespace-nowrap font-semibold text-primary">
      {euro(amount)}
      <span className="ml-0.5 text-xs font-normal">{unit}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Type section                                                               */
/* -------------------------------------------------------------------------- */

const TYPE_CARDS = [
  {
    id: 'cost',
    title: 'Cost-Optimized',
    blurb: 'Cost-efficient on older hardware generations, with limited availability.',
    tags: ['Cost effective', 'Low CPU usage', 'Medium traffic applications'],
    // Two architectures are offered here, so the card renders a radio group rather than a label.
    architecture: ['x86 (Intel®/AMD)', 'Arm64 (Ampere®)'],
    disabled: true,
  },
  {
    id: 'regular',
    title: 'Regular Performance',
    blurb: 'Higher CPU performance based on newer hardware generations.',
    tags: ['Best price/performance', 'Low to medium CPU usage', 'Medium traffic applications'],
    architecture: 'x86 (AMD)',
    disabled: false,
  },
  {
    id: 'dedicated',
    title: 'General Purpose',
    blurb: 'Provides dedicated vCPUs on the latest available hardware generation at the location.',
    tags: [
      'Predictable performance',
      'Critical production',
      'Sustained high CPU usage',
      'High traffic applications',
    ],
    architecture: 'x86 (AMD)',
    disabled: false,
  },
] as const;

function TypeCard({
  card,
  selected,
}: {
  readonly card: (typeof TYPE_CARDS)[number];
  readonly selected: boolean;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-lg border p-6 transition-colors ${
        card.disabled
          ? 'border-border bg-surface-disabled text-text-disabled'
          : selected
            ? 'border-2 border-primary bg-surface'
            : 'border-border bg-surface hover:bg-surface-hover'
      }`}
    >
      {selected ? <StepMarker state="done" className="absolute -left-2.5 -top-2.5" /> : null}
      <div className="flex items-center gap-2">
        <h3 className={`text-lg font-semibold ${card.disabled ? '' : 'text-text'}`}>
          {card.title}
        </h3>
        <span className="flex size-4 items-center justify-center rounded-full bg-badge-plain text-[0.625rem] text-text-muted">
          ?
        </span>
      </div>
      {card.disabled ? (
        <div className="mt-2">
          <Badge tone="orange">Limited availability</Badge>
        </div>
      ) : null}
      <p className="mt-3 text-[0.9375rem] leading-6">{card.blurb}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {card.tags.map((tag) => (
          <Badge key={tag} tone="plain">
            {tag}
          </Badge>
        ))}
      </div>
      <div className="mt-auto pt-8">
        <p className="text-[0.6875rem] uppercase tracking-wide text-text-disabled">Architecture</p>
        {Array.isArray(card.architecture) ? (
          <div className="mt-2 space-y-2">
            {card.architecture.map((option) => (
              <label key={option} className="flex items-center gap-2.5 text-[0.9375rem]">
                <span className="block size-4 rounded-full border border-form-border bg-surface" />
                {option}
              </label>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-[0.9375rem]">{card.architecture}</p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Wizard                                                                     */
/* -------------------------------------------------------------------------- */

export function CreateServer() {
  const navigate = useNavigate();
  const { createInstance, instances } = useConsole();
  const [params, setParams] = useSearchParams();

  const [category, setCategory] = useState<'shared' | 'dedicated'>('shared');
  const [imageTab, setImageTab] = useState('OS Images');
  const [imageId, setImageId] = useState('ubuntu');
  const [imageVersions, setImageVersions] = useState<Record<string, string>>({});
  const [useIpv4, setUseIpv4] = useState(params.get('useIPv4') !== 'false');
  const [useIpv6, setUseIpv6] = useState(params.get('useIPv6') !== 'false');
  const [usePrivateNet, setUsePrivateNet] = useState(params.get('usePrivateNet') === 'true');
  const [backups, setBackups] = useState(false);
  const [labels, setLabels] = useState('');
  const [cloudConfig, setCloudConfig] = useState('');
  const [count, setCount] = useState(1);
  const [nameTouched, setNameTouched] = useState(false);
  const [name, setName] = useState('');

  const flavorId = params.get('type') ?? 'cpx22';
  const locationId = params.get('location') ?? 'hel1';

  const flavor = findFlavor(flavorId);
  const location = findLocation(locationId);
  const image = findImage(imageId);
  const imageVersion = imageVersions[imageId] ?? latestVersion(image);

  /** Writes one selection into the query string, preserving the rest. */
  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  }

  const derivedName = defaultInstanceName(
    image.family,
    flavor.memoryGb,
    location.id,
    instances.length + 1,
  );
  const effectiveName = nameTouched ? name : derivedName;

  const visibleFlavors = useMemo(
    () => FLAVORS.filter((candidate) => candidate.category === category),
    [category],
  );

  const monthly = useMemo(() => {
    const server = flavor.pricePerMonth + (location.surchargePerMonth ?? 0);
    const ipv4 = useIpv4 ? IPV4_PRICE_PER_MONTH : 0;
    const backup = backups ? server * BACKUP_PRICE_RATIO : 0;
    return { server, ipv4, backup, total: (server + ipv4 + backup) * count };
  }, [flavor, location, useIpv4, backups, count]);

  const sshState: StepState = 'warning';

  function submit() {
    const parsedLabels = Object.fromEntries(
      labels
        .split('\n')
        .map((line) => line.split('='))
        .filter((parts): parts is [string, string] => parts.length === 2)
        .map(([key, value]) => [key.trim(), value.trim()]),
    );

    for (let index = 0; index < count; index += 1) {
      createInstance({
        name: count === 1 ? effectiveName : `${effectiveName}-${index + 1}`,
        flavorId: flavor.id,
        locationId: location.id,
        imageId: image.family,
        imageVersion,
        useIpv4,
        useIpv6,
        usePrivateNetwork: usePrivateNet,
        backups,
        labels: parsedLabels,
        cloudConfig,
      });
    }
    void navigate('/servers');
  }

  const summaryRows: readonly { label: string; value: string; state: StepState }[] = [
    { label: flavor.name, value: 'Type', state: 'done' },
    { label: location.city, value: 'Location', state: 'done' },
    { label: `${image.family} ${imageVersion}`, value: 'Image', state: 'done' },
    {
      label:
        [useIpv4 ? 'IPv4' : null, useIpv6 ? 'IPv6' : null, usePrivateNet ? 'Private' : null]
          .filter(Boolean)
          .join(', ') || 'None',
      value: 'Networking',
      state: 'done',
    },
    { label: 'SSH keys', value: '', state: sshState },
    { label: 'Volumes', value: '', state: 'optional' },
    { label: 'Firewalls', value: '', state: 'optional' },
    { label: 'Backups', value: '', state: backups ? 'done' : 'optional' },
    { label: 'Placement groups', value: '', state: 'optional' },
    { label: 'Labels', value: '', state: labels ? 'done' : 'optional' },
    { label: 'Cloud config', value: '', state: cloudConfig ? 'done' : 'optional' },
    { label: 'Name', value: '', state: 'done' },
  ];

  return (
    <div className="flex gap-8 px-8 py-6">
      <div className="min-w-0 flex-1">
        <Link
          to="/servers"
          className="inline-flex items-center gap-2 text-[0.9375rem] text-text-muted transition-colors hover:text-text"
        >
          <ArrowLeftIcon size={17} />
          Back to servers
        </Link>
        <h1 className="mt-4 text-[2.5rem] font-semibold leading-tight text-text">
          Create a server
        </h1>

        <div className="mt-8">
          {/* Type ------------------------------------------------------------ */}
          <StepperStep state="done" title="Type">
            <SegmentedTabs
              options={[CATEGORY_LABELS.shared, CATEGORY_LABELS.dedicated]}
              value={CATEGORY_LABELS[category]}
              onChange={(next) =>
                setCategory(next === CATEGORY_LABELS.shared ? 'shared' : 'dedicated')
              }
            />

            <div className="mt-5 grid gap-5 lg:grid-cols-3">
              {TYPE_CARDS.map((card) => (
                <TypeCard
                  key={card.id}
                  card={card}
                  selected={
                    (category === 'shared' && card.id === 'regular') ||
                    (category === 'dedicated' && card.id === 'dedicated')
                  }
                />
              ))}
            </div>

            <div className="mt-7 overflow-x-auto">
              <table className="w-full min-w-[46rem] border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-text-muted">
                    <th className="pb-1 pl-5 font-normal">Name</th>
                    <th className="pb-1 font-normal">vCPUs</th>
                    <th className="pb-1 font-normal">RAM</th>
                    <th className="pb-1 font-normal">SSD</th>
                    <th className="pb-1 font-normal">Traffic</th>
                    <th className="pb-1 font-normal">Price / h</th>
                    <th className="pb-1 pr-5 text-right font-normal">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFlavors.map((candidate) => {
                    const selected = candidate.id === flavor.id;
                    return (
                      <tr
                        key={candidate.id}
                        onClick={() => setParam('type', candidate.id)}
                        className={`cursor-pointer bg-surface text-[0.9375rem] ${
                          selected ? 'outline outline-2 outline-primary' : 'hover:bg-surface-hover'
                        }`}
                      >
                        <td className="relative rounded-l-lg py-4 pl-5">
                          {selected ? (
                            <StepMarker
                              state="done"
                              className="absolute -left-2.5 top-1/2 -translate-y-1/2"
                            />
                          ) : null}
                          <span className="flex items-center gap-2 font-medium">
                            {candidate.name}
                            {candidate.isNew ? <NewBadge /> : null}
                          </span>
                        </td>
                        <td className="py-4">
                          <span className="flex items-center gap-2">
                            {candidate.vcpus}
                            <Badge tone="plain">{candidate.architecture}</Badge>
                          </span>
                        </td>
                        <td className="py-4">{candidate.memoryGb} GB</td>
                        <td className="py-4">{candidate.diskGb} GB</td>
                        <td className="py-4">{candidate.trafficTb} TB</td>
                        <td className="py-4">
                          <span className="text-text">
                            {euro(candidate.pricePerHour, 3)}
                            <span className="text-xs text-text-muted"> / h</span>
                          </span>
                        </td>
                        <td className="rounded-r-lg py-4 pr-5 text-right">
                          {money(candidate.pricePerMonth, ' / mo')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </StepperStep>

          {/* Location -------------------------------------------------------- */}
          <StepperStep
            state="done"
            title="Location"
            description="Choose a location for your server. You can only select some features, such as private Networks and Load Balancers, if they are in the same network zone as the server. You can only select Primary IPs and Volumes that are in the same location as the server."
          >
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {LOCATIONS.map((candidate) => {
                const selected = candidate.id === location.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => setParam('location', candidate.id)}
                    className={`relative flex items-center gap-4 rounded-lg border bg-surface px-5 py-4 text-left transition-colors ${
                      selected ? 'border-2 border-primary' : 'border-border hover:bg-surface-hover'
                    }`}
                  >
                    {selected ? (
                      <StepMarker state="done" className="absolute -left-2.5 -top-2.5" />
                    ) : null}
                    <Flag country={candidate.countryCode} width={38} />
                    <span className="min-w-0">
                      <span className="block text-[1.0625rem] text-text">{candidate.city}</span>
                      <span className="block text-sm text-text-muted">{candidate.networkZone}</span>
                    </span>
                    {candidate.surchargePerMonth ? (
                      <span className="ml-auto text-sm font-medium text-primary">
                        + {euro(candidate.surchargePerMonth)}
                        <span className="text-xs"> /mo</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </StepperStep>

          {/* Image ----------------------------------------------------------- */}
          <StepperStep
            state="done"
            title="Image"
            description="Choose an operating system, or pick an app image that ships Docker, WordPress or Nextcloud pre-installed and ready to use when you create your server."
          >
            <div className="mb-6 flex gap-6 border-b border-border">
              {['OS Images', 'Apps'].map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setImageTab(tab)}
                  className={`-mb-px border-b-2 pb-2.5 text-[0.9375rem] transition-colors ${
                    imageTab === tab
                      ? 'border-primary text-primary'
                      : 'border-transparent text-text'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {imageTab === 'OS Images' ? (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {IMAGES.map((candidate) => {
                  const selected = candidate.id === image.id;
                  return (
                    <div
                      key={candidate.id}
                      className={`relative overflow-hidden rounded-lg border bg-surface ${
                        selected ? 'border-2 border-primary' : 'border-border'
                      }`}
                    >
                      {selected ? (
                        <StepMarker state="done" className="absolute -left-2.5 -top-2.5 z-10" />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setImageId(candidate.id)}
                        className="flex w-full items-center gap-4 px-5 py-5 text-left"
                      >
                        <span
                          className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                          style={{ backgroundColor: candidate.logo }}
                        >
                          {candidate.family.charAt(0)}
                        </span>
                        <span className="text-[1.0625rem] text-text">{candidate.family}</span>
                      </button>
                      <label className="flex items-center justify-center gap-2 border-t border-border bg-select-bg-default py-3 text-[0.9375rem]">
                        <select
                          value={imageVersions[candidate.id] ?? latestVersion(candidate)}
                          onChange={(event) =>
                            setImageVersions((prev) => ({
                              ...prev,
                              [candidate.id]: event.target.value,
                            }))
                          }
                          className="cursor-pointer appearance-none bg-transparent text-center outline-none"
                        >
                          {candidate.versions.map((version) => (
                            <option key={version}>{version}</option>
                          ))}
                        </select>
                        <ChevronDownIcon size={16} className="text-text-muted" />
                      </label>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[0.9375rem] text-text-muted">
                No app images are available in this catalog yet.
              </p>
            )}
          </StepperStep>

          {/* Networking ------------------------------------------------------ */}
          <StepperStep
            state="done"
            title="Networking"
            description="Choose from three networking options for your server. You can also create servers without a public network. If you want to disable the public network, you need to select a private network first."
          >
            <div className="space-y-5">
              <Checkbox
                label="Public IPv4"
                description={`A public IPv4 address costs ${euro(IPV4_PRICE_PER_MONTH)} per month.`}
                checked={useIpv4}
                onChange={(event) => {
                  setUseIpv4(event.target.checked);
                  setParam('useIPv4', String(event.target.checked));
                }}
              />
              <Checkbox
                label="Public IPv6"
                description="IPv6 addresses are free of charge."
                checked={useIpv6}
                onChange={(event) => {
                  setUseIpv6(event.target.checked);
                  setParam('useIPv6', String(event.target.checked));
                }}
              />
              <Checkbox
                label="Private networks"
                description="Private networks allow your servers to communicate with each other over a dedicated link. You can also disable the public network with this function, so that your server can be reached only within this network. Only networks of the same network zone are available."
                checked={usePrivateNet}
                onChange={(event) => {
                  setUsePrivateNet(event.target.checked);
                  setParam('usePrivateNet', String(event.target.checked));
                }}
              />
            </div>
          </StepperStep>

          {/* SSH keys -------------------------------------------------------- */}
          <StepperStep
            state={sshState}
            title="SSH keys"
            description={
              <>
                Use SSH keys for secure and efficient authentication. Ensure the key is in OpenSSH
                format. If you add an SSH key, no root credentials will be sent via email.{' '}
                <a href="#" className="text-primary hover:underline">
                  Learn more.
                </a>
              </>
            }
          >
            <Callout tone="warning" title="No SSH key selected.">
              <p>
                We recommend using an SSH key. Otherwise you will receive the root password via
                email.
              </p>
            </Callout>
            <DashedButton className="mt-6">Add SSH key</DashedButton>
          </StepperStep>

          {/* Volumes --------------------------------------------------------- */}
          <StepperStep
            state="optional"
            title="Volumes"
            description="Volumes are additional network-attached disks you can mount to your server and move between servers in the same location."
          >
            <DashedButton>Create Volume</DashedButton>
          </StepperStep>

          {/* Firewalls ------------------------------------------------------- */}
          <StepperStep state="optional" title="Firewalls">
            <p className="text-[0.9375rem] leading-6 text-text">
              Firewalls allow you to easily secure your servers by restricting or allowing traffic
              based on rules.
            </p>
            <p className="mt-5 text-[0.9375rem] leading-6 text-text">
              There are no Firewalls in this project yet. Go to{' '}
              <Link to="/firewalls" className="text-primary hover:underline">
                Firewalls
              </Link>{' '}
              to create your first one.
            </p>
          </StepperStep>

          {/* Backups --------------------------------------------------------- */}
          <StepperStep state={backups ? 'done' : 'optional'} title="Backups">
            <p className="text-[0.9375rem] leading-6 text-text">
              Backups are daily automatic copies of your server's disk. With Backups, you can easily
              restore a server to a previous state or use it to create a new server.{' '}
              <a href="#" className="text-primary hover:underline">
                Learn more.
              </a>
            </p>
            <p className="mt-5 text-[0.9375rem] leading-6 text-text">
              Backups cost an additional {BACKUP_PRICE_RATIO * 100} % of the server price. Volumes
              are not included in backups.
            </p>
            <div className="mt-6">
              <Checkbox
                label={
                  <span className="flex items-center gap-2">
                    Backups
                    <span className="flex size-4 items-center justify-center rounded-full bg-badge-plain text-[0.625rem] text-text-muted">
                      €
                    </span>
                  </span>
                }
                checked={backups}
                onChange={(event) => setBackups(event.target.checked)}
              />
            </div>
          </StepperStep>

          {/* Placement groups ------------------------------------------------ */}
          <StepperStep
            state="optional"
            title="Placement groups"
            description="Placement groups influence how your servers are spread across physical hosts, so one host failure cannot take all of them down."
          >
            <DashedButton>Create placement group</DashedButton>
          </StepperStep>

          {/* Labels ---------------------------------------------------------- */}
          <StepperStep
            state={labels ? 'done' : 'optional'}
            title="Labels"
            description={
              <>
                Labels are key-value pairs. Both key and value must be 63 characters or less, and
                must begin and end with an alphanumeric character. Alphanumerics or dashes, hyphens,
                and dots can be used in-between. The value is optional.{' '}
                <a href="#" className="text-primary hover:underline">
                  Learn more.
                </a>
              </>
            }
          >
            <div className="rounded-lg bg-[hsl(0_0%_98%)] p-5">
              <textarea
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
                placeholder={'env=production\ntier=web'}
                rows={7}
                className="w-full max-w-lg resize-y rounded border border-form-border bg-input-bg p-3 font-mono text-sm text-text outline-none focus:border-primary"
              />
            </div>
          </StepperStep>

          {/* Cloud config ---------------------------------------------------- */}
          <StepperStep
            state={cloudConfig ? 'done' : 'optional'}
            title="Cloud config"
            description="When creating a server, you can use cloud-init to process and execute scripts of up to 32 KiB for your server."
          >
            <div className="rounded-lg bg-[hsl(0_0%_98%)] p-5">
              <textarea
                value={cloudConfig}
                onChange={(event) => setCloudConfig(event.target.value)}
                placeholder="Cloud-init configuration"
                rows={6}
                className="w-full max-w-lg resize-y rounded border border-form-border bg-input-bg p-3 font-mono text-sm text-text outline-none focus:border-primary"
              />
            </div>
          </StepperStep>

          {/* Name ------------------------------------------------------------ */}
          <StepperStep state="done" title="Name" last>
            <div className="inline-flex items-center gap-4 rounded-lg bg-surface p-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
                {count}
              </span>
              <TextField
                label="Server name"
                required
                value={effectiveName}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                }}
                className="w-80"
              />
            </div>
          </StepperStep>
        </div>
      </div>

      {/* Order summary ------------------------------------------------------- */}
      <aside className="hidden w-stepper-nav shrink-0 xl:block">
        <div className="sticky top-6 rounded-lg border border-border bg-surface">
          <ul className="max-h-[26rem] overflow-y-auto p-6 scrollbar-thin">
            {summaryRows.map((row) => (
              <li key={row.label + row.value} className="flex items-start gap-3 py-2.5">
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
              onClick={() => setCount((value) => Math.min(10, value + 1))}
              className="flex size-8 items-center justify-center rounded bg-button-secondary text-text transition-colors hover:bg-button-secondary-hover"
            >
              <PlusIcon size={16} />
            </button>
          </div>

          <div className="p-6">
            <dl className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="uppercase tracking-wide text-text-muted">{count} Server</dt>
                <dd>{money(monthly.server * count, '/mo')}</dd>
              </div>
              {useIpv4 ? (
                <div className="flex items-center justify-between">
                  <dt className="uppercase tracking-wide text-text-muted">{count} IPv4</dt>
                  <dd>{money(monthly.ipv4 * count, '/mo')}</dd>
                </div>
              ) : null}
              {backups ? (
                <div className="flex items-center justify-between">
                  <dt className="uppercase tracking-wide text-text-muted">Backups</dt>
                  <dd>{money(monthly.backup * count, '/mo')}</dd>
                </div>
              ) : null}
            </dl>

            <div className="mt-4 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xl font-semibold text-text">
                TOTAL
                <span className="flex size-4 items-center justify-center rounded-full bg-badge-plain text-[0.625rem] font-normal text-text-muted">
                  ?
                </span>
              </span>
              <span className="text-xl font-semibold text-primary">
                {euro(monthly.total)}
                <span className="text-xs font-normal"> /mo</span>
              </span>
            </div>

            <Button className="mt-5 h-12 w-full text-base" onClick={submit}>
              Create &amp; Buy now
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
