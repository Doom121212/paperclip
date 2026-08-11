/**
 * Provider-quota detection shared by every adapter lane.
 *
 * A quota refusal is not a turn failure: the work is fine, the account is out
 * of capacity until a stated reset. The server already has a full recovery
 * contract for that (wait for the reset, keep the assignee, suppress takeover)
 * — but it is keyed on an `errorCode` of `provider_quota`, so any lane that
 * reports its own generic failure code silently opts out of it and the agent
 * is parked until a human notices.
 *
 * This module holds the one copy of the match so the ACPX engine, the
 * per-CLI adapters and the server's recovery classifier cannot drift apart on
 * what counts as a quota refusal — the drift is what caused ORU-582: three
 * detectors, each missing a different half of the strings the provider
 * actually sends.
 *
 * Every alternative below is pinned by a fixture in `provider-quota.test.ts`
 * against a string a provider really emitted. Add the fixture first.
 */
export const PROVIDER_QUOTA_ERROR_RE =
  /(?:you(?:'|’)ve\s+(?:hit|reached)\s+your\s+(?:\w+\s+){0,3}?(?:session|weekly|usage|rate)\s+limit|(?:session|weekly|usage|opus|sonnet|5[-\s]?hour)\s+limit\s*(?:·|\||-|—|:)?\s*(?:reached|exceeded|resets?\b)|claude\s+usage\s+limit\s+reached|usage\s+(?:limit|cap)\s+reached|out\s+of\s+extra\s+usage|provider\s+quota|quota\s+(?:limit\s+)?exceeded|model\s+(?:is\s+)?at\s+capacity|servicequotaexceededexception)/i;

/**
 * True when `text` is a provider telling us the account is out of capacity.
 * Callers pass everything they have (error message, stop reason, stderr tail);
 * empty/nullish parts are ignored.
 */
export function isProviderQuotaErrorText(...parts: Array<string | null | undefined>): boolean {
  const text = joinParts(parts);
  if (!text) return false;
  return PROVIDER_QUOTA_ERROR_RE.test(text);
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n");
}

/**
 * The reset clause that follows a quota refusal. Two phrasings are in the
 * wild and both had a detector that only knew the other one:
 *
 *   "5-hour limit reached ∙ resets 10:10pm (Europe/Berlin)"
 *   "You've hit your usage limit. Try again at 3pm."
 *
 * Captures: (1) clock text, (2) parenthesised timezone, (3) bare timezone
 * abbreviation. A calendar reset ("resets Aug 13, 12pm") deliberately does
 * not match: a wrong day is worse than no parse, and an unparsed reset falls
 * back to the caller's default backoff, which re-checks rather than sleeps
 * until a date the provider may not honour.
 */
const PROVIDER_QUOTA_RESET_RE =
  /(?:resets?|try\s+again)\s*(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?)\s*(?:\(([^)]+)\)|\b([A-Z]{2,5})\b)?/i;

/**
 * Resolve the reset instant a quota message quotes, or `null` when it quotes
 * none we can trust. `now` is injected so this is testable and so a caller can
 * classify a historical run against the clock at the time it failed.
 *
 * `fallbackTimeZone` decides what a bare clock with no zone ("try again at
 * 3pm") means. An adapter runs on the same host the CLI printed the message
 * on, so it wants the host zone (the default); the server reads messages from
 * every host it schedules and reads them as UTC, which is what it has always
 * done.
 */
export function parseProviderQuotaResetAt(
  text: string,
  now: Date,
  options?: { fallbackTimeZone?: string | null },
): Date | null {
  const match = text.match(PROVIDER_QUOTA_RESET_RE);
  if (!match) return null;

  const clock = (match[1] ?? "").trim().replace(/\s+/g, " ");
  const clockMatch = clock.match(/^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?$/i);
  if (!clockMatch) return null;

  const hourValue = Number.parseInt(clockMatch[1] ?? "", 10);
  const minute = Number.parseInt(clockMatch[2] ?? "0", 10);
  const meridiem = (clockMatch[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;

  const timeZone =
    normalizeResetTimeZone(match[2] ?? match[3] ?? null) ??
    normalizeResetTimeZone(options?.fallbackTimeZone ?? null);
  return nextWallClockInstant({ now, hour, minute, timeZone });
}

const TIME_ZONE_ABBREVIATIONS: Record<string, string> = {
  UTC: "UTC",
  GMT: "UTC",
  Z: "UTC",
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  BST: "Europe/London",
  IST: "Asia/Kolkata",
};

function normalizeResetTimeZone(hint: string | null): string | null {
  const raw = hint?.trim();
  if (!raw) return null;
  const abbreviation = TIME_ZONE_ABBREVIATIONS[raw.toUpperCase()];
  if (abbreviation) return abbreviation;
  // An IANA name is the common case ("Europe/Berlin"); anything Intl refuses
  // is dropped rather than guessed, so we fall back to the host clock.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}

/**
 * The next instant whose wall clock in `timeZone` reads `hour:minute`, strictly
 * after `now`. With no timezone we use the host's, which is what a bare
 * "try again at 3pm" can honestly mean. DST is handled by converging on the
 * requested wall clock rather than assuming a fixed offset.
 */
function nextWallClockInstant(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZone: string | null;
}): Date | null {
  const { now, hour, minute, timeZone } = input;
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setDate(retryAt.getDate() + 1);
    return retryAt;
  }

  try {
    const wallClock = (date: Date) =>
      Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
          .formatToParts(date)
          .map((part) => [part.type, part.value]),
      );
    const nowParts = wallClock(now);
    const buildRetryAt = (dayOffset: number) => {
      const target = Date.UTC(
        Number(nowParts.year),
        Number(nowParts.month) - 1,
        Number(nowParts.day) + dayOffset,
        hour,
        minute,
      );
      let candidate = new Date(target);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = target - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}
