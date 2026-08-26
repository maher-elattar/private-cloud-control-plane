import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';

function readPort(defaultPort: number): number {
  const port = Number.parseInt(process.env.PORT ?? String(defaultPort), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.enableShutdownHooks();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'privatecloud.provider.v1',
      protoPath: join(__dirname, 'assets/proto/privatecloud/provider/v1/provider.proto'),
      url: process.env.GRPC_LISTEN_URL ?? '0.0.0.0:50052',
      loader: {
        includeDirs: [join(__dirname, 'assets/proto')],
        keepCase: false,
        longs: String,
        enums: String,
        defaults: false,
        oneofs: true,
      },
    },
  });
  await app.startAllMicroservices();
  const port = readPort(3002);
  await app.listen(port, '0.0.0.0');
  Logger.log(`proxmox-provider listening on port ${port}`);
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    'proxmox-provider failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
