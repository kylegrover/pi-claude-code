import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { generateBranchSummary, generateSummary, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CLAUDE_CODE_MODELS } from "../src/model-catalog.ts";
import { buildExtraBody } from "../src/transcript.ts";
import { TurnRelay } from "../src/turn-relay.ts";
import type { AnthropicStreamEvent, NativeMessage } from "../src/native-types.ts";

const model = CLAUDE_CODE_MODELS.find(model => model.id === "claude-opus-5-5")!;
const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 4 };
function output(): AssistantMessage {
  return { role: "assistant", provider: model.provider, api: model.api, model: model.id,
    content: [], stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("real Pi branch and compaction summarizers serialize valid no-reasoning requests offline", async () => {
  let requests = 0;
  const streamFn: NonNullable<Parameters<typeof generateBranchSummary>[1]["streamFn"]> = (_model, _context, options) => {
    requests++;
    assert.equal(options?.reasoning, undefined);
    assert.deepEqual(buildExtraBody(model.id, [], options).thinking, { type: "adaptive" });
    const stream = createAssistantMessageEventStream();
    const message = output();
    message.content = [{ type: "text", text: "Offline summary." }];
    stream.push({ type: "done", reason: "stop", message }); stream.end();
    return stream;
  };
  const message = { role: "user" as const, content: "Preserve our project decisions.", timestamp: 0 };
  const entries: SessionEntry[] = [{ type: "message", id: "fixture", parentId: null, timestamp: new Date(0).toISOString(), message }];
  const branch = await generateBranchSummary(entries, { model, streamFn, signal: new AbortController().signal });
  assert.match(branch.summary ?? "", /Offline summary/);
  const compact = await generateSummary([message], model, undefined, undefined,
    undefined, undefined, undefined, undefined, "off", streamFn);
  assert.match(compact, /Offline summary/);
  assert.equal(requests, 2);
});

test("relay retains bounded actionable callback failures and still denies retry", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const message: NativeMessage = { role: "assistant", content: [], usage };
    response.end(`data: ${JSON.stringify({ type: "message_start", message })}\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const relay = new TurnRelay(`http://127.0.0.1:${address.port}`, 5000, () => {
    throw new Error(`translator failed for missing_tool\nBearer fake-credential sk-ant-fake-secret ${"x".repeat(700)}`);
  });
  try {
    const url = `${await relay.start()}/v1/messages`;
    await assert.rejects(async () => { const response = await fetch(url, { method: "POST", body: "{}" }); await response.text(); });
    await relay.settled();
    assert.match(relay.failure!, /^Error: translator failed for missing_tool/);
    assert.ok(relay.failure!.length <= 500);
    assert.doesNotMatch(relay.failure!, /fake-credential|sk-ant-fake-secret|\n/);
    assert.equal(relay.capture.complete, false);
    const retry = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(retry.status, 400);
    await retry.text();
    assert.equal(relay.denied, 1);
  } finally {
    await relay.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
