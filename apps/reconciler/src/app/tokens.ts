/**
 * DI tokens for the reconciler.
 *
 * `Symbol` tokens with `useFactory` wiring, matching the other services: the application and
 * adapter packages carry no NestJS decorators, so nothing can be injected by type.
 */

/** `ReconciliationStore` — the deliberately non-destructive persistence port. */
export const RECONCILIATION_STORE = Symbol('RECONCILIATION_STORE');

/** `LifecycleProviderPort` — gRPC client to the provider service, read methods only. */
export const PROVIDER_CLIENT = Symbol('PROVIDER_CLIENT');

/** Shared Kysely client. */
export const POSTGRES_DATABASE = Symbol('POSTGRES_DATABASE');
