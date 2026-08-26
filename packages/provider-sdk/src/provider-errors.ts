/**
 * Transport-level provider failures.
 *
 * Kept distinct from a provider *rejecting* a request. A rejection is an answer — the provider
 * considered the request and declined it, so nothing was built. A transport failure is the
 * absence of an answer, and that distinction is what the whole safety model turns on.
 *
 * @see docs/architecture/failure-sequences.md
 */

/**
 * Why a provider call failed at the transport level.
 *
 * Only `protocol_error` implies the provider did not act: the request was malformed and
 * rejected before reaching any logic. `aborted`, `deadline_exceeded`, and `unavailable` all
 * leave the outcome genuinely unknown — the request may have arrived and succeeded with only
 * the response lost.
 */
export type ProviderTransportErrorCode =
  | 'aborted'
  | 'deadline_exceeded'
  | 'protocol_error'
  | 'unavailable';

/**
 * Transport failures carry no claim about whether a provider-side mutation happened.
 *
 * That sentence is the contract. A caller that treats this as "the operation did not happen"
 * can duplicate a VM. `CreateInstanceWorkflow.handleProviderError` is where it is honoured:
 * on a mutation stage, anything but `protocol_error` escalates to manual review rather than
 * being retried, *regardless* of {@link ProviderTransportError.retryable}.
 */
export class ProviderTransportError extends Error {
  /** Transport-level cause. */
  public readonly code: ProviderTransportErrorCode;
  /**
   * Whether repeating the call is safe *in isolation*.
   *
   * True for read-only calls. On a mutation stage the workflow applies the stricter rule
   * above and ignores this flag — it is a transport hint, not permission to re-run a mutation.
   */
  public readonly retryable: boolean;

  /**
   * @param code Transport-level cause.
   * @param message Safe description; must not carry vendor detail.
   * @param options `retryable` defaults to true for everything except `protocol_error`.
   */
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
