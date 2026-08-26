import { join } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';
import { ApiExceptionFilter } from './app/common/api-exception.filter';

function readPort(defaultPort: number): number {
  const port = Number.parseInt(process.env.PORT ?? String(defaultPort), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 65_536 }),
  );
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'privatecloud.controlplane.v1',
      protoPath: join(__dirname, 'assets/proto/privatecloud/controlplane/v1/control_plane.proto'),
      url: process.env.GRPC_LISTEN_URL ?? '0.0.0.0:50051',
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
  const port = readPort(3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`control-api listening on port ${port}`);
}

void bootstrap().catch((error: unknown) => {
  Logger.error('control-api failed to start', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
