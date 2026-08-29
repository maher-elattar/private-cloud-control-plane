import { shutdownTelemetry, startTelemetry } from '@private-cloud/observability';

startTelemetry({ serviceName: 'proxmox-provider' });

void import('./bootstrap.js')
  .then(({ bootstrap }) => bootstrap())
  .catch(async (error: unknown) => {
    process.stderr.write(
      `proxmox-provider failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    await shutdownTelemetry().catch(() => undefined);
    process.exitCode = 1;
  });
