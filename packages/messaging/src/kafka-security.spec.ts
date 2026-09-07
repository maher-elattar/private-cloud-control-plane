import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kafkaSecurity } from './kafka-consumer.js';

/**
 * The broker in a deployed cluster generates its own certificate authority and its own SASL
 * password, and the repository holds only the names of the Secrets those are mounted from. These
 * cases pin the loading contract: both halves come from files, a half-configured identity is a
 * startup failure rather than a silent downgrade to plaintext, and no failure message can carry a
 * credential.
 */
describe('kafkaSecurity', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kafka-security-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Writes a fixture file and returns its path. */
  function fixture(name: string, content: string): string {
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  }

  it('returns nothing when the broker requires nothing', () => {
    expect(kafkaSecurity({})).toEqual({});
  });

  it('loads a certificate authority from a mounted file', () => {
    const caPath = fixture(
      'ca.crt',
      '-----BEGIN CERTIFICATE-----\nzz\n-----END CERTIFICATE-----\n',
    );
    expect(kafkaSecurity({ KAFKA_TLS_CA_FILE: caPath })).toEqual({
      tls: { certificateAuthority: '-----BEGIN CERTIFICATE-----\nzz\n-----END CERTIFICATE-----' },
    });
  });

  it('loads a SASL identity whose password never passes through a variable', () => {
    const passwordPath = fixture('password', 'generated-by-the-broker\n');
    expect(
      kafkaSecurity({
        KAFKA_SASL_MECHANISM: 'SCRAM-SHA-512',
        KAFKA_SASL_USERNAME: 'control-plane',
        KAFKA_SASL_PASSWORD_FILE: passwordPath,
      }),
    ).toEqual({
      sasl: {
        mechanism: 'scram-sha-512',
        username: 'control-plane',
        password: 'generated-by-the-broker',
      },
    });
  });

  it('refuses a half-configured identity instead of connecting without one', () => {
    expect(() =>
      kafkaSecurity({
        KAFKA_SASL_MECHANISM: 'scram-sha-512',
        KAFKA_SASL_USERNAME: 'control-plane',
      }),
    ).toThrow(/must be set together/);
  });

  it('refuses an unsupported mechanism', () => {
    const passwordPath = fixture('password', 'secret');
    expect(() =>
      kafkaSecurity({
        KAFKA_SASL_MECHANISM: 'oauthbearer',
        KAFKA_SASL_USERNAME: 'control-plane',
        KAFKA_SASL_PASSWORD_FILE: passwordPath,
      }),
    ).toThrow(/must be one of/);
  });

  it('names the variable and not the content when a credential file is unreadable', () => {
    const missing = join(directory, 'absent');
    expect(() => kafkaSecurity({ KAFKA_TLS_CA_FILE: missing })).toThrow(
      'KAFKA_TLS_CA_FILE points at a file that could not be read.',
    );
  });

  it('rejects an empty credential file rather than authenticating with an empty password', () => {
    const emptyPath = fixture('empty', '   \n');
    expect(() =>
      kafkaSecurity({
        KAFKA_SASL_MECHANISM: 'plain',
        KAFKA_SASL_USERNAME: 'control-plane',
        KAFKA_SASL_PASSWORD_FILE: emptyPath,
      }),
    ).toThrow('KAFKA_SASL_PASSWORD_FILE points at an empty file.');
  });
});
