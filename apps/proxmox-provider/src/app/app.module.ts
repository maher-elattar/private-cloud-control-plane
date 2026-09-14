/**
 * Composition root for the provider service.
 *
 * Deliberately tiny: this process exists to hold provider credentials and translate the
 * provider-neutral contract into one vendor's API. It has no database, no tenant identity,
 * and no business logic.
 *
 * The adapter is chosen once, at startup, by `createProvider` — which defaults to the
 * deterministic fake and requires an explicit opt-in to reach real hardware.
 *
 * @see docs/architecture/lab-boundary.md
 */
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { shutdownTelemetry } from '@private-cloud/observability';
import { AppController } from './app.controller';
import { createProvider, providerProfileId } from './provider.factory';
import { ProviderGrpcController } from './provider-grpc.controller';
import { CREATE_INSTANCE_PROVIDER, PROVIDER_PROFILE_ID } from './tokens';

/** Flushes provider spans and metrics before process exit. */
@Injectable()
class TelemetryLifecycle implements OnApplicationShutdown {
  public async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}

/** Wires the health endpoint and the internal provider gRPC surface. */
@Module({
  controllers: [AppController, ProviderGrpcController],
  // Resolved at startup, so a misconfigured Proxmox deployment fails to boot rather than
  // failing partway through provisioning a VM.
  providers: [
    { provide: CREATE_INSTANCE_PROVIDER, useFactory: createProvider },
    { provide: PROVIDER_PROFILE_ID, useFactory: providerProfileId },
    TelemetryLifecycle,
  ],
})
export class AppModule {}
