import { IsString, Length } from 'class-validator';

/** Attributed justification retained for audit but prohibited from telemetry. */
export class ReplayRequestDto {
  @IsString()
  @Length(10, 512)
  public readonly reason!: string;
}
