import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintRequest, firstChange } from "../src/request-fingerprint.ts";

const body = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  model: "claude-opus-5-5", max_tokens: 32000, stream: true, metadata: { user_id: "secret-user" },
  system: [{ type: "text", text: "You are Claude Code." }, { type: "text", text: "SECRET SYSTEM PROMPT", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "Read", input_schema: {} }],
  messages: [
    { role: "user", content: [{ type: "text", text: "SECRET USER TEXT" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
  ],
  ...over,
}));

test("fingerprint holds hashes and positions only, never content or metadata", () => {
  const fp = fingerprintRequest(body())!;
  const text = JSON.stringify(fp);
  for (const secret of ["SECRET", "secret-user", "Claude Code", "Read"]) assert.ok(!text.includes(secret), secret);
  assert.equal(fp.system.length, 2);
  assert.equal(fp.messages.length, 3);
  assert.equal(fp.toolCount, 1);
  assert.deepEqual(fp.breakpoints, ["system.1", "messages.2.0"]);
  assert.ok(fp.messages.every((h) => /^[0-9a-f]{12}$/.test(h)));
  assert.match(fp.metadata!, /^[0-9a-f]{12}$/);
});

test("fingerprint records each breakpoint's TTL and a hash of metadata", () => {
  const msgs = JSON.parse(body().toString()).messages;
  msgs[2].content[0].cache_control = { type: "ephemeral", ttl: "1h" };
  const a = fingerprintRequest(body({ messages: msgs }))!;
  assert.deepEqual(a.ttls, ["default", "1h"]);
  const b = fingerprintRequest(body({ messages: msgs, metadata: { user_id: "other" } }))!;
  assert.notEqual(b.metadata, a.metadata);
  assert.equal(fingerprintRequest(body({ metadata: undefined }))!.metadata, undefined);
});

test("moving cache_control or changing metadata does not change hashes", () => {
  const a = fingerprintRequest(body())!;
  const msgs = JSON.parse(body().toString()).messages;
  delete msgs[2].content[0].cache_control;
  msgs[1].content[0].cache_control = { type: "ephemeral" };
  const b = fingerprintRequest(body({ messages: msgs, metadata: { user_id: "other" } }))!;
  assert.deepEqual(b.messages, a.messages);
  assert.equal(b.other, a.other);
  assert.equal(firstChange(a, b), undefined);
});

test("firstChange names the earliest part that differs; appended turns are not a change", () => {
  const a = fingerprintRequest(body())!;
  const msgs = JSON.parse(body().toString()).messages;
  const grown = fingerprintRequest(body({ messages: [...msgs, { role: "assistant", content: "more" }] }))!;
  assert.equal(firstChange(a, grown), undefined);
  msgs[1].content[0].text = "edited";
  assert.equal(firstChange(a, fingerprintRequest(body({ messages: msgs }))!), "messages.1");
  assert.equal(firstChange(a, fingerprintRequest(body({ system: [{ type: "text", text: "changed" }] }))!), "system.0");
  assert.equal(firstChange(a, fingerprintRequest(body({ tools: [] }))!), "tools");
  assert.equal(firstChange(a, fingerprintRequest(body({ max_tokens: 1 }))!), "settings");
});

test("non-JSON or non-message bodies give no fingerprint", () => {
  assert.equal(fingerprintRequest(undefined), undefined);
  assert.equal(fingerprintRequest(Buffer.from("not json")), undefined);
  assert.equal(fingerprintRequest(Buffer.from("{}")), undefined);
});
