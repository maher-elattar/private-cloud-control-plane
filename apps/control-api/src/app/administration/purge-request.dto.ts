/**
 * Request body for `POST /v1/admin/instances/{instanceId}/purges`.
 *
 * `confirmInstanceId` is the guard against the most likely way this operation destroys the wrong
 * machine: an administrator pasting one identifier into the path and meaning another. It is
 * checked against the path parameter in the store, under the same lock that accepts the purge.
 */
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class PurgeRequestDto {
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  public reason!: string;

  @IsUUID()
  public confirmInstanceId!: string;
}
