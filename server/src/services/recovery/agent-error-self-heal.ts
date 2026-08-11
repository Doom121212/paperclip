/**
 * ORU-582. `error` on an agent is a latch: `finalizeAgentStatus` sets it when a
 * run fails and nothing ever re-reads the condition. An agent parked at 16:38
 * on a limit that cleared at 22:10 stayed parked, and on 11 Aug 2026 that took
 * five of eleven agents off the board for hours while the board showed
 * dependency-blocked work rather than an outage.
 *
 * This module decides, for one parked agent, whether the condition that parked
 * it is knowably over. It is deliberately a pure function of (reason, latest
 * run, clock) so the decision can be tested against the strings the providers
 * really sent, without standing up a database.
 */
import { isProviderQuotaErrorText, parseProviderQuotaResetAt } from "@paperclipai/adapter-utils";

/**
 * Failures that are infrastructure, never budget and never the work: the child
 * died or the server restarted under it. The run level already treats these as
 * retryable — the agent record was the one place still holding them terminal.
 */
const INFRASTRUCTURE_ERROR_CODES = new Set<string>(["process_lost", "workspace_validation_failed"]);

const PROCESS_LOST_MESSAGE_RE = /^\s*Process lost\b/im;

/**
 * Never unlatch an agent that has only just been parked. Without a floor a
 * persistently failing agent thrashes idle → run → error on every scheduler
 * tick, which is a busier outage than the one this fixes.
 */
export const AGENT_ERROR_SELF_HEAL_MIN_DWELL_MS = 60_000;

/** Providers state resets at minute granularity; do not race the boundary. */
const QUOTA_RESET_BUFFER_MS = 60_000;

export type AgentErrorSelfHealInput = {
  errorReason: string | null;
  latestRun: {
    error: string | null;
    errorCode: string | null;
    errorFamily: string | null;
    retryNotBefore: Date | null;
    finishedAt: Date | null;
  } | null;
  now: Date;
  /**
   * How long to wait from the failure when the refusal quotes no reset we can
   * trust. Matches the issue-level quota recovery backoff.
   */
  defaultQuotaBackoffMs: number;
};

export type AgentErrorSelfHealVerdict =
  | { recoverable: true; reason: "provider_quota" | "process_lost"; retryAt: Date | null }
  | {
      recoverable: false;
      reason: "not_recoverable" | "quota_not_reset" | "min_dwell_not_elapsed";
      retryAt: Date | null;
    };

/**
 * Unlatch only the two classes whose condition is knowably over. Everything
 * else stays parked: an agent that failed because its work failed should keep
 * saying so, and clearing it would just re-run the same failure.
 */
export function classifyAgentErrorForSelfHeal(
  input: AgentErrorSelfHealInput,
): AgentErrorSelfHealVerdict {
  const { errorReason, latestRun, now, defaultQuotaBackoffMs } = input;
  const text = [errorReason ?? "", latestRun?.error ?? ""].join("\n");
  const dwellFloor = latestRun?.finishedAt
    ? new Date(latestRun.finishedAt.getTime() + AGENT_ERROR_SELF_HEAL_MIN_DWELL_MS)
    : null;
  const notBefore = (candidate: Date | null) => {
    if (!dwellFloor) return candidate;
    if (!candidate) return dwellFloor;
    return candidate.getTime() < dwellFloor.getTime() ? dwellFloor : candidate;
  };

  if (
    (latestRun?.errorCode && INFRASTRUCTURE_ERROR_CODES.has(latestRun.errorCode)) ||
    PROCESS_LOST_MESSAGE_RE.test(text)
  ) {
    // Nothing to wait for beyond the anti-thrash floor: the process is gone and
    // the agent itself is healthy.
    const retryAt = notBefore(null);
    if (retryAt && retryAt.getTime() > now.getTime()) {
      return { recoverable: false, reason: "min_dwell_not_elapsed", retryAt };
    }
    return { recoverable: true, reason: "process_lost", retryAt: null };
  }

  const quotaByRun = latestRun?.errorFamily === "provider_quota" || latestRun?.errorCode === "provider_quota";
  if (!quotaByRun && !isProviderQuotaErrorText(text)) {
    return { recoverable: false, reason: "not_recoverable", retryAt: null };
  }

  // The quoted clock ("resets 10:10pm") is the *next* 10:10pm from the moment
  // the provider said it, so it resolves against the failure, not against now.
  // Resolving it against now is how a reset that has already happened reads as
  // one that is still 24 hours away — which is the latch this sweep exists to
  // break. With no failure time to anchor to we resolve against now and hold,
  // which is the conservative direction.
  const quotedResetAnchor = latestRun?.finishedAt ?? now;
  const retryAt =
    latestRun?.retryNotBefore ??
    // A bare clock with no zone is read as UTC: the server classifies runs from
    // every host it schedules, so the host's own zone means nothing here.
    parseProviderQuotaResetAt(text, quotedResetAnchor, { fallbackTimeZone: "UTC" }) ??
    // No reset we can trust. The calendar phrasings ("resets Aug 13, 12pm") are
    // deliberately not parsed — on 11 Aug that exact string was still being
    // quoted 4.5 hours after the limit had in fact cleared, and two days before
    // its claimed reset. Wait the default backoff from the failure instead, then
    // re-check by simply letting the agent run: if the limit is still binding
    // the next failure re-parks it with a fresh reset. That is a bounded retry
    // rather than an unbounded park.
    (latestRun?.finishedAt
      ? new Date(latestRun.finishedAt.getTime() + defaultQuotaBackoffMs)
      : null);

  // The buffer keeps us off the stated boundary: a provider that says 22:10
  // means the window is open *after* 22:10, not at it.
  const dueAt = notBefore(retryAt ? new Date(retryAt.getTime() + QUOTA_RESET_BUFFER_MS) : null);
  if (dueAt && dueAt.getTime() > now.getTime()) {
    return { recoverable: false, reason: "quota_not_reset", retryAt };
  }
  return { recoverable: true, reason: "provider_quota", retryAt };
}
