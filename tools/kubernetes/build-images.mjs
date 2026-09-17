/**
 * Builds the container images the Kubernetes manifests reference, directly into minikube.
 *
 * This is the step that has no GitOps equivalent. Argo CD reconciles *manifests*; it cannot
 * reconcile an image tag that does not resolve, and a `Rollout` whose image is missing fails its
 * progress deadline rather than reporting anything about why. Everything else in Phase 6 is
 * declarative and pull-based; this one thing is imperative and push-based, and keeping it in a
 * tool rather than in a runbook paragraph is what keeps the two tags this deployment depends on
 * from being reconstructed by hand each time.
 *
 * WHY the build targets minikube's own Docker daemon rather than the host's: a `Rollout` with
 * `imagePullPolicy: IfNotPresent` and no registry can only start from an image the *node* already
 * has. Building on the host produces an image the node cannot see, and `minikube image load`
 * re-exports and re-imports every layer — minutes per image, against a 6.0 GiB node disk that
 * cannot hold both copies. Pointing the build at the node's daemon writes the layers once, in the
 * only place they are needed.
 *
 * Usage:
 *   node tools/kubernetes/build-images.mjs                    # every image, tag phase6
 *   node tools/kubernetes/build-images.mjs --tag=phase6-green # the drill tag
 *   node tools/kubernetes/build-images.mjs --only=control-api,local-runner
 *   node tools/kubernetes/build-images.mjs --list             # what would be built, and from what
 *   node tools/kubernetes/build-images.mjs --host             # host daemon (Compose, not minikube)
 *
 * @see docs/operations/phase-6-operations-manual.md
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { run } from './kubectl.mjs';

/** Repository prefix every manifest and Compose file refers to these images by. */
const IMAGE_NAMESPACE = 'private-cloud';
/** Tag the checked-in manifests reference. Overridable for a drill or a parallel revision. */
const DEFAULT_TAG = 'phase6';

/**
 * The images this deployment needs, and the exact inputs each is built from.
 *
 * The four services share one multi-stage Dockerfile and differ only by `APP`, which selects the
 * Nx target to build and the `dist` directory to copy. `local-runner` is the same build stopped at
 * a different stage: it adds the OIDC fixture, the Proxmox simulator, and the migration tooling,
 * which is why the migration Job and the identity fixture run it and no production service does.
 */
const IMAGES = [
  {
    name: 'control-api',
    dockerfile: 'tools/docker/service.Dockerfile',
    target: 'runtime',
    buildArgs: { APP: 'control-api' },
    usedBy: 'applications/control-api.yaml',
  },
  {
    name: 'console',
    dockerfile: 'tools/docker/service.Dockerfile',
    // Its own stage, not `runtime` with an `APP`: this image bundles its dependencies and needs
    // no install step, because it carries no OpenTelemetry SDK to defeat bundling.
    target: 'console-runtime',
    buildArgs: {},
    usedBy: 'applications/console.yaml',
  },
  {
    name: 'provisioning-orchestrator',
    dockerfile: 'tools/docker/service.Dockerfile',
    target: 'runtime',
    buildArgs: { APP: 'provisioning-orchestrator' },
    usedBy: 'applications/workers.yaml',
  },
  {
    name: 'proxmox-provider',
    dockerfile: 'tools/docker/service.Dockerfile',
    target: 'runtime',
    buildArgs: { APP: 'proxmox-provider' },
    usedBy: 'applications/workers.yaml',
  },
  {
    name: 'reconciler',
    dockerfile: 'tools/docker/service.Dockerfile',
    target: 'runtime',
    buildArgs: { APP: 'reconciler' },
    usedBy: 'applications/workers.yaml',
  },
  {
    name: 'local-runner',
    dockerfile: 'tools/docker/service.Dockerfile',
    target: 'local-runtime',
    buildArgs: { APP: 'control-api' },
    usedBy: 'applications/local-oidc.yaml, data/migrations.yaml',
  },
  {
    name: 'kafka-connect',
    dockerfile: 'tools/docker/kafka-connect.Dockerfile',
    usedBy: 'data/kafka-connect.yaml',
  },
  {
    name: 'gitops-repo',
    dockerfile: 'tools/docker/gitops-repo.Dockerfile',
    usedBy: 'gitops-repo/repository-server.yaml',
  },
];

/**
 * Images whose tag is fixed regardless of `--tag`.
 *
 * The repository server serves the manifests Argo CD reads. Retagging it as part of a green drill
 * would mean the mechanism that publishes a change is itself mid-change while the change is being
 * published, so it stays on the stable tag and the drills never touch it.
 */
const TAG_PINNED = new Set(['gitops-repo', 'kafka-connect']);

/**
 * Resolves the environment that points `docker` at minikube's in-node daemon.
 *
 * Parsed from `minikube docker-env` rather than hardcoded: the host, the port, and the certificate
 * directory all vary by profile and driver, and a stale hardcoded endpoint would silently build
 * into the host daemon and produce images the node cannot see — the exact failure this tool exists
 * to prevent.
 *
 * @returns {Promise<Record<string, string>>} Variables to overlay onto the build environment.
 * @throws Error when minikube is not running, which is the usual cause and not obvious from a
 *   `docker build` failure several minutes later.
 */
async function minikubeDockerEnvironment() {
  const result = await run('minikube', ['docker-env', '--shell=bash'], { allowFailure: true });
  if (result.code !== 0 || !/DOCKER_HOST/.test(result.stdout)) {
    throw new Error(
      'minikube is not serving a Docker endpoint. Start the cluster first:\n' +
        '  minikube start\n' +
        `minikube reported: ${(result.stdout + result.stderr).trim() || `exit ${result.code}`}`,
    );
  }
  const environment = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^export ([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
    if (match) environment[match[1]] = match[2];
  }
  return environment;
}

/**
 * Runs one `docker build`, streaming its output so a long build shows progress.
 *
 * @param {readonly string[]} args Arguments after `docker`.
 * @param {Record<string, string>} environment Variables overlaid onto the process environment.
 * @returns {Promise<void>} Resolves on success.
 * @throws Error on a non-zero exit.
 */
function dockerBuild(args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...environment },
    });
    child.on('error', rejectPromise);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`docker ${args.slice(0, 2).join(' ')} exited ${code}.`)),
    );
  });
}

/**
 * Builds the selected images and reports what each one is referenced by.
 *
 * @returns {Promise<void>} Resolves once every selected image is built.
 */
async function main() {
  const flags = process.argv.slice(2);
  const tag =
    flags.find((flag) => flag.startsWith('--tag='))?.slice('--tag='.length) ?? DEFAULT_TAG;
  const only = flags
    .find((flag) => flag.startsWith('--only='))
    ?.slice('--only='.length)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const listOnly = flags.includes('--list');
  const hostDaemon = flags.includes('--host');

  const selected = only ? IMAGES.filter((image) => only.includes(image.name)) : IMAGES;
  if (only) {
    const unknown = only.filter((name) => !IMAGES.some((image) => image.name === name));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown image(s): ${unknown.join(', ')}. Known: ${IMAGES.map((i) => i.name).join(', ')}.`,
      );
    }
  }

  if (listOnly) {
    for (const image of selected) {
      const effective = TAG_PINNED.has(image.name) ? DEFAULT_TAG : tag;
      process.stdout.write(
        `${IMAGE_NAMESPACE}/${image.name}:${effective}\n` +
          `  dockerfile  ${image.dockerfile}\n` +
          `${image.target ? `  target      ${image.target}\n` : ''}` +
          `${image.buildArgs ? `  build-arg   APP=${image.buildArgs.APP}\n` : ''}` +
          `  used by     ${image.usedBy}\n`,
      );
    }
    return;
  }

  // WHY the environment is resolved once, before the first build: a failure here is "the cluster is
  // not running", and finding that out after a four-minute image build has already been written to
  // the wrong daemon wastes both the build and the node disk it would have to be cleaned off.
  const environment = hostDaemon ? {} : await minikubeDockerEnvironment();
  const destination = hostDaemon
    ? 'the host Docker daemon'
    : `minikube (${environment.DOCKER_HOST})`;
  process.stdout.write(`building ${selected.length} image(s) into ${destination}\n\n`);

  const context = resolve('.');
  for (const image of selected) {
    const effective = TAG_PINNED.has(image.name) ? DEFAULT_TAG : tag;
    const reference = `${IMAGE_NAMESPACE}/${image.name}:${effective}`;
    process.stdout.write(`── ${reference}\n`);
    await dockerBuild(
      [
        'build',
        '--file',
        image.dockerfile,
        ...(image.target ? ['--target', image.target] : []),
        ...Object.entries(image.buildArgs ?? {}).flatMap(([key, value]) => [
          '--build-arg',
          `${key}=${value}`,
        ]),
        '--tag',
        reference,
        context,
      ],
      environment,
    );
    process.stdout.write(`   built ${reference}\n\n`);
  }

  process.stdout.write(
    `Built ${selected.length} image(s) tagged ${tag}.\n` +
      'Nothing is deployed yet: the manifests already name these tags, so a Rollout picks a new\n' +
      'image up on its next revision. To roll the tag the manifests reference, publish a manifest\n' +
      'change (pnpm run k8s:publish); to verify what the node now holds, run `minikube image ls`.\n',
  );
}

await main();
