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
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { createProvider } from './provider.factory';
import { ProviderGrpcController } from './provider-grpc.controller';
import { CREATE_INSTANCE_PROVIDER } from './tokens';

/** Wires the health endpoint and the internal provider gRPC surface. */
@Module({
  controllers: [AppController, ProviderGrpcController],
  // Resolved at startup, so a misconfigured Proxmox deployment fails to boot rather than
  // failing partway through provisioning a VM.
  providers: [{ provide: CREATE_INSTANCE_PROVIDER, useFactory: createProvider }],
})
export class AppModule {}
