/**
 * Console server entry point.
 *
 * Unlike the backend services there is no telemetry SDK to start before the framework loads: this
 * process forwards `traceparent` rather than emitting its own spans, which keeps a request on one
 * trace across it without an instrumentation runtime inside what is largely a static file server.
 *
 * @see apps/console-bff/src/app/log.ts
 */
import { bootstrap } from './bootstrap.js';

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `console-bff failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
