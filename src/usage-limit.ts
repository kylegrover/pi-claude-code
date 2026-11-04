/**
 * Claude plan usage limits (5-hour / weekly windows) as one readable, non-retryable error.
 *
 * A plan limit used to surface as "Incomplete Claude Code upstream response (status 429 ...
 * rate limit ...)". Pi's retry classifier treats "429"/"rate limit" as transient, so every
 * limited turn was retried and then compaction failed the same way. The reset time is known
 * (relay response headers, Claude Code's rate_limit_event, or the last window we saw), so
 * report it and let callers wait instead.
 */

import type { RateLimitInfo } from "./billing.ts";

export const USAGE_LIMIT_DIAGNOSTIC = "claude-code.usage-limit";
const NEAR_LIMIT = 0.9;

export interface UsageLimitDetails {
  /** Unix seconds when the limiting window resets, if known. */
  resetsAt?: number;
  /** "five_hour", "seven_day", ... when known. */
  limitType?: string;
  /** Where the reset time came from. */
  source?: "headers" | "rate-limit-event" | "last-window" | "message";
}

export class UsageLimitError extends Error {
  constructor(readonly details: UsageLimitDetails, now = Date.now()) {
    super(usageLimitMessage(details, now));
    this.name = "UsageLimitError";
  }
}

const LIMIT_NAMES: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet" };

/** One line, deliberately free of words Pi's retry classifier treats as transient. */
export function usageLimitMessage({ resetsAt, limitType }: UsageLimitDetails, now = Date.now()): string {
  const name = limitType ? ` (${LIMIT_NAMES[limitType] ?? limitType.replace(/_/gu, " ")})` : "";
  if (!resetsAt) return `Claude plan usage limit reached${name}; reset time unknown.`;
  const at = new Date(resetsAt * 1000);
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - now) / 60_000));
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const when = at.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
  const wait = minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `Claude plan usage limit reached${name}; resets ${when} (in ${wait}).`;
}

type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};
const seconds = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 1_000_000_000 ? Math.round(n) : undefined;
};

/** Anthropic's unified rate-limit headers on the relayed response. */
export function fromHeaders(headers: Headers): (UsageLimitDetails & { rejected: boolean }) | undefined {
  const status = header(headers, "anthropic-ratelimit-unified-status");
  const resetsAt = seconds(header(headers, "anthropic-ratelimit-unified-reset"));
  if (!status && !resetsAt) return undefined;
  return { rejected: status === "rejected", resetsAt, limitType: header(headers, "anthropic-ratelimit-unified-representative-claim") || undefined, source: "headers" };
}

// The most recent rate_limit_event in this Pi process (one Claude account per machine).
let lastWindow: RateLimitInfo | undefined;
export function rememberRateLimit(info: RateLimitInfo | undefined): void {
  if (info && typeof info === "object") lastWindow = info;
}
export function resetRememberedRateLimit(): void { lastWindow = undefined; }

/** The window closest to its limit in a rate_limit_event, for a 429 that carried no reset itself. */
function nearestWindow(info: RateLimitInfo | undefined, now: number): UsageLimitDetails | undefined {
  if (!info) return undefined;
  const windows = Object.entries((info.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number; status?: string }>);
  const top = windows
    .filter(([, w]) => seconds(w.resetsAt) && seconds(w.resetsAt)! * 1000 > now)
    .sort(([, a], [, b]) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
  if (top && ((top[1].utilization ?? 0) >= NEAR_LIMIT || top[1].status === "rejected")) {
    return { resetsAt: seconds(top[1].resetsAt), limitType: top[0], source: "last-window" };
  }
  const reset = seconds(info.resetsAt);
  if (reset && reset * 1000 > now && (info.status === "rejected" || ((info.utilization as number | undefined) ?? 0) >= NEAR_LIMIT)) {
    return { resetsAt: reset, limitType: info.rateLimitType, source: "last-window" };
  }
  return undefined;
}

/**
 * Classify a failed relayed turn. Returns details when it is a plan usage limit, otherwise
 * undefined so ordinary (retryable) errors keep their existing handling.
 */
export function classifyUsageLimit(input: {
  status?: number;
  errorText?: string;
  headers?: Headers;
  rateLimit?: RateLimitInfo;
  now?: number;
}): UsageLimitDetails | undefined {
  const now = input.now ?? Date.now();
  const fromEvent = input.rateLimit?.status === "rejected"
    ? { resetsAt: seconds(input.rateLimit.resetsAt), limitType: input.rateLimit.rateLimitType, source: "rate-limit-event" as const }
    : undefined;
  const h = input.headers ? fromHeaders(input.headers) : undefined;
  if (h?.rejected) return { resetsAt: h.resetsAt ?? fromEvent?.resetsAt, limitType: h.limitType ?? fromEvent?.limitType, source: "headers" };
  if (fromEvent) return fromEvent;
  const text = input.errorText ?? "";
  // Claude Code's own refusal text: "Claude AI usage limit reached|<unix seconds>".
  const piped = /usage limit reached\|(\d{10})/iu.exec(text);
  if (piped) return { resetsAt: Number(piped[1]), source: "message" };
  if (input.status !== 429 || !/rate.?limit|usage.?limit/iu.test(text)) return undefined;
  const window = nearestWindow(input.rateLimit, now) ?? nearestWindow(lastWindow, now);
  if (window) return window;
  // Anthropic's plan-limit wording; a plan limit even when no reset time is known.
  return /would exceed your account's rate limit|usage limit/iu.test(text) ? {} : undefined;
}
