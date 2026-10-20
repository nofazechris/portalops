import type { RetryPolicy } from "../shared-types/index.ts";

export interface AttemptOutcome {
  /** HTTP status, or null for transport failures (DNS, connect, timeout, TLS, blocked target). */
  status: number | null;
  errorCode: string | null;
}

export const isSuccess = (o: AttemptOutcome): boolean => o.status !== null && o.status >= 200 && o.status < 300;

/**
 * Transient failures are retried; permanent client errors are not (PRD §12.3).
 * Blocked-target and invalid-URL errors are permanent: retrying will never help.
 */
export function isRetryable(o: AttemptOutcome): boolean {
  if (isSuccess(o)) return false;
  if (o.status === null) return !["blocked_target", "invalid_url", "response_too_large"].includes(o.errorCode ?? "");
  return o.status === 408 || o.status === 425 || o.status === 429 || o.status >= 500;
}

/** Exponential backoff with full jitter: uniform in [0, min(max, base * 2^(attempt-1))]. */
export function backoffDelayMs(attemptJustFinished: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attemptJustFinished - 1));
  // Never schedule a retry in less than 1s: jitter shouldn't turn into a hot loop.
  return Math.max(1_000, Math.floor(random() * ceiling));
}

export type NextStep =
  | { action: "deliver" }
  | { action: "retry"; delayMs: number }
  | { action: "fail"; reason: "not_retryable" | "max_attempts" | "max_age" };

export function planNext(
  outcome: AttemptOutcome,
  attemptJustFinished: number,
  deliveryCreatedAt: Date,
  policy: RetryPolicy,
  now: Date = new Date(),
  random: () => number = Math.random,
): NextStep {
  if (isSuccess(outcome)) return { action: "deliver" };
  if (!isRetryable(outcome)) return { action: "fail", reason: "not_retryable" };
  if (attemptJustFinished >= policy.maxAttempts) return { action: "fail", reason: "max_attempts" };
  const delayMs = backoffDelayMs(attemptJustFinished, policy, random);
  if (now.getTime() + delayMs - deliveryCreatedAt.getTime() > policy.maxAgeMs) return { action: "fail", reason: "max_age" };
  return { action: "retry", delayMs };
}
