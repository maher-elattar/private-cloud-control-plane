import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { createProvider } from './provider.factory';
import { ProviderGrpcController } from './provider-grpc.controller';
import { CREATE_INSTANCE_PROVIDER } from './tokens';

@Module({
  controllers: [AppController, ProviderGrpcController],
  providers: [{ provide: CREATE_INSTANCE_PROVIDER, useFactory: createProvider }],
})
export class AppModule {}
