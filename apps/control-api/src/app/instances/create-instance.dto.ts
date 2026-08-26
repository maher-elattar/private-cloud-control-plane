/**
 * Request body shape and validation for `POST /v1/projects/:projectId/instances`.
 *
 * WHY these rules are duplicated in `packages/domain/validateCreateInstance` rather than only
 * living here: gRPC callers never pass through `class-validator`, so the domain check is the
 * one both transports share. This DTO exists so a malformed REST body is rejected at the edge
 * with a field-level error, rather than reaching the application service as a generic failure.
 *
 * If a rule changes, it must change in both places — the domain check is the authority.
 *
 * @see docs/contracts/rest-api.md
 */
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const hostnamePattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export class CreateInstanceDto {
  @IsString()
  @Matches(slugPattern)
  public imageId!: string;

  @IsString()
  @Matches(slugPattern)
  public flavorId!: string;

  @IsString()
  @Matches(slugPattern)
  public networkId!: string;

  @IsString()
  @MaxLength(63)
  @Matches(hostnamePattern)
  public hostname!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(32, 8192, { each: true })
  public sshPublicKeys?: string[];
}
