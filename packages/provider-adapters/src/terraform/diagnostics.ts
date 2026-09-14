/**
 * Parses and redacts Terraform's machine-readable output.
 *
 * PATTERN — bounded, redacted evidence. A failed apply's diagnostics are the only account an
 * operator gets of what the provider refused, so they are worth keeping. They are also the most
 * likely place for a credential to escape: Terraform quotes attribute values in error messages,
 * and one of this module's attributes is a cloud-init password.
 *
 * WHY redaction happens here rather than on read: a value that reaches a log, a span, or a
 * database column has already escaped. The only reliable place to redact is before the write, and
 * the only reliable way to know what to redact is to be told the secrets explicitly rather than
 * to guess at patterns.
 *
 * @see docs/architecture/safety-invariants.md
 */

/** One diagnostic, reduced to what is safe and useful to keep. */
export interface TerraformDiagnostic {
  readonly severity: string;
  readonly summary: string;
  readonly detail?: string;
  /** Resource address the diagnostic was attached to, when it named one. */
  readonly address?: string;
}

/** The shape Terraform emits with `-json`, of the message types this reads. */
interface JsonLogLine {
  readonly '@level'?: string;
  readonly '@message'?: string;
  readonly type?: string;
  readonly diagnostic?: {
    readonly severity?: string;
    readonly summary?: string;
    readonly detail?: string;
    readonly address?: string;
  };
}

/** Replacement written in place of any secret found. */
const REDACTION = '<redacted>';

/**
 * Longest prefix of a secret that is still worth redacting on its own.
 *
 * Terraform sometimes truncates a long value in a message. Redacting only exact matches would
 * therefore leave a truncated password in place, so a prefix of at least this length is also
 * replaced. Eight characters is short enough to catch a truncation and long enough that it will
 * not match ordinary prose.
 */
const MINIMUM_SECRET_PREFIX = 8;

/** Escapes a string for literal use in a regular expression. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the patterns that redact one secret, including its truncated prefixes.
 *
 * @param secret A value that must never appear in retained output.
 * @returns Patterns to replace, longest first, so a full match wins over a prefix.
 */
function patternsFor(secret: string): readonly RegExp[] {
  const patterns: RegExp[] = [new RegExp(escapeForPattern(secret), 'g')];
  if (secret.length > MINIMUM_SECRET_PREFIX) {
    patterns.push(new RegExp(escapeForPattern(secret.slice(0, MINIMUM_SECRET_PREFIX)), 'g'));
  }
  return patterns;
}

/**
 * Removes every known secret from a string.
 *
 * @param text Text that may contain secrets.
 * @param secrets Values to remove. Empty and short values are ignored: redacting a one-character
 *   secret would replace half the message, which destroys the evidence this exists to keep.
 * @returns The text with each secret replaced.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  const usable = [...secrets]
    .filter((secret) => secret && secret.length >= MINIMUM_SECRET_PREFIX)
    // Longest first, so a secret that contains another is redacted whole rather than in pieces.
    .sort((left, right) => right.length - left.length);
  for (const secret of usable) {
    for (const pattern of patternsFor(secret)) {
      result = result.replace(pattern, REDACTION);
    }
  }
  return result;
}

/**
 * Extracts diagnostics from Terraform's `-json` output.
 *
 * Tolerant by design: Terraform interleaves JSON lines with anything the provider writes to the
 * stream, and a parse failure on one line must not lose the diagnostics on the others. A run that
 * produced unreadable output still needs to report *something*, which is why an unparseable
 * stream yields one synthetic diagnostic rather than an empty list.
 *
 * @param output Combined stdout from a `-json` invocation.
 * @param secrets Values to redact from every message.
 * @returns The diagnostics, redacted.
 */
export function parseDiagnostics(
  output: string,
  secrets: readonly string[] = [],
): readonly TerraformDiagnostic[] {
  const diagnostics: TerraformDiagnostic[] = [];
  let sawJson = false;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: JsonLogLine;
    try {
      parsed = JSON.parse(trimmed) as JsonLogLine;
    } catch {
      continue;
    }
    sawJson = true;
    const diagnostic = parsed.diagnostic;
    if (!diagnostic) continue;
    diagnostics.push({
      severity: diagnostic.severity ?? parsed['@level'] ?? 'error',
      summary: redactSecrets(diagnostic.summary ?? parsed['@message'] ?? '', secrets),
      ...(diagnostic.detail ? { detail: redactSecrets(diagnostic.detail, secrets) } : {}),
      ...(diagnostic.address ? { address: diagnostic.address } : {}),
    });
  }

  if (diagnostics.length === 0 && !sawJson && output.trim().length > 0) {
    // Not a `-json` stream at all. Keep a bounded, redacted head of it: an operator facing a
    // provider that crashed before Terraform could frame its output needs the raw text, and the
    // alternative is reporting "no diagnostics" for a run that plainly failed.
    return [
      {
        severity: 'error',
        summary: 'Terraform produced no machine-readable diagnostics.',
        detail: redactSecrets(output.trim().slice(0, 2_000), secrets),
      },
    ];
  }

  return diagnostics;
}

/**
 * Whether any diagnostic is an error rather than a warning.
 *
 * @param diagnostics Parsed diagnostics.
 * @returns `true` when at least one has error severity.
 */
export function hasError(diagnostics: readonly TerraformDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
