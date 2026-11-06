/**
 * Content-free fingerprint of the request body Claude Code sent upstream, so a prompt-cache miss
 * can be traced afterwards to the first part of the request that changed (or to nothing, which
 * points at timing/server-side causes). Stores short hashes only: no prompt text, tool output,
 * headers or credentials. `cache_control` markers are stripped before hashing (they move every
 * turn) and recorded separately as breakpoint positions.
 */
import { createHash } from "node:crypto";

export interface RequestFingerprint {
  v: 1;
  model?: string;
  /** One hash per system block. */
  system: string[];
  tools: string;
  toolCount: number;
  /** One hash per message, in order. */
  messages: string[];
  /** Positions carrying cache_control, e.g. "system.2", "messages.41.3". */
  breakpoints: string[];
  /** TTL of each breakpoint, parallel to `breakpoints` ("1h", "5m" or "default"). */
  ttls?: string[];
  /** Hash of `metadata` (Claude Code's per-process user/session id); never the value. */
  metadata?: string;
  /** Hash of the remaining top-level settings (thinking, max_tokens, ...), excluding metadata/stream. */
  other: string;
  bytes: number;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 12);

function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) if (key !== "cache_control") out[key] = stripCacheControl(child);
  return out;
}

const blocks = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
const marked = (value: unknown) => !!value && typeof value === "object" && "cache_control" in value;
const ttlOf = (value: unknown): string => {
  const control = (value as { cache_control?: { ttl?: unknown } }).cache_control;
  return typeof control?.ttl === "string" ? control.ttl : "default";
};

export function fingerprintRequest(body: Buffer | string | undefined): RequestFingerprint | undefined {
  if (!body) return undefined;
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(body.toString());
  } catch {
    return undefined;
  }
  if (!request || typeof request !== "object" || !Array.isArray(request.messages)) return undefined;
  const breakpoints: string[] = [];
  const ttls: string[] = [];
  const mark = (value: unknown, position: string) => {
    if (!marked(value)) return;
    breakpoints.push(position);
    ttls.push(ttlOf(value));
  };
  const system = blocks(request.system);
  system.forEach((block, i) => mark(block, `system.${i}`));
  const tools = Array.isArray(request.tools) ? request.tools : [];
  tools.forEach((tool, i) => mark(tool, `tools.${i}`));
  const messages = request.messages as Array<{ content?: unknown }>;
  messages.forEach((message, i) => {
    mark(message, `messages.${i}`);
    blocks(message?.content).forEach((block, j) => mark(block, `messages.${i}.${j}`));
  });
  const { messages: _m, system: _s, tools: _t, metadata: _md, stream: _st, ...other } = request;
  return {
    v: 1,
    model: typeof request.model === "string" ? request.model : undefined,
    system: system.map((block) => hash(stripCacheControl(block))),
    tools: hash(stripCacheControl(tools)),
    toolCount: tools.length,
    messages: messages.map((message) => hash(stripCacheControl(message))),
    breakpoints,
    ttls,
    ...(request.metadata === undefined ? {} : { metadata: hash(request.metadata) }),
    other: hash(other),
    bytes: Buffer.byteLength(body),
  };
}

/** First differing request part between two fingerprints, or undefined when b extends a unchanged. */
export function firstChange(a: RequestFingerprint, b: RequestFingerprint): string | undefined {
  if (a.model !== b.model) return "model";
  if (a.other !== b.other) return "settings";
  if (a.tools !== b.tools) return "tools";
  for (let i = 0; i < Math.max(a.system.length, b.system.length); i++) if (a.system[i] !== b.system[i]) return `system.${i}`;
  for (let i = 0; i < a.messages.length; i++) if (a.messages[i] !== b.messages[i]) return `messages.${i}`;
  return undefined;
}
