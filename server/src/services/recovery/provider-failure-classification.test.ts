import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  /**
   * ORU-582. The ACPX engine filed every provider refusal as `acpx_turn_failed`,
   * which this classifier's error-code guard rejected on the first line — so the
   * whole quota-recovery contract sat dormant through 161 limit failures in one
   * day. The engine classifies quota itself now; reading the text under the
   * generic engine codes is the belt-and-braces for any older engine build.
   */
  it.each([
    ["session limit · resets 10:10pm (Europe/Berlin)", "2026-08-11T20:10:00.000Z"],
    ["5-hour limit reached ∙ resets 10:10pm (Europe/Berlin)", "2026-08-11T20:10:00.000Z"],
    ["Claude usage limit reached. Try again at 10pm (America/Los_Angeles).", "2026-08-12T05:00:00.000Z"],
  ])("classifies the engine's generic turn failure by its quota text: %s", (error, retryAt) => {
    const now = new Date("2026-08-11T18:23:00.000Z");
    expect(classifyAdapterFailureForRecovery({ errorCode: "acpx_turn_failed", error, resultJson: null }, now))
      .toEqual({ kind: "provider_quota", retryAt: new Date(retryAt), parsedResetTime: true });
  });

  it("classifies the provider_quota code the engine now emits, with its persisted reset", () => {
    const now = new Date("2026-08-11T18:23:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "session limit · resets 10:10pm (Europe/Berlin)",
      resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: "2026-08-11T20:10:00.000Z" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-11T20:10:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("keeps an ordinary engine turn failure unclassified", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "ACP_TURN_FAILED: the tool call raised TypeError",
      resultJson: null,
    })).toBeNull();
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});
