/**
 * RFC 9457 problem details, as this API actually sends them.
 *
 * WHY the console models this instead of showing "something went wrong": the contract's
 * `ProblemDetails` carries a **closed set of 29 machine codes**, a tenant-safe `detail` string, a
 * trace identifier, and field-level `invalidParams`. That is enough to drive behaviour rather than
 * just copy — re-authenticate on one code, offer a retry on another, attach a message to the
 * offending form field on a third — and throwing it away in favour of a generic banner is throwing
 * away the most useful thing the API returns.
 *
 * @see packages/contracts/openapi/components.v1.yaml
 */
import type { components } from '@private-cloud/contracts';

/** The contract's problem shape, taken from the generated types rather than restated. */
export type Problem = components['schemas']['ProblemDetails'];

/** The closed set of machine codes, so a `switch` over them can be exhaustive. */
export type ProblemCode = Problem['code'];

/**
 * A call's outcome: a value, or a problem that explains itself.
 *
 * WHY a result rather than a thrown error: every one of these failures is an expected outcome the
 * UI has a specific response to — a quota that is full, an instance that is busy, a disk shrink
 * that is refused. Exceptions are for the unexpected, and treating "the project is at its quota"
 * as exceptional is what produces a console that shows a stack trace where it should show a
 * sentence.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: Problem };

/**
 * The generic problem used when a response is not a problem document at all.
 *
 * A proxy timeout, a 502 from something in front of the API, or a body that is not JSON all land
 * here. `code: 'INTERNAL_ERROR'` is the contract's own value for "unclassified", so a caller
 * switching on codes needs no separate branch for transport failures.
 */
export function transportProblem(status: number, title: string, detail: string): Problem {
  return {
    type: 'about:blank',
    title,
    status: status >= 400 && status <= 599 ? status : 500,
    code: 'INTERNAL_ERROR',
    detail,
    traceId: '0'.repeat(32),
  };
}

/**
 * Reads a problem document out of a failed response.
 *
 * Falls back to a transport problem rather than throwing, because a console that crashes while
 * trying to describe an error is worse than one that describes it imprecisely.
 *
 * @param response The failed response.
 * @returns A problem, always.
 */
export async function readProblem(response: Response): Promise<Problem> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      'title' in body &&
      'status' in body
    ) {
      return body as Problem;
    }
    return transportProblem(response.status, response.statusText || 'Request failed', String(body));
  } catch {
    return transportProblem(
      response.status,
      response.statusText || 'Request failed',
      'The response carried no problem document.',
    );
  }
}

/**
 * Field-level messages, keyed by the field they belong to.
 *
 * `invalidParams` is how the API reports which input was wrong and why, capped at 32 entries. A
 * form that renders these against its own fields tells the user exactly what to change; one that
 * shows only `title` makes them guess.
 *
 * @param problem A problem document.
 * @returns Field name to reason.
 */
export function fieldErrors(problem: Problem): Readonly<Record<string, string>> {
  const entries = (problem.invalidParams ?? []).map(
    (parameter) => [parameter.name, parameter.reason] as const,
  );
  return Object.fromEntries(entries);
}

/**
 * Whether a problem means the session is gone and the user must sign in again.
 *
 * Both codes are returned with a 401 by the console's own proxy when it holds no session, and by
 * the API when a token is missing or expired.
 */
export function isAuthenticationProblem(problem: Problem): boolean {
  return problem.code === 'AUTHENTICATION_REQUIRED' || problem.status === 401;
}

/**
 * Whether the same request is worth sending again unchanged.
 *
 * `INSTANCE_BUSY` means another workflow holds the instance's lease, which is a wait rather than a
 * refusal. `RATE_LIMITED` and `DEPENDENCY_UNAVAILABLE` are the transport equivalents. Everything
 * else — a full quota, a refused shrink, a validation failure — will answer identically forever,
 * and offering a retry for those trains people to click twice.
 */
export function isRetryable(problem: Problem): boolean {
  return (
    problem.code === 'INSTANCE_BUSY' ||
    problem.code === 'RATE_LIMITED' ||
    problem.code === 'DEPENDENCY_UNAVAILABLE'
  );
}

/**
 * The sentence to show a user for a given problem.
 *
 * `detail` is `x-classification: tenant-safe` in the contract, so it is safe to render verbatim
 * and is usually the most specific thing available. The per-code guidance exists because a few
 * codes have an action attached that the API cannot know to suggest.
 */
export function problemMessage(problem: Problem): string {
  switch (problem.code) {
    case 'QUOTA_EXCEEDED':
      return problem.detail
        ? `${problem.detail} Remove an existing resource, or ask for the project's quota to be raised.`
        : "This project has reached its quota. Remove an existing resource, or ask for the project's quota to be raised.";
    case 'INSTANCE_BUSY':
      return 'Another change is already running on this server. It will be available again in a moment.';
    case 'DISK_SHRINK_FORBIDDEN':
      return 'A disk can grow but never shrink. Choose a size at least as large as the current one.';
    case 'IDEMPOTENCY_CONFLICT':
      // Reaching this is a console bug, not a user error: it means the same key was sent with a
      // different body. Saying so plainly is more useful than inventing a user-facing cause.
      return 'This request conflicts with one already submitted under the same identity. Please report this.';
    case 'AUTHENTICATION_REQUIRED':
      return 'Your session has expired. Sign in again to continue.';
    case 'PROJECT_ACCESS_DENIED':
      return 'This project is not available to your account.';
    default:
      return problem.detail ?? problem.title;
  }
}
