import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeError } from "../src/stream.ts";
import { TurnRelay } from "../src/turn-relay.ts";
import {
  classifyUsageLimit, fromHeaders, rememberRateLimit, resetRememberedRateLimit, UsageLimitError, usageLimitMessage,
} from "../src/usage-limit.ts";

const NOW = Date.UTC(2026, 10, 2, 5, 0, 0);
const IN_16_MIN = Math.round(NOW / 1000) + 16 * 60;
const LIMIT_TEXT = "This request would exceed your account's rate limit. Please try again later.";

function failed(errorMessage: string): AssistantMessage {
  return { role: "assistant", content: [], api: "claude-code-stream-json", provider: "claude-code", model: "opus",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage, timestamp: 0 };
}

test("usage-limit message is one readable line that Pi does not retry", () => {
  const message = usageLimitMessage({ resetsAt: IN_16_MIN, limitType: "five_hour" }, NOW);
  assert.match(message, /^Claude plan usage limit reached \(5-hour\); resets .+ \(in 16 min\)\.$/);
  assert.equal(isRetryableAssistantError(failed(message)), false, "must not be auto-retried");
  assert.equal(normalizeError(new UsageLimitError({ resetsAt: IN_16_MIN }, NOW)), usageLimitMessage({ resetsAt: IN_16_MIN }, NOW));
  // The old text was retried by Pi on every turn:
  assert.equal(isRetryableAssistantError(failed(`Incomplete Claude Code upstream response (status 429, capture incomplete, upstream said: ${LIMIT_TEXT})`)), true);
  assert.match(usageLimitMessage({}, NOW), /reset time unknown/);
  assert.equal(isRetryableAssistantError(failed(usageLimitMessage({}, NOW))), false);
  assert.match(usageLimitMessage({ resetsAt: Math.round(NOW / 1000) + 3 * 3600 + 5 * 60, limitType: "seven_day" }, NOW), /\(weekly\).*in 3 h 5 min/);
});

test("classifier: headers, rate_limit_event, remembered window, and non-limit 429s", () => {
  resetRememberedRateLimit();
  const headers = { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(IN_16_MIN),
    "anthropic-ratelimit-unified-representative-claim": "five_hour" };
  assert.deepEqual(fromHeaders(headers), { rejected: true, resetsAt: IN_16_MIN, limitType: "five_hour", source: "headers" });
  assert.deepEqual(classifyUsageLimit({ status: 429, errorText: LIMIT_TEXT, headers, now: NOW }),
    { resetsAt: IN_16_MIN, limitType: "five_hour", source: "headers" });

  assert.deepEqual(classifyUsageLimit({ status: 429, errorText: LIMIT_TEXT, rateLimit: { status: "rejected", resetsAt: IN_16_MIN, rateLimitType: "seven_day" }, now: NOW }),
    { resetsAt: IN_16_MIN, limitType: "seven_day", source: "rate-limit-event" });

  rememberRateLimit({ status: "allowed_warning", resetsAt: IN_16_MIN, rateLimitType: "five_hour", utilization: 0.99,
    unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: IN_16_MIN, status: "allowed_warning" }, seven_day: { utilization: 0.4, resetsAt: IN_16_MIN + 86400 } } });
  assert.deepEqual(classifyUsageLimit({ status: 429, errorText: LIMIT_TEXT, now: NOW }),
    { resetsAt: IN_16_MIN, limitType: "five_hour", source: "last-window" });

  // A low-utilization remembered window is not evidence of a plan limit.
  resetRememberedRateLimit();
  rememberRateLimit({ status: "allowed", resetsAt: IN_16_MIN, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: IN_16_MIN } } });
  assert.deepEqual(classifyUsageLimit({ status: 429, errorText: LIMIT_TEXT, now: NOW }), {}, "low window: no reset guessed");

  // Ordinary failures are untouched.
  assert.equal(classifyUsageLimit({ status: 529, errorText: "overloaded_error: Overloaded", now: NOW }), undefined);
  assert.equal(classifyUsageLimit({ status: 200, errorText: "", headers: { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-reset": String(IN_16_MIN) }, now: NOW }), undefined);
  resetRememberedRateLimit();
});

test("relay keeps only rate-limit headers from a 429 and the classifier reads them", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    response.writeHead(429, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(IN_16_MIN), "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "retry-after": "960", "set-cookie": "secret=1", "x-other": "kept-out" });
    response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: LIMIT_TEXT } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const relay = new TurnRelay(`http://127.0.0.1:${address.port}`, 5_000);
  try {
    const response = await fetch(`${await relay.start()}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(response.status, 429);
    await response.text();
    await relay.settled();
    assert.equal(relay.errorText(), LIMIT_TEXT);
    assert.deepEqual(Object.keys(relay.rateLimitHeaders).sort(), [
      "anthropic-ratelimit-unified-representative-claim", "anthropic-ratelimit-unified-reset", "anthropic-ratelimit-unified-status", "retry-after"]);
    const limit = classifyUsageLimit({ status: relay.status, errorText: relay.errorText(), headers: relay.rateLimitHeaders, now: NOW });
    assert.deepEqual(limit, { resetsAt: IN_16_MIN, limitType: "five_hour", source: "headers" });
    relay.beginTurn();
    assert.deepEqual(relay.rateLimitHeaders, {}, "headers do not leak into the next turn");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("classifier: real saved 429 text, Claude Code's piped reset text, and unknown reset", () => {
  resetRememberedRateLimit();
  // Exact upstream 429 text observed in real Claude Code sessions.
  assert.deepEqual(classifyUsageLimit({ status: 429, errorText: LIMIT_TEXT, now: NOW }), {}, "plan limit, reset unknown");
  assert.match(usageLimitMessage({}, NOW), /^Claude plan usage limit reached; reset time unknown\.$/);
  assert.deepEqual(classifyUsageLimit({ status: 200, errorText: `Claude AI usage limit reached|${IN_16_MIN}`, now: NOW }),
    { resetsAt: IN_16_MIN, source: "message" });
  assert.equal(classifyUsageLimit({ status: 429, errorText: "Number of request tokens has exceeded your per-minute rate limit", now: NOW }), undefined,
    "short API throttles stay retryable");
});
