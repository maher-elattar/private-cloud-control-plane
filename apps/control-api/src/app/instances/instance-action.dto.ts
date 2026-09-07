/**
 * Request body for `POST /v1/projects/{projectId}/instances/{instanceId}/actions`.
 *
 * The contract's `InstanceAction` is a discriminated union on `action`. This DTO validates the
 * discriminator and the one field resize adds; the authoritative rules — no shrink, no no-op,
 * quota headroom — live in the domain and the store, where gRPC callers reach them too.
 */
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** Every action this route accepts. */
const INSTANCE_ACTIONS = ['start', 'shutdown', 'stop', 'reboot', 'resize'] as const;

export class InstanceActionDto {
  @IsString()
  @IsIn(INSTANCE_ACTIONS)
  public action!: (typeof INSTANCE_ACTIONS)[number];

  /** Required when `action` is `resize`; ignored otherwise. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/)
  public flavorId?: string;

  /**
   * Requested disk size in GiB. Optional even on a resize: omitting it leaves the disk alone.
   *
   * Bounds match the contract's `ResizeAction`. Growth-only is enforced in the domain, where a
   * gRPC caller reaches the same rule.
   */
  @IsOptional()
  @IsInt()
  @Min(8)
  @Max(2048)
  public diskGiB?: number;
}
