/**
 * Dependency-injection token for the provider service.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */

/** `CreateInstanceProviderPort` — the adapter chosen by `createProvider` at startup. */
export const CREATE_INSTANCE_PROVIDER = Symbol('CREATE_INSTANCE_PROVIDER');
