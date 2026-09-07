/**
 * Read-only gRPC client for reconciliation.
 *
 * PATTERN — Adapter, deliberately narrower than the orchestrator's. The reconciler needs exactly
 * one RPC, and a client that exposes only that one cannot be used to mutate a provider resource
 * even by mistake. SAFE-029 forbids reconciliation from correcting destructively; this is the
 * transport-level half of making that true rather than merely intended.
 *
 * It is a separate file from the orchestrator's client rather than a shared package because the
 * proto assets are resolved relative to each service's own bundle, so the two cannot share a
 * runtime path.
 *
 * @see docs/adr/0008-non-destructive-reconciliation.md
 */
import { join } from 'node:path';
import {
  credentials,
  makeGenericClientConstructor,
  Metadata,
  type CallOptions,
  type Client,
  type ClientUnaryCall,
  type ServiceDefinition,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type {
  ObserveInstanceRequest,
  ObserveInstanceResponse,
} from '@private-cloud/contracts/provider';
import { ProviderTransportError } from '@private-cloud/provider-sdk';

/** Per-call deadline. A hung observation must not stall the sweep behind it. */
const DEADLINE_MS = 5_000;

/** The single RPC this client exposes. */
interface ObservationClient extends Client {
  observeInstance: (
    request: ObserveInstanceRequest,
    metadata: Metadata,
    options: CallOptions,
    callback: (error: ServiceError | null, response: ObserveInstanceResponse) => void,
  ) => ClientUnaryCall;
}

/** Constructor shape produced by `makeGenericClientConstructor`. */
type ObservationClientConstructor = new (
  address: string,
  channelCredentials: ReturnType<typeof credentials.createInsecure>,
) => ObservationClient;

/** Observes provider resources over gRPC. Cannot mutate anything. */
export class ProviderObservationClient {
  private readonly client: ObservationClient;

  /** @param address `host:port` of the provider service. */
  public constructor(address: string) {
    const protoRoot = join(__dirname, 'assets/proto');
    const definition = loadSync(join(protoRoot, 'privatecloud/provider/v1/provider.proto'), {
      includeDirs: [protoRoot],
      keepCase: false,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const service = definition['privatecloud.provider.v1.ProviderService'];
    if (!service || typeof service !== 'object') {
      throw new Error('ProviderService definition is unavailable.');
    }
    const Constructor = makeGenericClientConstructor(
      service as ServiceDefinition,
      'ProviderService',
    ) as unknown as ObservationClientConstructor;
    this.client = new Constructor(address, credentials.createInsecure());
  }

  /**
   * Reads the provider's view of one resource.
   *
   * Every failure is reported as a retryable transport error: an observation that could not be
   * made says nothing about the instance, and the next sweep will try again.
   */
  public observeInstance(request: ObserveInstanceRequest): Promise<ObserveInstanceResponse> {
    return new Promise((resolve, reject) => {
      this.client.observeInstance(
        request,
        new Metadata(),
        { deadline: new Date(Date.now() + DEADLINE_MS) },
        (error, response) => {
          if (error) {
            reject(
              new ProviderTransportError('unavailable', 'Provider observation failed.', {
                cause: error,
                retryable: true,
              }),
            );
            return;
          }
          resolve(response);
        },
      );
    });
  }

  /** Closes the channel on shutdown. */
  public close(): void {
    this.client.close();
  }
}
