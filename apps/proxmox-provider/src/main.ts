import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
  const port = readPort(3002);
  await app.listen(port, '0.0.0.0');
  Logger.log(`proxmox-provider listening on port ${port}`);
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    'proxmox-provider failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
