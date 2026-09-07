/**
 * Request bodies for the snapshot routes.
 *
 * Name rules are validated here for a fast field-level REST error and again in the domain, which
 * is the authoritative check because gRPC callers do not pass through `class-validator`.
 */
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSnapshotDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public description?: string;
}

/** Body for `POST .../snapshots/{snapshotId}/actions`, whose only action is `rollback`. */
export class SnapshotRollbackDto {
  @IsString()
  public action!: string;
}
