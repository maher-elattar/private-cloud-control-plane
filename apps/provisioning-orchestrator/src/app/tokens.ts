/**
 * Dependency-injection tokens for the orchestrator.
 *
 * As in the control API, these exist because the workflow and adapter layers are deliberately
 * NestJS-free and are therefore constructed explicitly in `app.module.ts`.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */

/** The shared Kysely connection pool. */
export const POSTGRES_DATABASE = Symbol('POSTGRES_DATABASE');
/** `WorkflowStore` — leased, fenced workflow persistence. */
export const WORKFLOW_STORE = Symbol('WORKFLOW_STORE');
/** `CreateInstanceProviderPort` — gRPC client to the provider service. */
export const PROVIDER_CLIENT = Symbol('PROVIDER_CLIENT');
