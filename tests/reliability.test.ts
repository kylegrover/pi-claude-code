import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { generateBranchSummary, generateSummary, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CLAUDE_CODE_MODELS, modelFromDiscovery, requiresAdaptiveThinking } from "../src/model-catalog.ts";
import { EventTranslator } from "../src/stream.ts";
import { buildExtraBody, prepareFrames, prepareReplayMessages, TOOL_PREFIX } from "../src/transcript.ts";
import { AnthropicCapture, TurnRelay } from "../src/turn-relay.ts";
import type { AnthropicStreamEvent, NativeMessage } from "../src/native-types.ts";

const model = CLAUDE_CODE_MODELS.find(model => model.id === "claude-opus-5-5")!;
const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 4 };
function output(): AssistantMessage {
  return { role: "assistant", provider: model.provider, api: model.api, model: model.id,
    content: [], stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

for (const incremental of [true, false]) {
  test(`unavailable Pi tool retains complete response, usage and replay (incremental=${incremental})`, () => {
    const result = output();
    const stream = createAssistantMessageEventStream();
    const translator = new EventTranslator(model, result, stream, new Set(["read"]));
    const capture = new AnthropicCapture(event => { if (incremental) translator.event(event); });
    const events: AnthropicStreamEvent[] = [
      { type: "message_start", message: { id: "msg_unknown", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_unknown", name: `${TOOL_PREFIX}missing_tool`, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"notes.md"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
      { type: "message_stop" },
    ];
    capture.feed(Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    capture.finish();
    assert.equal(capture.complete, true);
    translator.finish(capture.message!, usage);
    assert.equal(result.stopReason, "toolUse");
    assert.deepEqual(result.content, [{ type: "toolCall", id: "call_unknown", name: "missing_tool", arguments: { path: "notes.md" } }]);
    assert.equal(result.usage.cacheRead, 100);
    assert.equal(result.usage.output, 2);
    assert.ok(result.diagnostics?.some(item => item.type === "claude-code.unavailable-tool" && item.details?.name === "missing_tool"));
    const frames = prepareFrames(prepareReplayMessages([
      { role: "user", content: "inspect", timestamp: 0 }, result,
      { role: "toolResult", toolCallId: "call_unknown", toolName: "missing_tool", content: [{ type: "text", text: "Tool missing_tool not found" }], isError: true, timestamp: 1 },
    ], model));
    assert.deepEqual(frames[1]?.message.content, capture.message!.content);
    assert.equal((frames[2]?.message.content[0] as { tool_use_id: string }).tool_use_id, "call_unknown");
  });
}

test("non-Pi native tool names are still rejected", () => {
  const translator = new EventTranslator(model, output(), createAssistantMessageEventStream(), new Set(["read"]));
  assert.throws(() => translator.event({ type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id: "native", name: "Bash", input: {} } }), /unexpected tool Bash/);
});

test("summary requests respect models that explicitly disallow disabled thinking", () => {
  for (const id of ["claude-opus-5-5", "opus", "default", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-fable-5-1"]) {
    assert.equal(requiresAdaptiveThinking(id), true, id);
    for (const options of [undefined, {}, { maxTokens: 1024 }]) {
      const body = buildExtraBody(id, [], options);
      assert.deepEqual(body.thinking, { type: "adaptive" });
      assert.deepEqual(body.output_config, { effort: "low" });
      assert.equal(body.max_tokens, options?.maxTokens);
    }
    assert.deepEqual(buildExtraBody(id, [], { reasoning: "high" }).output_config, { effort: "high" });
  }
  // Adaptive support alone does not mean thinking off is forbidden.
  for (const id of ["claude-sonnet-5", "sonnet", "claude-haiku-4-5-20251001", "haiku", "unknown-model"]) {
    assert.equal(requiresAdaptiveThinking(id), false, id);
    assert.deepEqual(buildExtraBody(id, []).thinking, { type: "disabled" });
    assert.deepEqual(buildExtraBody(id, []).context_management, { edits: [] });
  }
  const discovered = modelFromDiscovery({ value: "test-opus-route", resolvedModel: "claude-opus-5-5",
    displayName: "fixture", description: "fixture", supportsAdaptiveThinking: true });
  assert.equal(requiresAdaptiveThinking(discovered.id), true);
});

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
