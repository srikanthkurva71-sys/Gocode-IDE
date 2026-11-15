export const MAX_LSP_RECOVERY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 4_000;

/** Return a bounded exponential-backoff delay, or null when retries are exhausted. */
export function getLspRecoveryDelay(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  if (attempt > MAX_LSP_RECOVERY_ATTEMPTS) return null;
  return Math.min(INITIAL_RETRY_DELAY_MS * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
}
