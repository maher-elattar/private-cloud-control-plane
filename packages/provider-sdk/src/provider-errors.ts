export type ProviderTransportErrorCode =
  | 'aborted'
  | 'deadline_exceeded'
  | 'protocol_error'
  | 'unavailable';

/** Transport failures carry no claim about whether a provider-side mutation happened. */
export class ProviderTransportError extends Error {
  public readonly code: ProviderTransportErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ProviderTransportErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderTransportError';
    this.code = code;
    this.retryable = options.retryable ?? code !== 'protocol_error';
  }
}
