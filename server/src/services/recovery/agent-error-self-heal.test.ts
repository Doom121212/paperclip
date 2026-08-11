import { describe, expect, it } from "vitest";
import { classifyAgentErrorForSelfHeal } from "./agent-error-self-heal.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * ORU-582. Every string here is one an agent record really carried on
 * 11 Aug 2026, when five of eleven agents sat in `error` — two of them on a
 * limit that had already reset — until a human cleared each by hand.
 */
function verdict(overrides: {
  errorReason?: string | null;
  latestRun?: Partial<NonNullable<Parameters<typeof classifyAgentErrorForSelfHeal>[0]["latestRun"]>> | null;
  now?: Date;
}) {
  const now = overrides.now ?? new Date("2026-08-11T20:23:00.000Z");
  return classifyAgentErrorForSelfHeal({
    errorReason: overrides.errorReason ?? null,
    latestRun:
      overrides.latestRun === null
        ? null
        : {
            error: null,
            errorCode: null,
            errorFamily: null,
            retryNotBefore: null,
            finishedAt: null,
            ...overrides.latestRun,
          },
    now,
    defaultQuotaBackoffMs: HOUR_MS,
  });
}

describe("classifyAgentErrorForSelfHeal", () => {
  // Noor was parked at 16:38 Berlin on a limit quoted as resetting at 22:10.
  const PARKED_AT = new Date("2026-08-11T14:38:00.000Z");

  it("recovers a session limit whose quoted reset has passed", () => {
    // 22:23 Berlin — thirteen minutes after the reset, and where Noor still sat.
    expect(
      verdict({
        errorReason: "session limit · resets 10:10pm (Europe/Berlin)",
        latestRun: { finishedAt: PARKED_AT },
        now: new Date("2026-08-11T20:23:00.000Z"),
      }),
    ).toMatchObject({ recoverable: true, reason: "provider_quota" });
  });

  it("holds a session limit whose quoted reset is still ahead", () => {
    // 21:00 Berlin: the limit is real and still binding for another 70 minutes.
    const held = verdict({
      errorReason: "session limit · resets 10:10pm (Europe/Berlin)",
      latestRun: { finishedAt: PARKED_AT },
      now: new Date("2026-08-11T19:00:00.000Z"),
    });
    expect(held).toMatchObject({ recoverable: false, reason: "quota_not_reset" });
    expect(held.retryAt?.toISOString()).toBe("2026-08-11T20:10:00.000Z");
  });

  it("resolves the quoted clock against the failure, not against the sweep", () => {
    // The bug in miniature: read at 22:23 the string "resets 10:10pm" describes
    // an instant thirteen minutes ago, but the *next* 10:10pm is 24 hours out.
    // Anchoring on the sweep clock re-arms the latch for another day, every day.
    const held = verdict({
      errorReason: "session limit · resets 10:10pm (Europe/Berlin)",
      latestRun: null,
      now: new Date("2026-08-11T20:23:00.000Z"),
    });
    expect(held.retryAt?.toISOString()).toBe("2026-08-12T20:10:00.000Z");
  });

  it("prefers the reset the adapter persisted over anything in the text", () => {
    expect(
      verdict({
        errorReason: "session limit · resets 10:10pm (Europe/Berlin)",
        latestRun: {
          errorCode: "provider_quota",
          errorFamily: "provider_quota",
          retryNotBefore: new Date("2026-08-11T23:00:00.000Z"),
        },
        now: new Date("2026-08-11T20:23:00.000Z"),
      }),
    ).toMatchObject({ recoverable: false, reason: "quota_not_reset" });
  });

  it("falls back to a bounded backoff for a calendar reset it will not parse", () => {
    // "resets Aug 13, 12pm" was quoted by three agents four hours after the
    // condition had cleared and two days before its claimed reset. Waiting for
    // that date is exactly the unbounded park this issue is about, so the
    // failure time plus one backoff decides instead.
    const failedAt = new Date("2026-08-11T15:00:00.000Z");
    expect(
      verdict({
        errorReason: "weekly limit · resets Aug 13, 12pm",
        latestRun: { finishedAt: failedAt },
        now: new Date("2026-08-11T15:30:00.000Z"),
      }),
    ).toMatchObject({ recoverable: false, reason: "quota_not_reset" });
    expect(
      verdict({
        errorReason: "weekly limit · resets Aug 13, 12pm",
        latestRun: { finishedAt: failedAt },
        now: new Date("2026-08-11T20:23:00.000Z"),
      }),
    ).toMatchObject({ recoverable: true, reason: "provider_quota" });
  });

  it("recovers a lost process immediately, by code or by message", () => {
    expect(verdict({ latestRun: { errorCode: "process_lost" } })).toMatchObject({
      recoverable: true,
      reason: "process_lost",
    });
    expect(
      verdict({ errorReason: "Process lost -- child pid 3571518 is no longer running" }),
    ).toMatchObject({ recoverable: true, reason: "process_lost" });
    expect(verdict({ errorReason: "Process lost -- server may have restarted" })).toMatchObject({
      recoverable: true,
      reason: "process_lost",
    });
  });

  it("holds any class until the anti-thrash dwell has elapsed", () => {
    // Without a floor a persistently failing agent thrashes idle → run → error
    // on every scheduler tick, which is a busier outage than the one this fixes.
    const failedAt = new Date("2026-08-11T20:23:00.000Z");
    expect(
      verdict({
        errorReason: "Process lost -- server may have restarted",
        latestRun: { errorCode: "process_lost", finishedAt: failedAt },
        now: new Date("2026-08-11T20:23:30.000Z"),
      }),
    ).toMatchObject({ recoverable: false, reason: "min_dwell_not_elapsed" });
    expect(
      verdict({
        errorReason: "Process lost -- server may have restarted",
        latestRun: { errorCode: "process_lost", finishedAt: failedAt },
        now: new Date("2026-08-11T20:24:30.000Z"),
      }),
    ).toMatchObject({ recoverable: true, reason: "process_lost" });
  });

  it("does not race the stated reset boundary", () => {
    // A provider that says 22:10 means the window opens after 22:10, not at it.
    const failedAt = new Date("2026-08-11T14:38:00.000Z");
    expect(
      verdict({
        errorReason: "session limit · resets 10:10pm (Europe/Berlin)",
        latestRun: { finishedAt: failedAt },
        now: new Date("2026-08-11T20:10:10.000Z"),
      }),
    ).toMatchObject({ recoverable: false, reason: "quota_not_reset" });
  });

  it("recovers a workspace validation failure, which is also infrastructure", () => {
    expect(verdict({ latestRun: { errorCode: "workspace_validation_failed" } })).toMatchObject({
      recoverable: true,
      reason: "process_lost",
    });
  });

  it("leaves a genuine work failure parked", () => {
    // The whole value of `error` is telling this apart from an outage. Clearing
    // it would just re-run the same failure on the next tick.
    expect(
      verdict({
        errorReason: "Agent turn failed: tool call raised TypeError",
        latestRun: { errorCode: "acpx_turn_failed" },
      }),
    ).toMatchObject({ recoverable: false, reason: "not_recoverable" });
    expect(verdict({ errorReason: null, latestRun: null })).toMatchObject({
      recoverable: false,
      reason: "not_recoverable",
    });
  });

  it("recovers on the run's error family even when the agent reason says nothing", () => {
    // The reason string is a frozen copy of one failure; the run is the record.
    expect(
      verdict({
        errorReason: null,
        latestRun: {
          errorCode: "provider_quota",
          errorFamily: "provider_quota",
          finishedAt: new Date("2026-08-11T15:00:00.000Z"),
        },
        now: new Date("2026-08-11T20:23:00.000Z"),
      }),
    ).toMatchObject({ recoverable: true, reason: "provider_quota" });
  });
});
