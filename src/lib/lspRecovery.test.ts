import { describe, expect, it } from "vitest";
import { getLspRecoveryDelay, MAX_LSP_RECOVERY_ATTEMPTS } from "./lspRecovery";

describe("LSP recovery backoff", () => {
  it("uses bounded exponential delays for the configured retry attempts", () => {
    expect(getLspRecoveryDelay(1)).toBe(1_000);
    expect(getLspRecoveryDelay(2)).toBe(2_000);
    expect(getLspRecoveryDelay(3)).toBe(4_000);
    expect(MAX_LSP_RECOVERY_ATTEMPTS).toBe(3);
  });

  it("stops after the retry budget is exhausted", () => {
    expect(getLspRecoveryDelay(4)).toBeNull();
  });

  it("rejects invalid attempt counters", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getLspRecoveryDelay(attempt)).toBeNull();
    }
  });
});
