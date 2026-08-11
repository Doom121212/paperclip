import { describe, expect, it } from "vitest";
import {
  isProviderQuotaErrorText,
  parseProviderQuotaResetAt,
} from "./provider-quota.js";

/**
 * ORU-582. On 11 Aug 2026 nine agents hit provider limits 161 times and not
 * one failure was classified as a quota refusal. Three separate detectors each
 * missed a different half of the real strings, so every one of these is pinned
 * verbatim as it appeared in `agent.errorReason` / the run error. If a regex is
 * ever "simplified" again, this file is what says which live string it broke.
 */
const REAL_STRINGS = {
  session: "session limit · resets 10:10pm (Europe/Berlin)",
  weekly: "weekly limit · resets Aug 13, 12pm",
  hitWeekly: "You've hit your weekly limit. Your limit will reset at 12pm (Europe/Berlin).",
  hitSessionCurly: "You’ve hit your session limit. Try again at 3pm.",
  fiveHour: "5-hour limit reached ∙ resets 10:10pm (Europe/Berlin)",
  usageLimit: "Claude usage limit reached. Try again at 10pm (America/Los_Angeles).",
} as const;

describe("isProviderQuotaErrorText", () => {
  for (const [name, text] of Object.entries(REAL_STRINGS)) {
    it(`detects the real ${name} string`, () => {
      expect(isProviderQuotaErrorText(text)).toBe(true);
    });
  }

  it("reads across the parts a caller has, in any order", () => {
    expect(isProviderQuotaErrorText(null, "", REAL_STRINGS.session)).toBe(true);
    expect(isProviderQuotaErrorText(undefined, null, "")).toBe(false);
  });

  it("does not fire on ordinary turn failures", () => {
    // These are the failures that must keep their own classification: parking
    // an agent as quota-blocked when the model simply erred would suppress
    // takeover and hold the issue until a reset that is never coming.
    expect(isProviderQuotaErrorText("ACP_TURN_FAILED: tool call failed")).toBe(false);
    expect(isProviderQuotaErrorText("429 rate_limit_error: too many requests")).toBe(false);
    expect(isProviderQuotaErrorText("model_not_found: unknown model claude-x")).toBe(false);
    expect(isProviderQuotaErrorText("the agent hit its turn limit for this run")).toBe(false);
  });
});

describe("parseProviderQuotaResetAt", () => {
  it("parses the 'resets <clock> (<tz>)' phrasing the server detector missed", () => {
    // 11 Aug 2026, 20:23 Berlin (18:23 UTC). Reset quoted as 10:10pm Berlin.
    const now = new Date("2026-08-11T18:23:00.000Z");
    const retryAt = parseProviderQuotaResetAt(REAL_STRINGS.session, now);
    expect(retryAt?.toISOString()).toBe("2026-08-11T20:10:00.000Z");
  });

  it("parses the 'try again at' phrasing the adapter detector missed", () => {
    const now = new Date("2026-08-11T18:23:00.000Z");
    const retryAt = parseProviderQuotaResetAt(REAL_STRINGS.usageLimit, now);
    // 10pm Los Angeles on 11 Aug is 05:00 UTC on 12 Aug.
    expect(retryAt?.toISOString()).toBe("2026-08-12T05:00:00.000Z");
  });

  it("rolls to tomorrow when the quoted clock has already passed today", () => {
    // 22:30 Berlin, reset quoted at 10:10pm (22:10) — already gone.
    const now = new Date("2026-08-11T20:30:00.000Z");
    const retryAt = parseProviderQuotaResetAt(REAL_STRINGS.session, now);
    expect(retryAt?.toISOString()).toBe("2026-08-12T20:10:00.000Z");
  });

  it("returns null for a calendar reset rather than guessing a day", () => {
    // "resets Aug 13, 12pm" — the caller falls back to its default backoff and
    // re-checks, which is the behaviour we want: a wrong day is worse than
    // none. On 11 Aug this exact string was still being quoted 4.5 hours after
    // the condition had cleared.
    const now = new Date("2026-08-11T18:23:00.000Z");
    expect(parseProviderQuotaResetAt(REAL_STRINGS.weekly, now)).toBeNull();
  });

  it("returns null when there is no reset clause at all", () => {
    expect(parseProviderQuotaResetAt("provider quota exceeded", new Date())).toBeNull();
  });

  it("falls back to the host clock when the timezone is unusable", () => {
    const now = new Date("2026-08-11T18:23:00.000Z");
    const retryAt = parseProviderQuotaResetAt("usage limit reached, resets 11pm (Nowhere/Bogus)", now);
    expect(retryAt).not.toBeNull();
    expect(retryAt!.getTime()).toBeGreaterThan(now.getTime());
  });
});
