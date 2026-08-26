import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function correlationId(value: string | undefined): string {
  if (!value) return randomUUID();
  if (!uuidPattern.test(value)) throw new BadRequestException('Correlation ID must be a UUID.');
  return value;
}

export function requestTraceparent(value: string | undefined): string {
  if (!value) {
    return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
  }
  const match = traceparentPattern.exec(value);
  if (!match || /^0+$/.test(match[1] ?? '') || /^0+$/.test(match[2] ?? '')) {
    throw new BadRequestException('Traceparent is invalid.');
  }
  return value;
}
