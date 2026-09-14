/**
 * Dependency-injection token for the provider service.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */

/** `CreateInstanceProviderPort` — the adapter chosen by `createProvider` at startup. */
export const CREATE_INSTANCE_PROVIDER = Symbol('CREATE_INSTANCE_PROVIDER');

/**
 * The allowlisted provider profile id, or `undefined` under the fake adapter.
 *
 * Injected into the health controller so the readiness probe can name the profile that
 * `getCapabilities` requires, without the controller reading the environment itself.
 */
export const PROVIDER_PROFILE_ID = Symbol('PROVIDER_PROFILE_ID');
