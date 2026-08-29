import { shutdownTelemetry, startTelemetry } from '@private-cloud/observability';

// The SDK starts before NestJS, Fastify, gRPC, and PostgreSQL modules are evaluated. Node
// instrumentation patches modules at load time, so importing the framework first would silently
// omit the inbound, outbound, and database spans this service exists to demonstrate.
startTelemetry({ serviceName: 'control-api' });

void import('./bootstrap.js')
  .then(({ bootstrap }) => bootstrap())
  .catch(async (error: unknown) => {
    process.stderr.write(
      `control-api failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    await shutdownTelemetry().catch(() => undefined);
    process.exitCode = 1;
  });
