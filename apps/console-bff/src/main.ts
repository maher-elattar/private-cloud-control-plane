import { shutdownTelemetry, startTelemetry } from '@private-cloud/observability';

// The SDK starts before Fastify is evaluated, for the same reason it does in every other service
// here: Node instrumentation patches modules at load time, so importing the framework first would
// silently omit the inbound and outbound spans this process exists to contribute.
startTelemetry({ serviceName: 'console-bff' });

void import('./bootstrap.js')
  .then(({ bootstrap }) => bootstrap())
  .catch(async (error: unknown) => {
    process.stderr.write(
      `console-bff failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    await shutdownTelemetry().catch(() => undefined);
    process.exitCode = 1;
  });
