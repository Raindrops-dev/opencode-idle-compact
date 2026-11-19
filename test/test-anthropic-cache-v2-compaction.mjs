// Acceptance test for idle/finish compaction and native-warming coordination in
// index.js. OpenCode writes the summary. Offline: a fake plugin context.
// Provider/model names are deliberately fictional: the plugin must decide from catalog data and options only.
// Run: node scripts/test-anthropic-cache-v2-compaction.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import plugin from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "cache-compaction-"));
const MIN = 60_000;
const NATIVE = "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";

// ---- fictional catalog (shape of GET /api/model data entries) ----
const m = (providerID, id, cost, context) => ({ providerID, id, cost, limit: { context, output: 128000 } });
const c = (input, output, read, write, size) => ({ input, output, cache: { read, write }, ...(size ? { tier: { type: "context", size } } : {}) });
const CATALOG = [
  m("acme", "messages-pro", [c(3, 15, 0.3, 3.75)], 1_000_000), // Anthropic-style caching: bills cache writes
  m("acme", "flat-claude", [c(2, 10, 0.2, 0)], 1_000_000), // no cache-write price: TTL rewrite must not apply
  m("acme", "dirt-cheap", [c(0.1, 0.5, 0.01, 0)], 1_000_000),
  m("omni", "router-gpt", [c(2, 10, 0.2, 0), c(4, 20, 0.4, 0, 200000)], 1_050_000), // context-tiered price
  m("sub", "free", [], 1_000_000), // subscription: no per-token price
  m("nominal", "per-request", [c(3, 15, 0.3, 3.75)], 1_000_000), // nominal prices, but billed per request (flatRate)
  m("gate", "router-claude", [c(1, 5, 0.1, 1.25)], 200_000), // top-level cache marker route (topLevelCache)
  m("gate", "unpriced-router", [], 1_000_000), // topLevelCache route with no price: reaches the warm scope unpriced
  m("acme", "zero-cost", [c(0, 0, 0, 0)], 1_000_000), // priced at zero: economics apply (saving 0), not "unpriced"
  { ...m("omni", "native-compact", [c(2, 10, 0.2, 0)], 1_000_000), settings: { compaction: { type: "native" } } },
];
// The id the plugin must send for one idle stretch, written out from the spec (OpenCode's `Identifier.create(false, idleAt)`
// with counter 1, tail from sha256 instead of random bytes), not by calling the plugin.
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const hex12 = (idleAt) => ((BigInt(idleAt) * 4096n + 1n) & (2n ** 48n - 1n)).toString(16).padStart(12, "0");
const idleCompactID = (sessionID, idleAt) =>
  "msg_" + hex12(idleAt) + [...createHash("sha256").update(`${sessionID}:${idleAt}`).digest().subarray(0, 14)].map((b) => B62[b % 62]).join("");
const ref = (s) => { const i = s.indexOf("/"); return { providerID: s.slice(0, i), id: s.slice(i + 1) }; };

function fakeStorage(pageSize = 2) {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    set: async (k, v) => { map.set(k, structuredClone(v)); },
    remove: async (k) => { map.delete(k); },
    scan: async ({ prefix = "", after, limit = pageSize } = {}) => {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after ? keys.findIndex((k) => k > after) : 0;
      const slice = start < 0 ? [] : keys.slice(start, start + limit);
      const entries = slice.map((key) => ({ key, value: structuredClone(map.get(key)) }));
      return { entries, ...(start >= 0 && start + limit < keys.length ? { next: slice.at(-1) } : {}) };
    },
  };
}

async function harness(options = {}, { parents = {}, waitFor, genText, idleAt = {}, storage, location, compactFn, contextFn } = {}) {
  const logFile = join(dir, `log-${Math.random()}.jsonl`);
  const hooks = {}, generated = [], compacted = [], texts = [], waits = [], contexts = [];
  const ctx = {
    options: { logFile, flatRate: ["nominal/*"], topLevelCache: ["gate/*"], ...options },
    ...(location ? { location } : {}),
    ...(storage ? { storage } : {}),
    model: { list: async () => ({ location: { directory: "/x" }, data: CATALOG }) },
    generate: { text: async (input) => { texts.push(input); return genText ? genText(input) : { text: "SUMMARY" }; } },
    session: {
      hook: async (name, fn) => { hooks[name] = fn; },
      generate: async (input) => { generated.push(input); const r = ctx.onGenerate ? await ctx.onGenerate(input) : undefined; return r ?? { text: "" }; },
      compact: async (input) => { compacted.push(input); return compactFn ? compactFn(input) : {}; },
      ...(contextFn ? { context: async (input) => { contexts.push(input); return contextFn(input); } } : {}),
      get: async ({ sessionID }) => ({ id: sessionID, parentID: parents[sessionID], time: { created: 0, updated: 0, idle: idleAt[sessionID]?.() } }),
      wait: async ({ sessionID }) => { waits.push(sessionID); if (waitFor) await waitFor(sessionID); },
    },
  };
  const cleanup = await plugin.setup(ctx);
  const log = () => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } };
  return { hooks, generated, compacted, texts, waits, contexts, ctx, cleanup, log };
}

// A messages body of about `tokens` tokens (estimate = JSON chars / 4), optionally with explicit breakpoints.
const filler = (tokens) => "x".repeat(tokens * 4);
const body = (tokens, { breakpoints = true, extra = {} } = {}) => ({
  max_tokens: 32000, stream: true,
  system: [{ type: "text", text: "sys", ...(breakpoints ? { cache_control: { type: "ephemeral" } } : {}) }],
  messages: [{ role: "user", content: [{ type: "text", text: filler(tokens), ...(breakpoints ? { cache_control: { type: "ephemeral" } } : {}) }] }],
  ...extra,
});
const req = (b, headers = {}) => new Request("https://llm.example/v1/messages", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof b === "string" ? b : JSON.stringify(b),
});
const contextEvent = (sessionID, model, b) => ({ sessionID, agent: "build", model: ref(model), system: b.system, messages: b.messages, options: {}, tools: {} });
// One real agent step, in OpenCode's order: context hook, then the HTTP request, then the response.
async function turn(h, sessionID, model, b, headers, response = new Response("{}", { status: 200 })) {
  await h.hooks.context(contextEvent(sessionID, model, b));
  const e = { sessionID, kind: "primary", model: ref(model), request: req(b, headers) };
  await h.hooks["http.request"](e);
  await h.hooks["http.response"]({ ...e, response });
  return e;
}
const compactionEvent = (sessionID, model, b) => ({ ...contextEvent(sessionID, model, b), messages: [...b.messages, { role: "user", content: [{ type: "text", text: "SUMMARIZE-INSTRUCTION" }] }] });

// 0. no provider or model names in the plugin code (comments and the plugin's own ID excepted)
{
  const src = readFileSync(join(here, "../index.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replaceAll("anthropic-cache", "");
  const hit = src.match(/claude|anthropic|copilot|openrouter|mercury|deepseek|gemini|\bgpt|vertex|foundry|openai|grok|kimi|mimo|\bglm/i);
  assert.equal(hit, null, `hardcoded provider/model name in plugin code: ${hit?.[0]}`);
}

// 1. TTL rewrite is decided by the request body (explicit breakpoints) and the catalog (cache-write price)
{
  const h = await harness({ keepWarm: false });
  const ttlOf = async (e) => JSON.parse(await e.request.text()).system[0].cache_control?.ttl;
  assert.equal(await ttlOf(await turn(h, "t1", "acme/messages-pro", body(10))), "1h", "breakpoints + cache-write price -> 1h");
  const flat = await turn(h, "t2", "acme/flat-claude", body(10));
  assert.equal(await ttlOf(flat), undefined, "no cache-write price -> untouched");
  const unknown = await turn(h, "t3", "nowhere/unlisted", body(10));
  assert.equal(await ttlOf(unknown), undefined, "model not in catalog -> untouched");
  const top = await turn(h, "t4", "gate/router-claude", body(10, { breakpoints: false }));
  assert.deepEqual(JSON.parse(await top.request.text()).cache_control, { type: "ephemeral", ttl: "1h" }, "topLevelCache pattern -> top-level marker");
  const notTop = await turn(h, "t5", "acme/messages-pro", body(10, { breakpoints: false }));
  assert.equal(JSON.parse(await notTop.request.text()).cache_control, undefined, "no breakpoints and no topLevelCache match -> untouched");
  h.cleanup();
}

// 1b. Provider usage, not the context estimate, sets the final idle size.
{
  const usageResponse = (usage) => new Response(JSON.stringify({ usage }));
  const streamResponse = () => new Response([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_creation_input_tokens":19000,"cache_read_input_tokens":79000,"output_tokens":1}}}',
    'data: {"type":"message_delta","usage":{"output_tokens":1000}}',
    'data: [DONE]',
  ].join("\n"));
  for (const [scope, model, response] of [
    ["warm", "acme/messages-pro", streamResponse()],
    ["root", "omni/router-gpt", usageResponse({ prompt_tokens: 99000, completion_tokens: 1000 })],
    ["root", "sub/free", usageResponse({ input_tokens: 99000, output_tokens: 1000 })],
    ["root", "omni/router-gpt", new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":99000,"output_tokens":1000}}}\n\ndata: [DONE]\n')],
    ["child", "acme/messages-pro", usageResponse({ input_tokens: 1000, cache_read_input_tokens: 98000, output_tokens: 1000 })],
  ]) {
    const storage = fakeStorage();
    const h = await harness({ warmAfterMinutes: 400 / MIN, maxIdleMinutes: 120 / MIN, idleCompactMinutes: 120 / MIN, childIdleSeconds: 0.12, childResumeRate: 1 },
      { storage, parents: scope === "child" ? { measured: "parent" } : {} });
    await turn(h, "measured", model, body(10, { breakpoints: scope === "warm" }),
      scope === "child" ? { "x-parent-session-id": "parent" } : {}, response);
    await sleep(20);
    const savedTokens = storage.map.get("idle/measured")?.tokens;
    await sleep(150);
    assert.deepEqual(h.compacted, [{ sessionID: "measured", delivery: "queue" }], `${scope}: small estimate + usage at compactMinTokens -> compacted`);
    assert.equal(savedTokens, 100000, `${scope}: usage including reply persists even when estimate is below threshold`);
    assert.match(h.log(), new RegExp(`"compact.idle"[^\\n]*"scope":"${scope}"`));
    assert.doesNotMatch(h.log(), /"event":"usage"/, "debug false: usage still sizes the session without logging");
    h.cleanup();
  }
  // A child stream can outlast its idle timer; late usage must restore the check, not just its storage entry.
  {
    const storage = fakeStorage();
    let controller, release, idleSince;
    const busy = new Promise((r) => { release = r; });
    const h = await harness({ debug: true, childIdleSeconds: 0.08, childResumeRate: 1 },
      { storage, parents: { late: "parent" }, waitFor: () => busy, idleAt: { late: () => idleSince } });
    const response = new Response(new ReadableStream({ start(c) { controller = c; } }));
    await turn(h, "late", "acme/messages-pro", body(10), { "x-parent-session-id": "parent" }, response);
    await sleep(130);
    assert.match(h.log(), /"compact.skip"[^\n]*"sessionID":"late"[^\n]*"reason":"below compactMinTokens"/, "child timer fired before usage arrived");
    assert.equal(storage.map.has("idle/late"), false, "below-threshold child deadline was dropped");
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ usage: { input_tokens: 99000, output_tokens: 1000 } })));
    controller.close();
    await sleep(30);
    assert.equal(storage.map.get("idle/late")?.tokens, 100000, "late usage lifts child to compactMinTokens");
    assert.ok(storage.map.get("idle/late")?.due <= Date.now(), "late usage keeps the elapsed deadline");
    assert.equal(h.compacted.length, 0, "late usage cannot compact a still-busy child");
    idleSince = Date.now();
    release();
    await sleep(30);
    assert.equal(h.compacted.length, 0, "late usage still respects the quiet period after idle");
    await sleep(100);
    assert.deepEqual(h.compacted, [{ sessionID: "late", id: idleCompactID("late", idleSince), delivery: "queue" }], "child: timer skipped small estimate, then late usage -> compacted");
    assert.match(h.log(), /"reason":"busy: quiet period from time.idle"/);
    assert.equal(storage.map.has("idle/late"), false, "late child compaction removes the deadline");
    h.cleanup();
  }
  for (const scope of ["warm", "root"]) {
    const storage = fakeStorage();
    const h = await harness({ debug: true, warmAfterMinutes: 400 / MIN, maxIdleMinutes: 120 / MIN, idleCompactMinutes: 120 / MIN }, { storage });
    await turn(h, "smaller", "acme/messages-pro", body(150000, { breakpoints: scope === "warm" }), {}, usageResponse({ input_tokens: 49900, output_tokens: 100 }));
    await sleep(20);
    assert.equal(storage.map.has("idle/smaller"), false, `${scope}: usage below threshold removes estimated-large deadline`);
    await sleep(150);
    assert.equal(h.compacted.length, 0, `${scope}: large estimate + small real usage -> not compacted`);
    assert.match(h.log(), /"reason":"below compactMinTokens"/);
    assert.match(h.log(), /"event":"usage"[^\n]*"usage":\{"input_tokens":49900,"output_tokens":100\}/, "debug usage log unchanged");
    h.cleanup();
  }
  // Missing/malformed/all-zero usage keeps the estimate; unrelated generates cannot resize primary context.
  for (const response of [new Response("not JSON"), usageResponse({}), usageResponse({ input_tokens: "bad" }),
    usageResponse({ input_tokens: 0, output_tokens: 0 }), usageResponse({ prompt_tokens: 0, completion_tokens: 0 })]) {
    const h = await harness({ keepWarm: false, idleCompactMinutes: 80 / MIN });
    const e = await turn(h, "fallback", "omni/router-gpt", body(150000, { breakpoints: false }), {}, response);
    await h.hooks["http.response"]({ ...e, kind: "generate", response: usageResponse({ input_tokens: 1 }) });
    await sleep(130);
    assert.equal(h.compacted.length, 1, "unusable usage: chars/4 fallback still compacts");
    h.cleanup();
  }
  // A delayed clone read cannot overwrite a newer context, even though touch reuses the same track object.
  for (const later of ["context", "primary", "compaction", "unload"]) {
    const storage = fakeStorage();
    const h = await harness({ keepWarm: false, idleCompactMinutes: 5000 / MIN }, { storage });
    let controller;
    const delayed = new Response(new ReadableStream({ start(c) { controller = c; } }));
    const e = await turn(h, "stale", "omni/router-gpt", body(150000, { breakpoints: false }), {}, delayed);
    await sleep(10);
    if (later === "context") await h.hooks.context(contextEvent("stale", "omni/router-gpt", body(10, { breakpoints: false })));
    if (later === "primary") await turn(h, "stale", "omni/router-gpt", body(10, { breakpoints: false }));
    if (later === "compaction") await h.hooks.compaction(compactionEvent("stale", "omni/router-gpt", body(10)));
    if (later === "unload") h.cleanup();
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 200000 } })));
    controller.close();
    await sleep(20);
    if (later === "unload") assert.equal(storage.map.get("idle/stale")?.tokens < 200000, true, "unloaded instance cannot refresh persisted usage");
    else assert.equal(storage.map.has("idle/stale"), false, `${later}: old response cannot restore a removed deadline`);
    // An old response arriving after new activity must also be ignored before its body read starts.
    if (later === "primary") {
      await h.hooks["http.response"]({ ...e, response: usageResponse({ prompt_tokens: 200000 }) });
      await sleep(10);
      assert.equal(storage.map.has("idle/stale"), false, "old response headers after newer primary cannot resize it");
    }
    h.cleanup();
  }
  // Usage refreshes the persisted size without moving an already scheduled deadline (both root and warm).
  for (const scope of ["root", "warm"]) {
    const storage = fakeStorage();
    const h = await harness({ warmAfterMinutes: 50, maxIdleMinutes: 40, idleCompactMinutes: 30 }, { storage });
    const b = body(150000, { breakpoints: scope === "warm" });
    await h.hooks.context(contextEvent("due", "acme/messages-pro", b));
    const e = { sessionID: "due", kind: "primary", model: ref("acme/messages-pro"), request: req(b) };
    await h.hooks["http.request"](e);
    await sleep(10);
    const due = storage.map.get("idle/due")?.due;
    assert.equal(typeof due, "number");
    await h.hooks["http.response"]({ ...e, response: usageResponse({ input_tokens: 160000, output_tokens: 1000 }) });
    await sleep(10);
    assert.equal(storage.map.get("idle/due")?.tokens, 161000);
    assert.equal(storage.map.get("idle/due")?.due, due, `${scope}: usage does not restart the idle deadline`);
    h.cleanup();
  }
}

// 2. plugin-warmed session: native warms count as cache touches (after a successful response), carrier uses the
//    native prompt, final compaction lands at lastActive + maxIdle (not at the next tick), native re-warm vetoed after it.
//    Time unit U ms; margins of at least U between every deadline and its check.
{
  const U = 30;
  const h = await harness({ warmAfterMinutes: 4 * U / MIN, maxIdleMinutes: 9 * U / MIN, idleCompactMinutes: 3 * U / MIN });
  h.ctx.onGenerate = async ({ sessionID }) => {
    const e = { sessionID, kind: "generate", model: ref("acme/messages-pro"), request: req({ messages: [] }) };
    await h.hooks["http.request"](e);
    await h.hooks["http.response"]({ ...e, response: new Response("{}", { status: 200 }) });
  };
  await turn(h, "w1", "acme/messages-pro", body(150_000));
  await sleep(2 * U);
  // a native warm at ~2U (keep-alive prompt as the last user message): rewritten to 1h, re-arms the plugin timer
  const nb = body(150_000); nb.messages.push({ role: "user", content: [{ type: "text", text: NATIVE }] });
  const native = { sessionID: "w1", kind: "generate", model: ref("acme/messages-pro"), request: req(nb) };
  await h.hooks["http.request"](native);
  assert.equal(JSON.parse(await native.request.text()).system[0].cache_control.ttl, "1h", "native warm gets the 1h TTL");
  await h.hooks["http.response"]({ ...native, response: new Response("{}", { status: 200 }) });
  await sleep(3 * U); // ~5U: the original 4U tick must have moved to ~6U
  assert.equal(h.generated.length, 0, "plugin tick is re-armed after a successful native warm");
  await sleep(2 * U); // ~7U
  assert.equal(h.generated.length, 1, "plugin tick follows the native touch");
  assert.deepEqual(h.generated[0], { sessionID: "w1", prompt: NATIVE }, "carrier uses the native keep-alive prompt");
  assert.equal(h.compacted.length, 0, "no root idle compaction for a plugin-warmed session at idleCompactMinutes");
  await sleep(4 * U); // ~11U: second tick would be due at ~10U (touch 6U + 4U), but lastActive + maxIdle = 9U
  assert.deepEqual(h.compacted, [{ sessionID: "w1", delivery: "queue" }], "one queued compaction at lastActive + maxIdle");
  assert.equal(h.generated.length, 1, "compaction replaces the tick that would pass maxIdle");
  assert.match(h.log(), /"compact.idle"[^\n]*"scope":"warm"/);
  // after an idle compaction, OpenCode's native warming of the compacted session is vetoed before the network
  const again = { sessionID: "w1", kind: "generate", model: ref("acme/messages-pro"), request: req(nb) };
  await assert.rejects(h.hooks["http.request"](again), /idle-compacted/, "native re-warm after idle compaction is aborted");
  assert.match(h.log(), /"native.warm.vetoed"/);
  // real activity clears the veto
  await h.hooks.context(contextEvent("w1", "acme/messages-pro", body(10)));
  await h.hooks["http.request"]({ sessionID: "w1", kind: "generate", model: ref("acme/messages-pro"), request: req(nb) });
  h.cleanup();
}

// A native warm can re-arm the final tick while its first idle check is waiting.
{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness({ warmAfterMinutes: 200 / MIN, maxIdleMinutes: 30 / MIN, compactMinTokens: 1 },
    { waitFor: () => gate, idleAt: { duplicate: () => 0 } });
  try {
    const model = "acme/messages-pro";
    await turn(h, "duplicate", model, body(150_000));
    for (let i = 0; i < 100 && h.waits.length < 1; i++) await sleep(10);
    assert.equal(h.waits.length, 1, "first final tick is waiting");
    const nb = body(150_000); nb.messages.push({ role: "user", content: [{ type: "text", text: NATIVE }] });
    const native = { sessionID: "duplicate", kind: "generate", model: ref(model), request: req(nb) };
    await h.hooks["http.request"](native);
    await h.hooks["http.response"]({ ...native, response: new Response("{}", { status: 200 }) });
    for (let i = 0; i < 100 && h.waits.length < 2; i++) await sleep(10);
    assert.equal(h.waits.length, 2, "second final tick is waiting");
    release();
    await sleep(30);
    assert.deepEqual(h.compacted, [{ sessionID: "duplicate", id: idleCompactID("duplicate", 0), delivery: "queue" }], "overlapping final ticks compact once");
  } finally {
    release();
    h.cleanup();
  }
}

// 3. other root sessions: compaction after idleCompactMinutes, decided by catalog economics
{
  const run = async (model, tokens, options = {}, flags = {}) => {
    const h = await harness({ idleCompactMinutes: 40 / MIN, ...options }, flags);
    await turn(h, "r", model, body(tokens, { breakpoints: false }));
    await sleep(25);
    const early = h.compacted.length;
    await sleep(45);
    h.cleanup();
    return { ...h, early };
  };
  const big = await run("omni/router-gpt", 150_000);
  assert.equal(big.early, 0, "nothing before idleCompactMinutes");
  assert.deepEqual(big.compacted, [{ sessionID: "r", delivery: "queue" }], "priced root, large context -> compacted");
  assert.ok(big.waits.includes("r"), "waits for the session to be idle before compacting");
  assert.match(big.log(), /"compact.idle"[^\n]*"scope":"root"/);
  assert.equal((await run("omni/router-gpt", 50_000)).compacted.length, 0, "below compactMinTokens");
  assert.equal((await run("acme/dirt-cheap", 150_000)).compacted.length, 0, "saving below compactSaveMin for a cheap model");
  const free = await run("sub/free", 150_000);
  assert.deepEqual(free.compacted, [{ sessionID: "r", delivery: "queue" }], "unpriced (subscription) model: compacted on size (compactUnpriced default)");
  assert.equal((await run("sub/free", 150_000, { compactUnpriced: false })).compacted.length, 0, "unpriced model with compactUnpriced:false");
  assert.equal((await run("nominal/per-request", 150_000)).compacted.length, 0, "flatRate model");
  assert.equal((await run("omni/router-gpt", 150_000, { compactOnIdle: false })).compacted.length, 0, "compactOnIdle:false");
  // activity while waiting for idle cancels the compaction
  let release;
  const h = await harness({ idleCompactMinutes: 30 / MIN }, { waitFor: () => new Promise((r) => { release = r; }) });
  await turn(h, "busy", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await sleep(45); // timer fired, wait() pending (session busy, e.g. a long tool call)
  await h.hooks.context(contextEvent("busy", "omni/router-gpt", body(150_000, { breakpoints: false })));
  release();
  await sleep(10);
  assert.equal(h.compacted.length, 0, "new activity during the idle wait -> no compaction");
  h.cleanup();
}

// 4. subagent sessions: compact after the child finished, with the resume-rate economics
{
  const run = async (model, tokens, options = {}) => {
    const h = await harness({ childIdleSeconds: 0.04, ...options }, { parents: { k: "root1" } });
    await turn(h, "k", model, body(tokens, { breakpoints: false }), { "x-parent-session-id": "root1" });
    await sleep(70);
    h.cleanup();
    return h;
  };
  const sonnetLike = await run("acme/messages-pro", 150_000);
  assert.deepEqual(sonnetLike.compacted, [{ sessionID: "k", delivery: "queue" }], "expensive child -> compacted after finish");
  assert.match(sonnetLike.log(), /"compact.idle"[^\n]*"scope":"child"/);
  assert.equal((await run("acme/dirt-cheap", 150_000)).compacted.length, 0, "cheap child: expected saving too small");
  assert.equal((await run("nominal/per-request", 150_000)).compacted.length, 0, "flatRate child");
  assert.equal((await run("acme/messages-pro", 150_000, { childCompact: false })).compacted.length, 0, "childCompact:false");
  assert.equal((await run("acme/messages-pro", 150_000, { childResumeRate: 0.0001 })).compacted.length, 0, "childResumeRate drives the decision");
  assert.equal((await run("acme/messages-pro", 150_000, { childResumeRate: 0 })).compacted.length, 0, "childResumeRate 0 is honoured, not replaced by the default");
  // a re-prompt before the quiet period ends postpones the compaction
  const h = await harness({ childIdleSeconds: 0.05 }, { parents: { k2: "root1" } });
  await turn(h, "k2", "acme/messages-pro", body(150_000, { breakpoints: false }), { "x-parent-session-id": "root1" });
  await sleep(30);
  await turn(h, "k2", "acme/messages-pro", body(150_000, { breakpoints: false }), { "x-parent-session-id": "root1" });
  await sleep(35);
  assert.equal(h.compacted.length, 0, "quiet period restarted by new activity");
  await sleep(40);
  assert.equal(h.compacted.length, 1, "one compaction after the child is quiet");
  h.cleanup();
}

// 4b. unpriced models: size-only compaction in all three scopes, `basis: "size"` logged only for it
{
  const U = 25;
  const estimate = (b) => JSON.stringify({ system: b.system, messages: b.messages }).length / 4; // the plugin's estimate
  const exactOf = (scope) => estimate(body(150_000, { breakpoints: scope === "warm" }));
  const run = async (scope, model, options = {}) => {
    const flags = scope === "child" ? { parents: { u: "root1" } } : {};
    const h = await harness(scope === "child" ? { childIdleSeconds: 0.04, ...options }
      : scope === "root" ? { idleCompactMinutes: 40 / MIN, ...options }
      : { warmAfterMinutes: 8 * U / MIN, maxIdleMinutes: 2 * U / MIN, ...options }, flags);
    // warm: explicit breakpoints on a topLevelCache route make the session plugin-warmed; the others carry none
    await turn(h, "u", model, body(150_000, { breakpoints: scope === "warm" }), scope === "child" ? { "x-parent-session-id": "root1" } : {});
    await sleep(scope === "child" ? 70 : scope === "root" ? 85 : 100);
    h.cleanup();
    return h;
  };
  const MODELS = { root: ["sub/free", "nowhere/unlisted"], child: ["sub/free", "nowhere/unlisted"], warm: ["gate/unpriced-router", "gate/unlisted"] };
  for (const scope of ["root", "child", "warm"]) {
    for (const model of MODELS[scope]) { // empty cost, and model missing from the catalog
      const what = `${scope} ${model}`;
      const base = scope === "warm" ? { compactMinTokens: 1 } : {};
      const on = await run(scope, model, base);
      assert.deepEqual(on.compacted, [{ sessionID: "u", delivery: "queue" }], `${what}: unpriced, above compactMinTokens -> compacted`);
      assert.match(on.log(), new RegExp(`"compact.idle"[^\\n]*"scope":"${scope}"[^\\n]*"basis":"size"`), `${what}: basis size logged`);
      assert.equal((await run(scope, model, { compactMinTokens: exactOf(scope) })).compacted.length, 1, `${what}: exactly at compactMinTokens -> compacted`);
      const below = await run(scope, model, { compactMinTokens: exactOf(scope) + 1 });
      assert.equal(below.compacted.length, 0, `${what}: below compactMinTokens -> skipped`);
      assert.doesNotMatch(below.log(), /"compact.idle"/);
      const off = await run(scope, model, { ...base, compactUnpriced: false });
      assert.equal(off.compacted.length, 0, `${what}: compactUnpriced:false -> skipped`);
      assert.equal((await run(scope, model, { ...base, flatRate: [model] })).compacted.length, 0, `${what}: flatRate wins over compactUnpriced`);
    }
  }
  // priced models keep their economics and log no basis; a priced zero-cost entry is priced (saving 0 < compactSaveMin)
  const priced = await run("root", "omni/router-gpt");
  assert.equal(priced.compacted.length, 1);
  assert.doesNotMatch(priced.log(), /"basis"/, "priced decision: no basis field");
  const zero = await run("root", "acme/zero-cost");
  assert.equal(zero.compacted.length, 0, "priced zero-cost entry is not treated as unpriced");
  assert.equal((await run("root", "acme/zero-cost", { compactSaveMin: 0 })).compacted.length, 1, "priced zero-cost: economics decide (saving 0 >= 0)");
  assert.doesNotMatch((await run("root", "acme/zero-cost", { compactSaveMin: 0 })).log(), /"basis"/, "priced zero-cost: no basis field");
}

// 5. Neither plugin-requested nor other compactions supply a summary.
{
  const h = await harness({ idleCompactMinutes: 20 / MIN, warmSummary: false, coreCompactionWarm: true });
  const b = body(150_000, { breakpoints: false });
  await turn(h, "z", "omni/router-gpt", b);
  await sleep(40);
  assert.equal(h.compacted.length, 1, "plugin requested idle compaction");
  for (const sid of ["z", "other"]) {
    const event = compactionEvent(sid, "omni/router-gpt", b);
    await h.hooks.compaction(event);
    assert.equal(event.result, undefined, "compaction hook never sets event.result");
  }
  assert.equal(h.generated.length, 0, "compaction does not generate a summary");
  assert.doesNotMatch(h.log(), /error/i, "legacy option loads without errors");
  h.cleanup();
}

// Native warming preserves the real request frame.
{
  const h = await harness({ idleCompactMinutes: 20 / MIN, keepWarm: false });
  const genBody = (prompt) => ({ max_tokens: 1000, system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], messages: [...body(150_000).messages, { role: "assistant", content: [{ type: "text", text: "last reply" }] }, { role: "user", content: [{ type: "text", text: prompt }] }] });
  const real = body(150_000, { extra: { tools: [{ name: "read", input_schema: {}, cache_control: { type: "ephemeral" } }], thinking: { type: "adaptive" } } });
  real.system.push({ type: "text", text: "<voice_mode>added by another plugin</voice_mode>" });
  await turn(h, "fr", "acme/messages-pro", real);
    const nb = genBody(NATIVE);
    const nw = { sessionID: "fr", kind: "generate", model: ref("acme/messages-pro"), request: req(nb) };
    await h.hooks.context(contextEvent("fr", "acme/messages-pro", real)); // activity: lifts the idle-compacted veto
    await h.hooks["http.request"](nw);
    const nsent = JSON.parse(await nw.request.text());
    assert.equal(nsent.system[1]?.text, "<voice_mode>added by another plugin</voice_mode>", "native warm gets the frame");
    assert.equal(nsent.messages.at(-1).content[0].text, NATIVE);
    // a prefix field absent from the real request is removed from the generate too (absence is part of the prefix)
    const bare = body(150_000); // no tools, no thinking
    await turn(h, "nt", "acme/messages-pro", bare);
    const tg = genBody(NATIVE); tg.tools = [{ name: "extra", input_schema: {} }]; tg.thinking = { type: "enabled", budget_tokens: 1024 };
    const te = { sessionID: "nt", kind: "generate", model: ref("acme/messages-pro"), request: req(tg) };
    await h.hooks["http.request"](te);
    const tsent = JSON.parse(await te.request.text());
    assert.equal(tsent.tools, undefined, "tools absent from the real request -> removed from the generate");
    assert.equal(tsent.thinking, undefined, "thinking absent from the real request -> removed from the generate");
    assert.equal(tsent.max_tokens, 1000, "output controls still the generate's own");
    // a later real request that cannot be stored as a frame clears the old one: no stale prefix fields afterwards
    await h.hooks["http.request"]({ sessionID: "fr", kind: "primary", model: ref("acme/messages-pro"), request: req("not json") });
    const after = { sessionID: "fr", kind: "generate", model: ref("acme/messages-pro"), request: req(genBody(NATIVE)) };
    await h.hooks["http.request"](after);
    assert.equal(JSON.parse(await after.request.text()).system.length, 1, "stale frame cleared by an unstorable real request");
    await turn(h, "fr", "acme/messages-pro", real); // restore the frame for the cases below
    // a generate that itself chains server-side state is not swapped either
    const sg = genBody(NATIVE); sg.previous_response_id = "resp_9";
    const se = { sessionID: "fr", kind: "generate", model: ref("acme/messages-pro"), request: req(sg) }; // frame has 2 system blocks
    await h.hooks["http.request"](se);
    const ssent = JSON.parse(await se.request.text());
    assert.equal(ssent.system.length, 1, "no frame swap into a generate carrying previous_response_id");
    assert.equal(ssent.previous_response_id, "resp_9");
    // different route (URL) or chained server-side state: no frame swap
    const other = { sessionID: "fr", kind: "generate", model: ref("acme/messages-pro"), request: new Request("https://other.example/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(genBody(NATIVE)) }) };
    await h.hooks["http.request"](other);
    assert.equal(JSON.parse(await other.request.text()).system.length, 1, "no frame swap across routes");
    const chained = body(150_000, { extra: { previous_response_id: "resp_1" } });
    await turn(h, "ch", "acme/messages-pro", chained);
    const cg = { sessionID: "ch", kind: "generate", model: ref("acme/messages-pro"), request: req(genBody(NATIVE)) };
    await h.hooks["http.request"](cg);
    assert.equal(JSON.parse(await cg.request.text()).previous_response_id, undefined, "no frame swap when the real request chains server-side state");
    h.cleanup();
  }

// Pricing uses the core compaction setting.
{
  const defaults = await harness({ idleCompactMinutes: 20 / MIN });
  await turn(defaults, "c0", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await sleep(40);
  assert.equal(defaults.compacted.length, 1, "omitted coreCompactionWarm -> warm pricing for non-native model");
  defaults.cleanup();
  const native = await harness({ idleCompactMinutes: 20 / MIN });
  await turn(native, "cn", "omni/native-compact", body(150_000, { breakpoints: false }));
  await sleep(40);
  assert.equal(native.compacted.length, 0, "omitted coreCompactionWarm -> cold pricing for native model");
  native.cleanup();
  const cold = await harness({ idleCompactMinutes: 20 / MIN, coreCompactionWarm: false });
  await turn(cold, "c1", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await sleep(40);
  assert.equal(cold.compacted.length, 0, "cold pricing -> not worth it");
  cold.cleanup();
  const warm = await harness({ idleCompactMinutes: 20 / MIN, coreCompactionWarm: true });
  await turn(warm, "c2", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await sleep(40);
  assert.equal(warm.compacted.length, 1, "coreCompactionWarm:true -> warm pricing");
  warm.cleanup();
}

// 6. any compaction stops plugin warming and pending idle timers for that session
{
  const h = await harness({ warmAfterMinutes: 30 / MIN, maxIdleMinutes: 500 / MIN, idleCompactMinutes: 30 / MIN });
  const b = body(2000);
  await turn(h, "s", "acme/messages-pro", b);
  await h.hooks.compaction(compactionEvent("s", "acme/messages-pro", b));
  await turn(h, "g", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await h.hooks.compaction(compactionEvent("g", "omni/router-gpt", body(10, { breakpoints: false })));
  await sleep(60);
  assert.equal(h.generated.length, 0, "no warm after a compaction");
  assert.equal(h.compacted.length, 0, "no idle compaction after a compaction");
  h.cleanup();
}

// 7. timers (review fixes)
// 7a. the final tick checks activity since it was ARMED: a context event without a request (cancelled step) voids it;
//     the session then follows the normal root idle path
{
  const h = await harness({ warmAfterMinutes: 90 / MIN, maxIdleMinutes: 45 / MIN, idleCompactMinutes: 75 / MIN });
  await turn(h, "ft", "acme/messages-pro", body(150_000)); // plugin-warmed; final tick at 45 ms (warm would pass maxIdle)
  await sleep(20);
  await h.hooks.context(contextEvent("ft", "acme/messages-pro", body(150_000))); // activity at ~20 ms, request cancelled
  await sleep(50); // ~70 ms: the stale final tick fired at 45 ms
  assert.equal(h.compacted.length, 0, "stale final tick does not compact");
  await sleep(60); // ~130 ms: root idle timer from the context event (20 + 75 = 95 ms)
  assert.deepEqual(h.compacted, [{ sessionID: "ft", delivery: "queue" }], "root idle path takes over");
  assert.match(h.log(), /"compact.idle"[^\n]*"scope":"root"/);
  h.cleanup();
}
// 7b. the quiet period counts from idle: a session still busy when its timer fires gets a full quiet period after
//     the wait instead of compacting right away
{
  let first = true;
  const h = await harness({ childIdleSeconds: 0.04 }, { parents: { kb: "root1" }, waitFor: () => (first ? (first = false, sleep(60)) : undefined) });
  await turn(h, "kb", "acme/messages-pro", body(150_000, { breakpoints: false }), { "x-parent-session-id": "root1" });
  await sleep(120); // timer at 40, wait until ~100, re-armed to ~140
  assert.equal(h.compacted.length, 0, "no compaction right when the busy session became idle");
  await sleep(60); // ~180
  assert.equal(h.compacted.length, 1, "compaction one quiet period after idle");
  h.cleanup();
}
// 7c. native warm detection: only the exact keep-alive prompt as the LAST user message; a quoted copy elsewhere is not
//     a native warm (not vetoed, not a cache touch)
{
  const h = await harness({ idleCompactMinutes: 20 / MIN });
  await turn(h, "q2", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await sleep(40);
  assert.equal(h.compacted.length, 1, "idle-compacted");
  const qb = body(10); qb.messages.push({ role: "user", content: [{ type: "text", text: `quoted: ${NATIVE}` }] }, { role: "user", content: [{ type: "text", text: "something else" }] });
  await h.hooks["http.request"]({ sessionID: "q2", kind: "generate", model: ref("omni/router-gpt"), request: req(qb) });
  assert.doesNotMatch(h.log(), /"native.warm.vetoed"/, "a quoted keep-alive prompt is not a native warm");
  h.cleanup();
}
// 7d. a failed native warm does not count as a cache touch
{
  const h = await harness({ warmAfterMinutes: 60 / MIN, maxIdleMinutes: 600 / MIN });
  await turn(h, "nf", "acme/messages-pro", body(10));
  await sleep(20);
  const nb = body(10); nb.messages.push({ role: "user", content: [{ type: "text", text: NATIVE }] });
  const e = { sessionID: "nf", kind: "generate", model: ref("acme/messages-pro"), request: req(nb) };
  await h.hooks["http.request"](e);
  // an unrelated generate of the same session succeeds meanwhile: it must not count as the native warm's touch
  const other = { sessionID: "nf", kind: "generate", model: ref("acme/messages-pro"), request: req(body(10)) };
  await h.hooks["http.response"]({ ...other, response: new Response("{}", { status: 200 }) });
  await h.hooks["http.response"]({ ...e, response: new Response("{}", { status: 529 }) });
  await sleep(60); // ~80 ms: original tick at 60 ms must have fired (a touch at 20 would have moved it to 80+)
  assert.equal(h.generated.length, 1, "failed native warm did not move the plugin tick");
  h.cleanup();
}

// 7e. a context-only step (cancelled before its request) while an ordinary warm is pending also hands over to the
//     root idle path, like a stale final tick (7a)
{
  const h = await harness({ warmAfterMinutes: 60 / MIN, maxIdleMinutes: 6000 / MIN, idleCompactMinutes: 90 / MIN });
  await turn(h, "cw", "acme/messages-pro", body(150_000)); // plugin-warmed; first warm due at 60 ms
  await sleep(20);
  await h.hooks.context(contextEvent("cw", "acme/messages-pro", body(150_000))); // activity at ~20 ms, no request
  await sleep(70); // ~90 ms: the pending warm (60 ms) saw new activity
  assert.equal(h.generated.length, 0, "stale warm does not replay");
  await sleep(60); // ~150 ms: root idle timer from the context event (20 + 90 = 110 ms)
  assert.deepEqual(h.compacted, [{ sessionID: "cw", delivery: "queue" }], "root idle path takes over");
  assert.match(h.log(), /"compact.idle"[^\n]*"scope":"root"/);
  h.cleanup();
}

// 7f. an idle session's wait resolves asynchronously (in-process, a DB read, the Effect runtime): a few ms of wait latency
//     is not "busy". Busy = the wait itself took at least min(1 s, half the quiet period), measured from its own start
//     to its own resolution (catalog time excluded).
{
  const h = await harness({ idleCompactMinutes: 40 / MIN }, { waitFor: () => sleep(5) });
  await turn(h, "aw", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await sleep(80); // timer at 40, wait ~5 ms -> not busy -> compacts at ~45
  assert.deepEqual(h.compacted, [{ sessionID: "aw", delivery: "queue" }], "async idle wait still compacts");
  h.cleanup();
}

// 7g. exact quiet period from core's time.idle (when the session's last execution ended): a session that went idle
//     shortly before its timer fired is compacted one full quiet period after that idle time, not right away
{
  const t0 = Date.now();
  const h = await harness({ idleCompactMinutes: 60 / MIN }, { idleAt: { ti: () => t0 + 55 } });
  await turn(h, "ti", "omni/router-gpt", body(150_000, { breakpoints: false }));
  await sleep(90); // timer at 60; idle since 55 -> re-armed for the remainder (until ~115)
  assert.equal(h.compacted.length, 0, "not compacted 5 ms after the session became idle");
  await sleep(60); // ~150
  assert.deepEqual(h.compacted, [{ sessionID: "ti", id: idleCompactID("ti", t0 + 55), delivery: "queue" }], "compacted one quiet period after time.idle");
  h.cleanup();
}

// 8. maxIdleMinutes permits values below 24 hours; idleCompactMinutes keeps its exclusive 60-minute ceiling.
//    and cleanup logging (warm.stop reason "unload", compact.dropped count)
{
  const parseSetup = (h) => h.log().trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.event === "setup");
  {
    const h = await harness({ debug: true, idleCompactMinutes: 20 / MIN });
    await turn(h, "fired-idle", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(60);
    assert.equal(h.compacted.length, 1, "idle timer fired and queued compaction");
    h.cleanup();
    assert.doesNotMatch(h.log(), /"compact\.dropped"/, "already-fired idle timer is not counted as dropped on cleanup");
  }
  const d0 = await harness({ debug: true });
  assert.equal(parseSetup(d0).maxIdleMs, 50 * MIN, "default maxIdleMs is 50 min");
  assert.equal(parseSetup(d0).idleCompactMs, 30 * MIN, "default idleCompactMs is 30 min");
  d0.cleanup();
  assert.doesNotMatch(d0.log(), /"compact\.dropped"/, "no compact.dropped when no track timer was pending");
  for (const maxIdleMinutes of [60, 170, 1439]) {
    const d = await harness({ debug: true, maxIdleMinutes });
    assert.equal(parseSetup(d).maxIdleMs, maxIdleMinutes * MIN, `maxIdleMinutes ${maxIdleMinutes} accepted`);
    console.log(`maxIdleMinutes ${maxIdleMinutes}: maxIdleMs ${parseSetup(d).maxIdleMs}`);
    d.cleanup();
  }
  for (const maxIdleMinutes of [1440, 0, "170", NaN, Infinity]) {
    const d = await harness({ debug: true, maxIdleMinutes });
    assert.equal(parseSetup(d).maxIdleMs, 50 * MIN, `maxIdleMinutes ${maxIdleMinutes} falls back to 50 min`);
    console.log(`maxIdleMinutes ${typeof maxIdleMinutes === "string" ? JSON.stringify(maxIdleMinutes) : String(maxIdleMinutes)}: maxIdleMs ${parseSetup(d).maxIdleMs}`);
    d.cleanup();
  }
  for (const idleCompactMinutes of [90, 60]) {
    const d = await harness({ debug: true, idleCompactMinutes });
    assert.equal(parseSetup(d).idleCompactMs, 30 * MIN, `idleCompactMinutes ${idleCompactMinutes} falls back to 30 min`);
    d.cleanup();
  }
  const h = await harness();
  await turn(h, "w-unload", "acme/messages-pro", body(10));
  await turn(h, "r-unload", "omni/router-gpt", body(10, { breakpoints: false }));
  h.cleanup();
  const entries = h.log().trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.event === "warm.stop" && e.sessionID === "w-unload" && e.reason === "unload"), "cleanup logs warm.stop reason unload");
  assert.ok(entries.some((e) => e.event === "compact.dropped" && e.count >= 1), "cleanup logs compact.dropped with count >= 1");
}

// 9. persistent idle-compaction timers across plugin reload via ctx.storage
{
  const loc = { directory: "/proj/a", workspaceID: "ws1" };
  // (a) instance A arms a root session, cleanup runs before timer fires, instance B at same location restores and
  //     compacts after remaining time (not a full new period); compact.rearmed count 1 logged; (d) entry removed after
  {
    const storage = fakeStorage();
    const a = await harness({ idleCompactMinutes: 80 / MIN }, { storage, location: loc });
    await turn(a, "rearm-root", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(30);
    a.cleanup(); // ~50 ms remaining
    assert.equal(a.compacted.length, 0, "A unloaded before timer fired");

    // B has a huge idleCompactMinutes (5000 ms), so only the persisted due (~50 ms left) can fire in 90 ms
    const b = await harness({ idleCompactMinutes: 5000 / MIN }, { storage, location: loc });
    await sleep(20);
    assert.equal(b.compacted.length, 0, "not compacted before remaining time");
    await sleep(70);
    assert.deepEqual(b.compacted, [{ sessionID: "rearm-root", delivery: "queue" }], "B compacted after remaining time");
    assert.match(b.log(), /"event":"compact\.rearmed","count":1/, "compact.rearmed count 1 logged");
    assert.match(b.log(), /"compact\.idle"[^\n]*"scope":"root"/);
    // (d) after the plugin's own compaction (compact.idle) the entry is removed
    assert.equal(storage.map.has("idle/rearm-root"), false, "storage entry removed after compact.idle");
    b.cleanup();
  }
  // plugin-warmed session updates due to lastActive + maxIdleMs and restores with root scope
  {
    const storage = fakeStorage();
    const a = await harness({ warmAfterMinutes: 200 / MIN, maxIdleMinutes: 70 / MIN, idleCompactMinutes: 5000 / MIN }, { storage, location: loc });
    await turn(a, "rearm-warm", "acme/messages-pro", body(150_000));
    await sleep(20);
    a.cleanup(); // ~50 ms remaining until maxIdleMs (70 ms)
    const b = await harness({ idleCompactMinutes: 5000 / MIN }, { storage, location: loc });
    await sleep(80);
    assert.deepEqual(b.compacted, [{ sessionID: "rearm-warm", delivery: "queue" }], "formerly warmed session restored and compacted at maxIdleMs");
    assert.match(b.log(), /"compact\.idle"[^\n]*"scope":"root"/, "restored with root scope");
    assert.equal(storage.map.has("idle/rearm-warm"), false);
    b.cleanup();
  }
  // (b) instance B at a different ctx.location.directory (or workspaceID) does not restore it
  {
    const storage = fakeStorage();
    const a = await harness({ idleCompactMinutes: 40 / MIN }, { storage, location: loc });
    await turn(a, "other-dir", "omni/router-gpt", body(150_000, { breakpoints: false }));
    a.cleanup();
    const b = await harness({ idleCompactMinutes: 40 / MIN }, { storage, location: { directory: "/proj/b", workspaceID: "ws1" } });
    const bWs = await harness({ idleCompactMinutes: 40 / MIN }, { storage, location: { directory: "/proj/a", workspaceID: "ws2" } });
    await sleep(70);
    assert.equal(b.compacted.length, 0, "different directory does not restore");
    assert.doesNotMatch(b.log(), /"compact\.rearmed"/);
    assert.equal(bWs.compacted.length, 0, "different workspaceID does not restore");
    assert.ok(storage.map.has("idle/other-dir"), "foreign entry left untouched in shared storage");
    b.cleanup(); bWs.cleanup();
  }
  // (c) a stale entry (due more than 60 min ago) is removed and not compacted
  {
    const storage = fakeStorage();
    await storage.set("idle/stale", { dir: loc.directory, ws: loc.workspaceID, child: false, model: ref("omni/router-gpt"), tokens: 150_000, due: Date.now() - 60 * MIN - 1000 });
    const b = await harness({ idleCompactMinutes: 40 / MIN }, { storage, location: loc });
    await sleep(50);
    assert.equal(b.compacted.length, 0, "stale entry not compacted");
    assert.equal(storage.map.has("idle/stale"), false, "stale entry removed from storage");
    assert.doesNotMatch(b.log(), /"compact\.rearmed"/);
    b.cleanup();
  }
  // (e) child session restores with child scope (and pagination across >pageSize entries works); onCompaction removes entry
  {
    const storage = fakeStorage(1); // page size 1 forces `next` cursor pagination
    const a = await harness({ childIdleSeconds: 0.08, idleCompactMinutes: 5000 / MIN }, { storage, location: loc, parents: { k1: "r", k2: "r" } });
    await turn(a, "k1", "acme/messages-pro", body(150_000, { breakpoints: false }), { "x-parent-session-id": "r" });
    await turn(a, "k2", "acme/messages-pro", body(150_000, { breakpoints: false }), { "x-parent-session-id": "r" });
    await hCompactionCheck(a, storage);
    await sleep(20);
    a.cleanup();
    const b = await harness({ childIdleSeconds: 5, idleCompactMinutes: 5000 / MIN }, { storage, location: loc, parents: { k1: "r" } });
    await sleep(100);
    assert.deepEqual(b.compacted, [{ sessionID: "k1", delivery: "queue" }], "child session restored and compacted");
    assert.match(b.log(), /"event":"compact\.rearmed","count":1/);
    assert.match(b.log(), /"compact\.idle"[^\n]*"scope":"child"/, "child restores with child scope");
    b.cleanup();
  }
  async function hCompactionCheck(h, storage) {
    await sleep(5);
    assert.ok(storage.map.has("idle/k2"));
    await h.hooks.compaction(compactionEvent("k2", "acme/messages-pro", body(10, { breakpoints: false })));
    await sleep(5);
    assert.equal(storage.map.has("idle/k2"), false, "onCompaction removes idle/<id>");
  }
  // (g) review round 1 regressions: (1) core compaction during scan does not re-arm; (2) stale scan snapshot does not
  //     drop a fresh live deadline; (3) per-session storage serialization prevents delayed context set from overwriting
  //     warmed primary set or resurrecting after onCompaction remove; (4) below-compactMinTokens not saved, and terminal
  //     economics skip drops persisted entry.
  {
    const holdScan = (s) => {
      let release;
      const page = { entries: [...s.map].map(([key, value]) => ({ key, value: structuredClone(value) })) };
      s.scan = () => new Promise((r) => { release = () => r(page); });
      return () => release();
    };
    // 1. core compaction during scan of an otherwise untracked session
    {
      const storage = fakeStorage();
      await storage.set("idle/core-race", { dir: loc.directory, ws: loc.workspaceID, child: false, model: ref("omni/router-gpt"), tokens: 150_000, due: Date.now() });
      const release = holdScan(storage);
      const h = await harness({ idleCompactMinutes: 40 / MIN }, { storage, location: loc });
      await h.hooks.compaction(compactionEvent("core-race", "omni/router-gpt", body(10, { breakpoints: false })));
      await sleep(5);
      assert.equal(storage.map.has("idle/core-race"), false);
      release();
      await sleep(50);
      assert.equal(h.compacted.length, 0, "compaction during scan suppresses restore");
      h.cleanup();
    }
    // 2. stale scan snapshot versus concurrent live context activity
    {
      const storage = fakeStorage();
      await storage.set("idle/stale-race", { dir: loc.directory, ws: loc.workspaceID, child: false, model: ref("omni/router-gpt"), tokens: 150_000, due: Date.now() - 60 * MIN - 1000 });
      const release = holdScan(storage);
      const h = await harness({ idleCompactMinutes: 80 / MIN }, { storage, location: loc });
      await h.hooks.context(contextEvent("stale-race", "omni/router-gpt", body(150_000, { breakpoints: false })));
      release();
      await sleep(20);
      assert.ok(storage.map.has("idle/stale-race"), "stale scan snapshot must not delete fresh live deadline");
      h.cleanup();
    }
    // 3. per-session serialized storage ops: delayed context set vs warmed primary set, and vs onCompaction remove
    {
      const storage = fakeStorage();
      let first = true, release;
      const origSet = storage.set;
      storage.set = (k, v) => {
        if (first) { first = false; const copy = structuredClone(v); return new Promise((r) => { release = async () => { await origSet(k, copy); r(); }; }); }
        return origSet(k, v);
      };
      const h = await harness({ idleCompactMinutes: 40 / MIN, maxIdleMinutes: 200 / MIN, warmAfterMinutes: 300 / MIN }, { storage, location: loc });
      const t0 = Date.now();
      const b = body(150_000);
      await h.hooks.context(contextEvent("write-order", "acme/messages-pro", b));
      await h.hooks["http.request"]({ sessionID: "write-order", kind: "primary", model: ref("acme/messages-pro"), request: req(b) });
      await release();
      await sleep(10);
      assert.ok(storage.map.get("idle/write-order")?.due >= t0 + 180, "warmed primary deadline not overwritten by earlier context set");
      h.cleanup();

      const storage2 = fakeStorage();
      let release2;
      const origSet2 = storage2.set;
      storage2.set = (k, v) => { const copy = structuredClone(v); return new Promise((r) => { release2 = async () => { await origSet2(k, copy); r(); }; }); };
      const h2 = await harness({ idleCompactMinutes: 40 / MIN }, { storage: storage2, location: loc });
      await h2.hooks.context(contextEvent("write-remove", "omni/router-gpt", body(150_000, { breakpoints: false })));
      await h2.hooks.compaction(compactionEvent("write-remove", "omni/router-gpt", body(10, { breakpoints: false })));
      await release2();
      await sleep(10);
      assert.equal(storage2.map.has("idle/write-remove"), false, "onCompaction remove ordered after earlier context set");
      h2.cleanup();
    }
    // 4. growth: below-compactMinTokens not saved; terminal economics skip (why) drops persisted entry
    {
      const storage = fakeStorage();
      const h = await harness({ idleCompactMinutes: 30 / MIN }, { storage, location: loc });
      await turn(h, "small-ctx", "omni/router-gpt", body(10, { breakpoints: false }));
      await turn(h, "small-warm", "acme/messages-pro", body(10));
      await sleep(10);
      assert.equal(storage.map.size, 0, "sessions below compactMinTokens do not persist idle entries");
      await turn(h, "cheap-skip", "acme/dirt-cheap", body(150_000, { breakpoints: false }));
      await sleep(10);
      assert.equal(storage.map.has("idle/cheap-skip"), true, "above compactMinTokens saved on arm");
      await sleep(50);
      assert.equal(h.compacted.length, 0);
      assert.equal(storage.map.has("idle/cheap-skip"), false, "terminal economics skip drops persisted entry");
      h.cleanup();
    }
    // 4b. below-threshold context removes an armed idle deadline; busy re-arm persists the remaining quiet window
    {
      const storage = fakeStorage();
      const h = await harness({ idleCompactMinutes: 40 / MIN }, { storage, location: loc });
      await turn(h, "drop-below", "omni/router-gpt", body(150_000, { breakpoints: false }));
      await sleep(10);
      assert.ok(storage.map.has("idle/drop-below"), "large context saves an idle deadline");
      await h.hooks.context(contextEvent("drop-below", "omni/router-gpt", body(10, { breakpoints: false })));
      await sleep(10);
      assert.equal(storage.map.has("idle/drop-below"), false, "below threshold clears the persisted idle deadline");
      h.cleanup();

      const storage2 = fakeStorage();
      const t0 = Date.now();
      const h2 = await harness({ idleCompactMinutes: 60 / MIN }, { storage: storage2, location: loc, idleAt: { "busy-rearm": () => t0 + 55 } });
      await turn(h2, "busy-rearm", "omni/router-gpt", body(150_000, { breakpoints: false }));
      const original = storage2.map.get("idle/busy-rearm")?.due;
      assert.ok(typeof original === "number", "busy session initially stores a deadline");
      await sleep(90);
      const due = storage2.map.get("idle/busy-rearm")?.due;
      assert.ok(typeof due === "number" && due > original, "busy re-arm updates the stored deadline to the remaining quiet window");
      h2.cleanup();
    }
  }
}

// 10. rootCompact: false stops root-scope idle compaction only: warm and
//     child compaction stay, a restored warm deadline still fires, a restored root deadline does not.
{
  const loc = { directory: "/proj/rc", workspaceID: "ws1" };
  // (a) root session: nothing compacted with rootCompact:false; still compacted with the default
  const root = async (options) => {
    const h = await harness({ idleCompactMinutes: 40 / MIN, ...options });
    await turn(h, "r", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(80);
    h.cleanup();
    return h;
  };
  assert.equal((await root({ rootCompact: false })).compacted.length, 0, "rootCompact:false -> no root compaction");
  assert.equal((await root({})).compacted.length, 1, "rootCompact default true -> root compacted");
  // (b) child session still compacted with rootCompact:false
  {
    const h = await harness({ childIdleSeconds: 0.04, rootCompact: false }, { parents: { k: "root1" } });
    await turn(h, "k", "acme/messages-pro", body(150_000), { "x-parent-session-id": "root1" });
    await sleep(80);
    h.cleanup();
    assert.deepEqual(h.compacted, [{ sessionID: "k", delivery: "queue" }], "rootCompact:false keeps child compaction");
  }
  // (c) plugin-warmed session still gets its final warm compaction with rootCompact:false
  {
    const h = await harness({ warmAfterMinutes: 200 / MIN, maxIdleMinutes: 50 / MIN, idleCompactMinutes: 5000 / MIN, rootCompact: false });
    await turn(h, "w", "acme/messages-pro", body(150_000));
    await sleep(90);
    h.cleanup();
    assert.deepEqual(h.compacted, [{ sessionID: "w", delivery: "queue" }], "rootCompact:false keeps warm compaction");
    assert.match(h.log(), /"compact.idle"[^\n]*"scope":"warm"/);
  }
  // (d) reload: a warm deadline saved by A is restored and fires in B with rootCompact:false; a root one is not
  {
    const storage = fakeStorage();
    const a = await harness({ warmAfterMinutes: 200 / MIN, maxIdleMinutes: 70 / MIN, idleCompactMinutes: 80 / MIN }, { storage, location: loc });
    await turn(a, "rc-warm", "acme/messages-pro", body(150_000));
    await turn(a, "rc-root", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(20);
    a.cleanup();
    const b = await harness({ idleCompactMinutes: 5000 / MIN, rootCompact: false }, { storage, location: loc });
    await sleep(110);
    b.cleanup();
    assert.deepEqual(b.compacted, [{ sessionID: "rc-warm", delivery: "queue" }], "restored warm deadline fires; restored root deadline does not");
  }
}

// 11. excludeSessions: excluded sessions (root, warm, child, or restored from storage) are never compacted by the
//     plugin, have their idle deadlines dropped, and still receive prompt cache TTL and keep-warm; non-excluded
//     sessions in the same run still compact; non-array / non-string option entries are ignored.
{
  const loc = { directory: "/proj/ex", workspaceID: "ws1" };
  // (a) excluded root + warm session vs non-excluded sessions in the same run; TTL and keep-warm still apply;
  //     invalid option values are ignored
  {
    const U = 25;
    const storage = fakeStorage();
    const h = await harness(
      { warmAfterMinutes: 2 * U / MIN, maxIdleMinutes: 5 * U / MIN, idleCompactMinutes: 2 * U / MIN, excludeSessions: ["ex-root", "ex-warm", "", 42, null] },
      { storage, location: loc },
    );
    h.ctx.onGenerate = async ({ sessionID }) => {
      const e = { sessionID, kind: "generate", model: ref("acme/messages-pro"), request: req({ messages: [] }) };
      await h.hooks["http.request"](e);
      await h.hooks["http.response"]({ ...e, response: new Response("{}", { status: 200 }) });
    };
    await turn(h, "ex-root", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await turn(h, "ok-root", "omni/router-gpt", body(150_000, { breakpoints: false }));
    const warmTurn = await turn(h, "ex-warm", "acme/messages-pro", body(150_000));
    assert.equal(JSON.parse(await warmTurn.request.text()).system[0].cache_control.ttl, "1h", "excluded session still gets 1h cache TTL");
    await turn(h, "ok-warm", "acme/messages-pro", body(150_000));
    await sleep(10);
    assert.equal(storage.map.has("idle/ex-root"), false, "excluded root deadline not persisted");
    assert.equal(storage.map.has("idle/ex-warm"), false, "excluded warm deadline not persisted");
    assert.equal(storage.map.has("idle/ok-root"), true, "non-excluded root deadline persisted");
    await sleep(7 * U);
    h.cleanup();
    assert.ok(h.generated.some((g) => g.sessionID === "ex-warm"), "excluded warm session still gets keep-warm replay");
    const ids = h.compacted.map((c) => c.sessionID).sort();
    assert.deepEqual(ids, ["ok-root", "ok-warm"], "excluded root and warm sessions not compacted; non-excluded sessions compacted");
    assert.match(h.log(), /"event":"compact\.excluded","sessionID":"ex-root"/, "compact.excluded logged for excluded session");
  }
  // (b) excluded child session is not compacted; non-excluded child in the same run is; non-array excludeSessions ignored
  {
    const h = await harness(
      { childIdleSeconds: 0.04, excludeSessions: ["ex-child"] },
      { parents: { "ex-child": "r1", "ok-child": "r1" } },
    );
    await turn(h, "ex-child", "acme/messages-pro", body(150_000, { breakpoints: false }), { "x-parent-session-id": "r1" });
    await turn(h, "ok-child", "acme/messages-pro", body(150_000, { breakpoints: false }), { "x-parent-session-id": "r1" });
    await sleep(80);
    h.cleanup();
    assert.deepEqual(h.compacted, [{ sessionID: "ok-child", delivery: "queue" }], "excluded child not compacted; non-excluded child compacted");
    const bad = await harness({ idleCompactMinutes: 30 / MIN, excludeSessions: "not-an-array" });
    await turn(bad, "not-an-array", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(60);
    bad.cleanup();
    assert.equal(bad.compacted.length, 1, "non-array excludeSessions is ignored");
  }
  // (c) restored persisted deadline for an excluded session does not fire and is dropped from storage
  {
    const storage = fakeStorage();
    const a = await harness({ idleCompactMinutes: 80 / MIN }, { storage, location: loc });
    await turn(a, "rearm-ex", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await turn(a, "rearm-ok", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(20);
    a.cleanup();
    assert.equal(storage.map.has("idle/rearm-ex"), true, "persisted before exclusion");
    const b = await harness({ idleCompactMinutes: 5000 / MIN, excludeSessions: ["rearm-ex"] }, { storage, location: loc });
    await sleep(90);
    b.cleanup();
    assert.deepEqual(b.compacted, [{ sessionID: "rearm-ok", delivery: "queue" }], "restored excluded session does not fire; non-excluded does");
    assert.equal(storage.map.has("idle/rearm-ex"), false, "excluded session's persisted deadline dropped on restore");
  }
}

// 11. one compaction per idle stretch across processes. The id of a compaction is derived from the session and its
//     time.idle, so a second process that fires the same persisted deadline sends the same id and core admits it once.
const events = (h) => h.log().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
// A fake of core's admitCompaction: a held id returns its item; once delivered, the same id is a conflict. Like the real
// plugin API (`packages/plugin/src/promise/adapter.ts`), `compact` returns the admitted item and `context` the message
// array themselves, with no `{ data }` wrapper.
function fakeCore() {
  const core = { items: new Map(), delivered: new Set(), admitted: 0, messages: [] };
  core.compact = async ({ sessionID, id }) => {
    if (core.delivered.has(id)) throw Object.assign(new Error(""), { _tag: "Session.CompactionConflictError", sessionID, inputID: id });
    if (!core.items.has(id)) { core.items.set(id, { id, type: "compaction" }); core.admitted += 1; }
    return core.items.get(id);
  };
  core.context = async () => core.messages;
  return core;
}
{
  const loc = { directory: "/proj/x-process", workspaceID: "ws1" };
  const idle0 = Date.now() - 5000; // idle long before the deadline: no busy re-arm
  // A. two processes, one storage, one core. The first compacts and its item is delivered; the second then fires the same
  //    deadline: same id, nothing admitted twice, logged as a duplicate, not a failure.
  for (const delivered of [true, false]) {
    const core = fakeCore(), storage = fakeStorage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h1 = await harness({ idleCompactMinutes: 80 / MIN }, { storage, location: loc, compactFn: core.compact, idleAt: { dup: () => idle0 } });
    await turn(h1, "dup", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(15);
    const h2 = await harness({ idleCompactMinutes: 80 / MIN }, { storage, location: loc, compactFn: core.compact, idleAt: { dup: () => idle0 }, waitFor: () => gate });
    await sleep(15);
    assert.match(h2.log(), /"compact.rearmed"/, "the second process restored the first one's persisted deadline");
    for (let i = 0; i < 100 && h1.compacted.length < 1; i++) await sleep(10);
    assert.equal(h1.compacted.length, 1, "first process compacted");
    if (delivered) for (const id of core.items.keys()) core.delivered.add(id);
    release();
    for (let i = 0; i < 100 && h2.compacted.length < 1; i++) await sleep(10);
    assert.equal(h2.compacted.length, 1, "second process fired the same deadline");
    await sleep(20);
    const want = idleCompactID("dup", idle0);
    assert.deepEqual(h2.compacted, [{ sessionID: "dup", id: want, delivery: "queue" }]);
    assert.deepEqual(h1.compacted, h2.compacted, "both processes send the identical id");
    assert.equal(core.admitted, 1, "exactly one compaction admitted");
    const e1 = events(h1).filter((e) => e.event.startsWith("compact.") && e.sessionID === "dup");
    const e2 = events(h2).filter((e) => e.event.startsWith("compact.") && e.sessionID === "dup");
    assert.deepEqual(e1.map((e) => e.event), ["compact.idle"]);
    assert.equal(e1[0].inboxID, want, "D: compact.idle carries the returned item's id");
    if (delivered) {
      assert.deepEqual(e2.map((e) => e.event), ["compact.duplicate"], "delivered: logged as a duplicate, not a failure");
      assert.deepEqual({ ...e2[0], t: undefined, pid: undefined }, { t: undefined, pid: undefined, event: "compact.duplicate", sessionID: "dup", scope: "root", inboxID: want });
    } else {
      assert.deepEqual(e2.map((e) => e.event), ["compact.idle"], "pending: core returns the held item");
      assert.equal(e2[0].inboxID, want, "same inbox item in both logs");
    }
    assert.equal(storage.map.has("idle/dup"), false, "no deadline left in storage");
    h1.cleanup(); h2.cleanup();
  }
  // Other errors keep today's handling: compact.failed, and the session may be compacted again.
  {
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { compactFn: async () => { throw new Error("boom"); }, idleAt: { bad: () => idle0 } });
    await turn(h, "bad", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(80);
    const names = events(h).filter((e) => e.sessionID === "bad").map((e) => e.event);
    assert.deepEqual(names, ["compact.failed"], "other errors: compact.failed");
    h.cleanup();
  }
  // A2. process A compacts and finishes, which advances time.idle: B's timer then fires with a newer time.idle, so the idle-keyed
  //     id differs. B reads the context and sizes it: a completed compaction with no anchor after it means the old size lost its
  //     basis, so the whole context (the summary plus what came after) is sized at ~4 chars/token and the economics decide.
  //     The old tracked size is 150,000 either from the character estimate or from HTTP usage; the result is the same.
  const summary = { type: "compaction", status: "completed", reason: "auto", summary: "S".repeat(4000) };
  for (const http of [false, true]) for (const [name, after, calls] of [
    ["only an idle marker after the compaction", [{ type: "idle", outcome: "succeeded" }], 0],
    ["nothing after the compaction", [], 0],
    ["a short skill entry", [{ type: "skill", name: "s", text: "short" }], 0],
    ["a short system entry", [{ type: "system", text: "short" }], 0],
    ["an effort switch", [{ type: "model-switched" }, { type: "agent-switched" }], 0],
    ["a short user turn", [{ type: "user", text: "more" }], 0],
    ["a short assistant turn without usage", [{ type: "assistant", content: [] }], 0],
    // a large tail still compacts: a shell row of 600,000 characters is ~150,000 tokens (a background one, status exited, too)
    ["a large shell row after the compaction", [{ type: "shell", command: "cat big", status: "exited", metadata: { background: true }, output: { output: "x".repeat(600_000) } }], 1],
    ["a large user turn after the compaction", [{ type: "user", text: "x".repeat(600_000) }], 1],
  ]) {
    const name2 = `${name}${http ? " (HTTP-sized)" : ""}`;
    const core = fakeCore(), storage = fakeStorage();
    const loc = { directory: "/proj/x-finished", workspaceID: "ws1" };
    core.messages = [{ type: "user", text: "hi" }, { type: "assistant", model: { providerID: "omni", id: "router-gpt" }, content: [], tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 150000, write: 0 } } }];
    let idleB = idle0, release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h1 = await harness({ idleCompactMinutes: 80 / MIN }, { storage, location: loc, compactFn: core.compact, contextFn: core.context, idleAt: { fin: () => idle0 } });
    await turn(h1, "fin", "omni/router-gpt", body(150_000, { breakpoints: false }), {}, http ? new Response(JSON.stringify({ usage: { input_tokens: 149000, output_tokens: 1000 } })) : undefined);
    await sleep(15);
    const h2 = await harness({ debug: true, idleCompactMinutes: 80 / MIN }, { storage, location: loc, compactFn: core.compact, contextFn: core.context, idleAt: { fin: () => idleB }, waitFor: () => gate });
    await sleep(15);
    assert.match(h2.log(), /"compact.rearmed"/, `${name2}: the second process restored the deadline`);
    for (let i = 0; i < 100 && h1.compacted.length < 1; i++) await sleep(10);
    assert.equal(h1.compacted.length, 1, `${name2}: first process compacted`);
    // the compaction ran: the context is now the compaction, then what came after; time.idle moved on
    core.messages = [summary, ...after];
    idleB = Date.now() - 1000;
    release();
    await sleep(120);
    assert.equal(h2.compacted.length, calls, `${name2}: second process made ${calls} compaction call(s)`);
    if (!calls) {
      assert.match(h2.log(), /"compact.skip"[^\n]*"sessionID":"fin"[^\n]*"reason":"below compactMinTokens"/, `${name2}: sized from the small context`);
      assert.equal(storage.map.has("idle/fin"), false, `${name2}: deadline dropped`);
    } else assert.notEqual(h2.compacted[0].id, h1.compacted[0].id, `${name2}: a newer idle stretch has its own id`);
    h1.cleanup(); h2.cleanup();
  }
  // a compaction that did not complete is no proof; neither is a context without one
  for (const [name, messages] of [
    ["failed compaction", [{ type: "compaction", status: "failed" }]],
    ["running compaction", [{ type: "compaction", status: "running" }]],
    ["no compaction", [{ type: "idle" }]],
  ]) {
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn: async () => messages, idleAt: { nc: () => idle0 } });
    await turn(h, "nc", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(70);
    assert.equal(h.compacted.length, 1, `${name}: still compacts`);
    h.cleanup();
  }
  // B. id shape and determinism
  {
    const idleAt = 1763565050735;
    const ids = [];
    for (const [sessionID, at] of [["ses_a", idleAt], ["ses_a", idleAt], ["ses_a", idleAt + 1], ["ses_b", idleAt]]) {
      const h = await harness({ idleCompactMinutes: 20 / MIN }, { idleAt: { [sessionID]: () => at } });
      await turn(h, sessionID, "omni/router-gpt", body(150_000, { breakpoints: false }));
      await sleep(70);
      assert.equal(h.compacted.length, 1);
      ids.push(h.compacted[0].id);
      h.cleanup();
    }
    for (const id of ids) assert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(ids[0], ids[1], "same (session, time.idle) -> same id");
    assert.notEqual(ids[0], ids[2], "different time.idle -> different id");
    assert.notEqual(ids[0], ids[3], "different session -> different id");
    assert.equal(ids[0].slice(4, 16), ((BigInt(idleAt) * 4096n + 1n) & (2n ** 48n - 1n)).toString(16).padStart(12, "0"), "time chars of idleAt * 4096 + 1, low 48 bits");
  }
  // C. without time.idle: no id; D: inboxID falls back to nothing when core returns no item
  {
    const h = await harness({ idleCompactMinutes: 20 / MIN });
    await turn(h, "noidle", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(70);
    assert.deepEqual(h.compacted, [{ sessionID: "noidle", delivery: "queue" }]);
    assert.equal("id" in h.compacted[0], false, "no time.idle -> compact called without id");
    assert.equal(events(h).find((e) => e.event === "compact.idle")?.inboxID, undefined);
    h.cleanup();
  }
  // D. the fake's returned id, even when it differs from the one sent
  {
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { compactFn: async () => ({ id: "msg_returned" }), idleAt: { ret: () => idle0 } });
    await turn(h, "ret", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(70);
    assert.equal(events(h).find((e) => e.event === "compact.idle")?.inboxID, "msg_returned", "inboxID is the returned item's id");
    h.cleanup();
  }
}

// 12. when no provider usage arrived, size from the usage OpenCode recorded (session.context), as core's estimatePrompt does.
{
  const claude = { input: 2, output: 250, reasoning: 0, cache: { read: 648967, write: 1632 } }; // 650851 in total
  const assistant = (tokens, extra = {}) => ({ type: "assistant", id: "msg_a", model: { providerID: "omni", id: "router-gpt" }, content: [], ...(tokens && { tokens }), ...extra });
  const user = (text) => ({ type: "user", id: "msg_u", text });
  const sized = (h) => events(h).find((e) => e.event === "compact.idle")?.estimatedTokens;
  // E. a route that never produces usage, with a history of over 1M characters-per-4: the recorded usage wins
  {
    const big = body(1_100_000, { breakpoints: false });
    const chars = Math.round(JSON.stringify({ system: big.system, messages: big.messages }).length / 4);
    assert.ok(chars > 1_000_000);
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn: async () => [user("hi"), assistant(claude)] });
    await turn(h, "claude-agent", "omni/router-gpt", big);
    await sleep(120);
    assert.equal(h.compacted.length, 1);
    assert.equal(sized(h), 650851, "estimatedTokens from the session's recorded usage, not the character estimate");
    assert.deepEqual(h.contexts, [{ sessionID: "claude-agent" }]);
    h.cleanup();
  }
  // messages after the newest assistant message with tokens count at ~4 chars/token; an assistant message without tokens
  // or with an error is skipped
  {
    const tail = [assistant(undefined), user("x".repeat(4000))];
    const messages = [assistant({ ...claude, input: 1 }), assistant(claude), ...tail, assistant({ ...claude, input: 9 }, { error: { type: "x" } })];
    const after = [assistant(undefined), user("x".repeat(4000)), messages[4]];
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn: async () => messages });
    await turn(h, "tail", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(120);
    assert.equal(sized(h), Math.round(650851 + JSON.stringify(after).length / 4));
    h.cleanup();
  }
  // a large character estimate, a small recorded size: not compacted (the session did not need it)
  {
    const h = await harness({ debug: true, idleCompactMinutes: 20 / MIN }, { contextFn: async () => [assistant({ input: 1000, output: 100, reasoning: 0, cache: { read: 48000, write: 0 } })] });
    await turn(h, "small-real", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(120);
    assert.equal(h.compacted.length, 0, "recorded usage below compactMinTokens -> not compacted");
    assert.match(h.log(), /"compact.skip"[^\n]*"sessionID":"small-real"[^\n]*"reason":"below compactMinTokens"/);
    h.cleanup();
  }
  // F. no usable usage in the context, or the read fails: the character estimate, as before
  for (const [name, contextFn] of [
    ["no assistant message", async () => [user("hi")]],
    ["assistant without tokens", async () => [user("hi"), assistant(undefined)]],
    ["empty context", async () => []],
    ["not an array", async () => ({})],
    ["wrapped in { data }: only the array itself is accepted", async () => ({ data: [assistant(claude)] })],
    ["zero usage", async () => [assistant({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })]],
    ["read fails", async () => { throw new Error("context unavailable"); }],
    // 6. only the current provider's count counts (core's hasMeasuredPrompt): after a provider switch there is none
    ["only another provider's usage", async () => [assistant(claude, { model: { providerID: "other", id: "x" } })]],
    ["no provider on the assistant message", async () => [assistant(claude, { model: undefined })]],
  ]) {
    const b = body(150_000, { breakpoints: false });
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn });
    await turn(h, "fb", "omni/router-gpt", b);
    await sleep(120);
    assert.equal(h.contexts.length, 1, `${name}: context read once`);
    assert.equal(h.compacted.length, 1, `${name}: compacted on the character estimate`);
    assert.equal(sized(h), Math.round(JSON.stringify({ system: b.system, messages: b.messages }).length / 4), `${name}: character estimate`);
    h.cleanup();
  }
  // F. provider usage seen: the size stays the provider usage (the context is read once, for the already-compacted check only)
  {
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn: async () => [assistant(claude)] });
    await turn(h, "usage", "omni/router-gpt", body(150_000, { breakpoints: false }), {}, new Response(JSON.stringify({ usage: { input_tokens: 99000, output_tokens: 1000 } })));
    await sleep(120);
    assert.equal(h.compacted.length, 1);
    assert.equal(sized(h), 100000, "provider usage sizes the session, not the recorded usage");
    assert.equal(h.contexts.length, 1, "one context read (already-compacted check)");
    h.cleanup();
  }
  // a plugin context without session.context (older OpenCode): the character estimate
  {
    const h = await harness({ idleCompactMinutes: 20 / MIN });
    assert.equal(h.ctx.session.context, undefined);
    await turn(h, "old", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(120);
    assert.equal(h.compacted.length, 1, "no session.context: compacted on the character estimate as before");
    h.cleanup();
  }
  // the size basis is persisted and restored: a restored character estimate reads the context, a restored usage size does not
  {
    const loc = { directory: "/proj/sized", workspaceID: "ws1" };
    // the context is read once either way (already-compacted check); only the chars basis takes its size from it
    for (const [response, basis, reads] of [[new Response("{}"), "chars", 1], [new Response(JSON.stringify({ usage: { input_tokens: 99000, output_tokens: 1000 } })), "usage", 0]]) {
      const storage = fakeStorage();
      const a = await harness({ idleCompactMinutes: 60 / MIN }, { storage, location: loc });
      await turn(a, "persist", "omni/router-gpt", body(150_000, { breakpoints: false }), {}, response);
      await sleep(20);
      a.cleanup();
      assert.equal(storage.map.get("idle/persist")?.sized, basis, `${basis}: basis persisted`);
      const b = await harness({ idleCompactMinutes: 5000 / MIN }, { storage, location: loc, contextFn: async () => [assistant({ ...claude, cache: { read: 148967, write: 1632 } })] });
      await sleep(100);
      assert.equal(b.compacted.length, 1, `${basis}: restored deadline fired`);
      assert.equal(b.contexts.length, 1, `${basis}: one context read`);
      assert.equal(sized(b), reads ? 150851 : 100000);
      b.cleanup();
    }
  }
  // 5. the anchor's settled local tool results were never seen by the provider: counted at ~4 chars/token like core.
  //    Hosted (executed) tools and unsettled ones are not.
  {
    const measured = { input: 1000, output: 100, reasoning: 0, cache: { read: 58900, write: 0 } }; // 60000
    const local = [{ type: "text", text: "x".repeat(240_000) }];
    const tool = (state, extra = {}) => ({ type: "tool", id: "t", name: "read", state, time: {}, ...extra });
    const done = tool({ status: "completed", input: {}, content: local });
    // core replays an error-state tool as `{ error, content: content ?? [] }`, so the error text counts too.
    const bigError = { type: "tool.execution", message: "e".repeat(240_000) };
    const replayed = (error, content = []) => Math.round(60000 + JSON.stringify([{ error, content }]).length / 4);
    for (const [name, content, want] of [
      ["settled local tool result", [done], Math.round(60000 + JSON.stringify([local]).length / 4)],
      ["error with content", [tool({ status: "error", input: {}, error: { type: "x", message: "m" }, content: local })], replayed({ type: "x", message: "m" }, local)],
      ["hosted (executed) tool", [{ ...done, executed: true }], 60000],
      ["running tool", [tool({ status: "running", input: {}, metadata: {} })], 60000],
      ["error without content", [tool({ status: "error", input: {}, error: { type: "x", message: "m" } })], 60000],
      ["error with a 240,000-character message", [tool({ status: "error", input: {}, error: bigError })], replayed(bigError)],
    ]) {
      const h = await harness({ debug: true, idleCompactMinutes: 20 / MIN }, { contextFn: async () => [assistant(measured, { content })] });
      await turn(h, "tools", "omni/router-gpt", body(150_000, { breakpoints: false }));
      await sleep(120);
      if (want >= 100000) {
        assert.equal(h.compacted.length, 1, `${name}: compacted`);
        assert.equal(sized(h), want, `${name}: measured + local tool output`);
        assert.ok(Math.abs(want - 120000) < 100, "about 120,000");
      } else {
        assert.equal(h.compacted.length, 0, `${name}: 60,000 stays below compactMinTokens`);
        assert.match(h.log(), /"reason":"below compactMinTokens"/);
      }
      h.cleanup();
    }
  }
  // 3. the context is read only after the session settled, and its size is what the economics check sees. A session busy when
  //    the timer fires, still showing an old 50,000 record, finishes at 150,000: it is compacted, not skipped on the old size.
  {
    let settled = false, release;
    const gate = new Promise((resolve) => { release = resolve; });
    const old = [assistant({ input: 1000, output: 100, reasoning: 0, cache: { read: 48900, write: 0 } })]; // 50,000
    const fresh = [assistant(claude)];
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn: async () => (settled ? fresh : old), waitFor: () => gate, idleAt: { busy: () => Date.now() - 5000 } });
    await turn(h, "busy", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(120);
    assert.deepEqual(h.waits, ["busy"], "the timer fired and is waiting for the session");
    assert.deepEqual(h.contexts, [], "no context read while the session is busy");
    assert.equal(h.compacted.length, 0);
    settled = true; release();
    await sleep(120);
    assert.deepEqual(h.contexts, [{ sessionID: "busy" }], "one read, after the wait");
    assert.equal(h.compacted.length, 1);
    assert.equal(sized(h), 650851, "sized from the settled context");
    h.cleanup();
  }
  // 3. a read that comes back after newer activity is not applied
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn: async () => { await gate; return [assistant(claude)]; }, idleAt: { race: () => Date.now() - 5000 } });
    await turn(h, "race", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(60);
    assert.equal(h.contexts.length, 1, "read in flight");
    await turn(h, "race", "omni/router-gpt", body(150_000, { breakpoints: false }), {}, new Response(JSON.stringify({ usage: { input_tokens: 99000, output_tokens: 1000 } })));
    release();
    await sleep(120);
    assert.equal(h.compacted.length, 1, "only the newer activity's timer compacts");
    assert.equal(sized(h), 100000, "the old read did not overwrite the newer provider usage");
    h.cleanup();
  }
  // 1. HTTP usage of the SAME request arrives while the context is being read: the decision uses that usage (50,000, below
  //    compactMinTokens), not the character estimate (150,000) the timer started with.
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = await harness({ debug: true, idleCompactMinutes: 20 / MIN }, { contextFn: async () => { await gate; return [user("hi")]; }, idleAt: { same: () => Date.now() - 5000 } });
    const b = body(150_000, { breakpoints: false });
    await h.hooks.context(contextEvent("same", "omni/router-gpt", b));
    const e = { sessionID: "same", kind: "primary", model: ref("omni/router-gpt"), request: req(b) };
    await h.hooks["http.request"](e);
    await sleep(60);
    assert.equal(h.contexts.length, 1, "read in flight");
    await h.hooks["http.response"]({ ...e, response: new Response(JSON.stringify({ usage: { input_tokens: 49000, output_tokens: 1000 } })) });
    await sleep(20);
    release();
    await sleep(120);
    assert.equal(h.compacted.length, 0, "50,000 is below compactMinTokens: no compaction on the stale character estimate");
    assert.equal(sized(h), undefined, "no compact.idle logged with the character estimate");
    assert.match(h.log(), /"compact.skip"[^\n]*"sessionID":"same"[^\n]*"reason":"below compactMinTokens"/);
    h.cleanup();
  }
  // 2. an output-only record (no prompt counts) is not the anchor (core's hasMeasuredPrompt): the newest record with a
  //    positive prompt count is, and the newer record counts as unmeasured text.
  {
    const prompt = assistant({ input: 1000, output: 100, reasoning: 0, cache: { read: 148900, write: 0 } }); // 150,000
    const outputOnly = assistant({ input: 0, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } });
    const h = await harness({ idleCompactMinutes: 20 / MIN }, { contextFn: async () => [prompt, outputOnly] });
    await turn(h, "outonly", "omni/router-gpt", body(150_000, { breakpoints: false }));
    await sleep(120);
    assert.equal(h.compacted.length, 1, "compacted on the 150,000-token prompt");
    assert.equal(sized(h), Math.round(150000 + JSON.stringify([outputOnly]).length / 4), "anchored on the prompt record, not the output-only one");
    assert.ok(Math.abs(sized(h) - 150000) < 100, "about 150,000");
    h.cleanup();
  }
}

rmSync(dir, { recursive: true, force: true });
console.log("anthropic-cache-v2 compaction: all checks passed");
