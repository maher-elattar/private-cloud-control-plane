/**
 * Dependency-injection tokens for this service.
 *
 * WHY tokens rather than injecting classes by type: `ControlPlaneApplication` and the store
 * adapters import nothing from NestJS, so they carry no `@Injectable()` and NestJS cannot
 * resolve them by constructor type. They are built explicitly in `app.module.ts` and bound to
 * these symbols. `Symbol` rather than a string makes collisions impossible.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */

/** `ControlPlaneApplication` — the application service used by both transports. */
export const CONTROL_PLANE_APPLICATION = Symbol('CONTROL_PLANE_APPLICATION');
/** The shared Kysely connection pool. */
export const POSTGRES_DATABASE = Symbol('POSTGRES_DATABASE');
/** `ProjectionStore` — read-model writer driven by `ProjectionConsumer`. */
export const PROJECTION_STORE = Symbol('PROJECTION_STORE');
