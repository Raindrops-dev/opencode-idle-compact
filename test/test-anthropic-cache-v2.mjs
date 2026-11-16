// Offline acceptance test for index.js. No network: a fake plugin context records hooks.
// The model catalog (ctx.model.list) decides what the plugin does with a route; idle/child compaction and native-warming
// coordination are covered in scripts/test-anthropic-cache-v2-compaction.mjs.
// Run: node scripts/test-anthropic-cache-v2.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { cacheBody, warmText, warmable, writes, saving, usageTokens } from "../index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms = 5000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await sleep(10); }; // bounded poll, not a guessed duration
const dir = mkdtempSync(join(tmpdir(), "anthropic-cache-"));
const VERTEX = { providerID: "google-vertex", id: "claude-opus-5-5@default" };
const URL1 = "https://aiplatform.googleapis.com/v1/x/models/claude-opus-5-5@default:streamRawPredict";

const NATIVE = "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";
const OR_HAIKU = { providerID: "openrouter", id: "anthropic/claude-haiku-4.5" };
const GPT = { providerID: "example-openai", id: "gpt-6-sol" };
const COPILOT = { providerID: "github-copilot", id: "claude-opus-5.5" };
// Catalog (shape of ctx.model.list().data): Anthropic-style routes bill cache writes, the others do not.
const entry = (m, write) => ({ ...m, cost: [{ input: 3, output: 15, cache: { read: 0.3, write } }], limit: { context: 1_000_000, output: 64000 } });
const CATALOG = [VERTEX, { providerID: "example-anthropic", id: "claude-sonnet-5" }, { providerID: "anthropic", id: "claude-opus-5-5" },
  { providerID: "openrouter", id: "anthropic/claude-opus-5.5" }, OR_HAIKU, { providerID: "opencode", id: "claude-opus-5-5" }].map((m) => entry(m, 3.75))
  .concat([COPILOT, GPT, { providerID: "openrouter", id: "google/gemini-3.8-flash" }].map((m) => entry(m, 0)));

const messagesBody = (extra = {}) => ({
  max_tokens: 32000,
  stream: true,
  system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "read", input_schema: {}, cache_control: { type: "ephemeral", ttl: "5m" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  metadata: { cache_control: { type: "persistent" } },
  ...extra,
});
const req = (body, headers = {}, url = URL1) => new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": "999", authorization: "Bearer old", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function harness(options, { compact = false, logFile = join(dir, "log.jsonl") } = {}) {
  const hooks = {}, generated = [], compacted = [];
  const ctx = {
    options: { logFile, ...options },
    model: { list: async () => ({ location: { directory: "/x" }, data: CATALOG }) },
    session: {
      hook: async (name, fn) => { hooks[name] = fn; },
      generate: async (input) => { generated.push(input); if (ctx.onGenerate) await ctx.onGenerate(input); return { text: "" }; },
      get: async ({ sessionID }) => ({ id: sessionID }),
      wait: async () => {},
      ...(compact ? { compact: async (input) => { compacted.push(input); } } : {}),
    },
  };
  const cleanup = await plugin.setup(ctx);
  return { hooks, generated, compacted, ctx, cleanup };
}
const send = async (h, e) => { await h.hooks["http.request"](e); return e; };
const respond = (h, e, status = 200) => h.hooks["http.response"]({ ...e, response: new Response("{}", { status }) });

// 1. pure helpers
assert.equal(plugin.id, "anthropic-cache");
for (const [usage, expected] of [
  [{}, undefined],
  [{ input_tokens: 0, output_tokens: 0 }, undefined],
  [{ prompt_tokens: 0, completion_tokens: 0 }, undefined],
  [{ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, undefined],
  [{ input_tokens: 0, cache_read_input_tokens: 100 }, 100],
  [{ input_tokens: 100 }, 100],
  [{ input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }, 100],
  [{ prompt_tokens: 90, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } }, 100],
  [{ prompt_tokens: 90, cache_read_input_tokens: 80, completion_tokens: 10 }, 100],
  [{ input_tokens: 90, output_tokens: 10 }, 100],
  [{ input_tokens: "100" }, undefined],
  [{ input_tokens: -1 }, undefined],
  [{ input_tokens: Infinity }, undefined],
  [{ input_tokens: 100, cache_creation_input_tokens: "bad" }, undefined],
  [{ input_tokens: 100, output_tokens: NaN }, undefined],
  [{ input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE }, undefined],
]) assert.equal(usageTokens(usage), expected, `usage size: ${JSON.stringify(usage)}`);
// eligibility comes from the catalog (cache-write price), not from names
assert.ok(CATALOG.filter((m) => writes(m)).length === 6 && CATALOG.filter((m) => !writes(m)).length === 3);
assert.ok(!writes(undefined) && !writes({ cost: [] }), "unknown or unpriced model: no cache-write price");
assert.ok(writes({ cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }, { input: 2, output: 2, cache: { read: 0, write: 1 }, tier: { type: "context", size: 200000 } }] }), "any tier counts");
{
  const h = await harness({ keepWarm: false });
  for (const m of CATALOG) {
    const e = await send(h, { sessionID: "cat", kind: "primary", model: m, request: req(messagesBody()) });
    assert.equal(JSON.parse(await e.request.text()).system[0].cache_control.ttl, writes(m) ? "1h" : undefined, `${m.providerID}/${m.id}`);
  }
  const unknown = await send(h, { sessionID: "cat", kind: "primary", model: { providerID: "nowhere", id: "unlisted" }, request: req(messagesBody()) });
  assert.equal(JSON.parse(await unknown.request.text()).system[0].cache_control.ttl, undefined, "model missing from the catalog: untouched");
  h.cleanup();
  // catalog failure = unknown models
  const f = await harness({ keepWarm: false });
  f.ctx.model.list = async () => { throw new Error("down"); };
  const x = await send(f, { sessionID: "cat", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  assert.equal(JSON.parse(await x.request.text()).system[0].cache_control.ttl, undefined, "catalog fetch failed: untouched");
  f.cleanup();
  // saving: tier-aware, unpriced = undefined
  const tiered = { cost: [{ input: 2, output: 10, cache: { read: 0.2, write: 0 } }, { input: 4, output: 20, cache: { read: 0.4, write: 0 }, tier: { type: "context", size: 200000 } }] };
  assert.ok(Math.abs(saving(tiered, 150_000, 1) - 0.222) < 1e-9);
  assert.ok(Math.abs(saving(tiered, 250_000, 1) - (246000 * 4 / 1e6 - (250000 * 0.4 + 4000 * 20) / 1e6)) < 1e-9, "tier above its size");
  assert.equal(saving({ cost: [] }, 150_000, 1), undefined);
}
{
  const r = cacheBody(JSON.stringify(messagesBody()), "1h");
  assert.equal(r.breakpoints, 3);
  assert.equal(r.topLevel, false);
  assert.equal(JSON.parse(r.text).cache_control, undefined, "no top-level marker when breakpoints exist");
  const b = JSON.parse(r.text);
  assert.deepEqual(b.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(b.tools[0].cache_control, { type: "ephemeral", ttl: "1h" }, "5m is forced to 1h (TTL order rule)");
  assert.deepEqual(b.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(b.metadata.cache_control, { type: "persistent" }, "non-ephemeral untouched");
  const chat = cacheBody(JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] }), "1h");
  assert.equal(JSON.parse(chat.text).messages[0].content[0].cache_control.ttl, "1h", "chat shape with block markers");
  const bareText = JSON.stringify({ model: "anthropic/claude-haiku-4.5", messages: [{ role: "user", content: "x" }] });
  const none = cacheBody(bareText, "1h");
  assert.equal(none.topLevel, false, "no marker unless the route is a topLevelCache route");
  assert.equal(JSON.parse(none.text).cache_control, undefined);
  const bare = cacheBody(bareText, "1h", true);
  assert.equal(bare.topLevel, true);
  assert.deepEqual(JSON.parse(bare.text).cache_control, { type: "ephemeral", ttl: "1h" }, "no breakpoints -> top-level automatic caching");
  assert.equal(cacheBody("not json", "1h"), undefined);
  assert.equal(cacheBody('{"input":[]}', "1h"), undefined, "non-messages bodies are left alone");
  assert.equal(cacheBody("[1]", "1h"), undefined);
  assert.equal(warmable({ thinking: { type: "adaptive" } }), true);
  assert.equal(warmable({ thinking: { type: "enabled", budget_tokens: 1024 } }), false);
  assert.equal(warmable({ reasoning: { effort: "high" } }), false, "OpenRouter reasoning -> budget");
  assert.equal(warmable({ reasoning: { max_tokens: 2048 } }), false);
  assert.equal(warmable({ reasoning: { effort: "none" } }), true);
  assert.equal(warmable({ reasoning: { enabled: false, effort: "high" } }), true);
  assert.equal(warmable({}), true);
  assert.equal(JSON.parse(warmText(JSON.stringify({ max_tokens: 9, stream: true }))).max_tokens, 1);
  assert.deepEqual(JSON.parse(warmText(JSON.stringify({ max_completion_tokens: 9 }))), { max_completion_tokens: 1 });
}

// 2. request rewrite, scope, subagents
{
  const h = await harness({ keepWarm: false, topLevelCache: ["openrouter/*"] });
  const e = await send(h, { sessionID: "s1", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  const b = JSON.parse(await e.request.text());
  assert.equal(b.system[0].cache_control.ttl, "1h");
  assert.equal(e.request.headers.get("content-length"), null, "stale content-length dropped");
  assert.equal(e.request.headers.get("authorization"), "Bearer old");
  assert.equal(e.request.url, URL1);
  for (const [kind, model] of [["primary", COPILOT], ["primary", GPT], ["title", VERTEX], ["compaction", VERTEX]]) {
    const original = req(messagesBody());
    const x = await send(h, { sessionID: "s1", kind, model, request: original });
    assert.equal(x.request, original, `${kind} ${model.id} untouched`);
  }
  const orModel = OR_HAIKU;
  const h2x = await harness({ keepWarm: false });
  const orPlain = await send(h2x, { sessionID: "o0", kind: "primary", model: orModel, request: req({ model: orModel.id, stream: true, messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(JSON.parse(await orPlain.request.text()).cache_control, undefined, "no topLevelCache match: no marker");
  const or = await send(h, { sessionID: "o1", kind: "primary", model: orModel, request: req({ model: orModel.id, stream: true, messages: [{ role: "user", content: "hi" }] }) });
  assert.deepEqual(JSON.parse(await or.request.text()).cache_control, { type: "ephemeral", ttl: "1h" }, "OpenRouter request gets top-level cache_control");
  const resp = req({ input: [] });
  assert.equal((await send(h, { sessionID: "o1", kind: "primary", model: VERTEX, request: resp })).request, resp, "non-messages body untouched");
  const childReq = req(messagesBody(), { "x-parent-session-id": "s1" });
  assert.equal((await send(h, { sessionID: "c1", kind: "primary", model: VERTEX, request: childReq })).request, childReq, "subagents default false: children untouched");
  const h2 = await harness({ keepWarm: false, subagents: true, ttl: "5m" });
  const child = await send(h2, { sessionID: "c2", kind: "primary", model: VERTEX, request: req(messagesBody(), { "x-parent-session-id": "s1" }) });
  assert.equal(JSON.parse(await child.request.text()).system[0].cache_control.ttl, "5m", "subagents:true rewrites children");
  const root = await send(h2, { sessionID: "r2", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  assert.equal(JSON.parse(await root.request.text()).system[0].cache_control.ttl, "5m", "ttl option");
  h.cleanup(); h2.cleanup(); h2x.cleanup();
}

// 3. keep-warm: carrier swap, fresh auth, reschedule, idle limit, no warm for children/thinking/failures
{
  // Real timers, sized for coarse clocks (Windows ~16 ms): each warm sets `touched` to its own (late) fire time, so the
  // lateness adds up. Measured from the last real activity, warm 3 is due at ~3*A + 2*late and must fit the idle limit;
  // a 4th would be due at >= 4*A and must not. A = 100 ms and a 370 ms limit keep both >= 30 ms away for timers up to
  // 20 ms late per tick; the sleeps below sample between events.
  const minute = 60_000, after = 100 / minute; // 100 ms
  const h = await harness({ warmAfterMinutes: after, maxIdleMinutes: 370 / minute, subagents: true, topLevelCache: ["openrouter/*"] });
  let swapped;
  h.ctx.onGenerate = async ({ sessionID }) => {
    const e = await send(h, { sessionID, kind: "generate", model: VERTEX, request: req({ messages: [{ role: "user", content: NATIVE }] }, { authorization: "Bearer fresh" }) });
    swapped = e.request;
    await respond(h, e);
  };
  const first = await send(h, { sessionID: "w1", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  const stored = await first.request.clone().text();
  await respond(h, first);
  await sleep(150); // warm 1 at ~100 ms, warm 2 not before 200 ms
  assert.equal(h.generated.length, 1, "warm fired once");
  assert.deepEqual(h.generated[0], { sessionID: "w1", prompt: NATIVE }, "carrier sends the native keep-alive prompt");
  const w = JSON.parse(await swapped.text());
  assert.equal(w.max_tokens, 1);
  assert.deepEqual({ ...w, max_tokens: 32000 }, JSON.parse(stored), "carrier body = last real body except max_tokens");
  assert.equal(swapped.headers.get("authorization"), "Bearer fresh", "carrier keeps fresh credentials");
  assert.equal(swapped.headers.get("content-length"), null);
  await sleep(280); // ~430 ms: warm 3 has fired (<= ~375 ms even when every timer is 24 ms late)
  assert.equal(h.generated.length, 3, "rescheduled until the idle limit");
  await sleep(200); // past the 4th warm's earliest and latest times
  assert.equal(h.generated.length, 3, "stopped at maxIdleMinutes");
  const log = readFileSync(join(dir, "log.jsonl"), "utf8");
  assert.match(log, /"warm.send"/); assert.match(log, /"idle-limit"/);

  // route change -> carrier aborted before any network call
  let routeAbort = false;
  h.ctx.onGenerate = async ({ sessionID }) => {
    await send(h, { sessionID, kind: "generate", model: VERTEX, request: req({}, {}, URL1 + "x") })
      .catch((error) => { routeAbort = /warm route changed/.test(error.message); });
    throw new Error("aborted");
  };
  const r = await send(h, { sessionID: "w2", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, r);
  await sleep(150);
  assert.equal(h.generated.at(-1).sessionID, "w2");
  assert.ok(routeAbort, "carrier on another route is aborted");
  const count = h.generated.length;
  await sleep(150);
  assert.equal(h.generated.length, count, "failed carrier stops warming");

  // new real request cancels the pending warm; children, thinking budgets and HTTP errors never warm
  h.ctx.onGenerate = undefined;
  const base = h.generated.length;
  const a = await send(h, { sessionID: "w3", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, a);
  await sleep(20);
  const t = await send(h, { sessionID: "w3", kind: "primary", model: VERTEX, request: req(messagesBody({ thinking: { type: "enabled", budget_tokens: 2048 } })) });
  await respond(h, t);
  const c = await send(h, { sessionID: "c3", kind: "primary", model: VERTEX, request: req(messagesBody(), { "x-parent-session-id": "w3" }) });
  await respond(h, c);
  const f = await send(h, { sessionID: "w4", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, f, 500);
  await sleep(150);
  assert.equal(h.generated.length, base, "no warm for replaced/thinking/child/failed requests");

  // OpenRouter (top-level marker, no explicit breakpoints) gets the TTL but is never warmed
  const orm = OR_HAIKU;
  const o = await send(h, { sessionID: "w8", kind: "primary", model: orm, request: req({ model: orm.id, messages: [{ role: "user", content: "x" }] }) });
  await respond(h, o);
  await sleep(150);
  assert.ok(!h.generated.some((x) => x.sessionID === "w8"), "top-level (OpenRouter) requests are not warmed");

  // switching the session to a model without a cache-write price ends warming
  const m = await send(h, { sessionID: "w6", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, m);
  const gpt = await send(h, { sessionID: "w6", kind: "primary", model: GPT, request: req({ input: [] }) });
  await respond(h, gpt);
  await sleep(150);
  assert.ok(!h.generated.some((x) => x.sessionID === "w6"), "model switch cancels warming");
  const n1 = await send(h, { sessionID: "w7", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, n1);
  const n2 = await send(h, { sessionID: "w7", kind: "primary", model: VERTEX, request: req({ input: [] }) });
  await respond(h, n2);
  await sleep(150);
  assert.ok(!h.generated.some((x) => x.sessionID === "w7"), "unrecognised body cancels warming");

  // retry veto while a carrier is in flight
  let inflight;
  h.ctx.onGenerate = async ({ sessionID }) => {
    const ev = { sessionID, decision: { retry: true, delay: 1 } };
    await h.hooks.retry(ev);
    inflight = ev.decision;
  };
  const g = await send(h, { sessionID: "w5", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, g);
  await sleep(150);
  assert.deepEqual(inflight, { retry: false });
  const other = { sessionID: "zz", decision: { retry: true, delay: 1 } };
  await h.hooks.retry(other);
  assert.deepEqual(other.decision, { retry: true, delay: 1 }, "other sessions keep their retry policy");
  h.cleanup();
}

// 4. review round 1 fixes: TTL-bounded delay, warm cap, no overlapping carriers, compaction, debug clone
{
  // warmAfterMinutes at/above the TTL (or huge, which would overflow setTimeout to 1 ms) falls back to the default
  for (const warmAfterMinutes of [60, 40000]) {
    const h = await harness({ warmAfterMinutes, maxIdleMinutes: 41000 });
    const e = await send(h, { sessionID: "t1", kind: "primary", model: VERTEX, request: req(messagesBody()) });
    await respond(h, e);
    await sleep(60);
    assert.equal(h.generated.length, 0, `warmAfterMinutes ${warmAfterMinutes} falls back to the default delay`);
    h.cleanup();
  }

  // hard cap on replays per idle stretch, even with a tiny interval and a long idle limit
  const tiny = 5 / 60_000;
  const h = await harness({ warmAfterMinutes: tiny, maxIdleMinutes: 1 });
  let inflight = 0, maxInflight = 0, vetoed = true;
  h.ctx.onGenerate = async ({ sessionID }) => {
    inflight += 1; maxInflight = Math.max(maxInflight, inflight);
    const e = await send(h, { sessionID, kind: "generate", model: VERTEX, request: req({}) });
    await respond(h, e);
    await sleep(60); // far slower than the 5 ms interval (a timer is <= ~30 ms late): a second carrier must not start meanwhile
    const r = { sessionID, decision: { retry: true, delay: 1 } };
    await h.hooks.retry(r);
    vetoed &&= r.decision.retry === false;
    inflight -= 1;
  };
  const a = await send(h, { sessionID: "cap", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, a);
  await until(() => h.generated.length >= 12); // 12 cycles of carrier + re-arm take ~0.8-1.2 s depending on timer resolution
  await sleep(180); // a 13th would follow within one carrier + interval (<= ~115 ms); the limit is logged when the 12th ends
  assert.equal(h.generated.length, 12, "at most 12 warms per idle stretch");
  assert.equal(maxInflight, 1, "never two carriers in flight for one session");
  assert.ok(vetoed, "retries vetoed for the whole carrier");
  assert.match(readFileSync(join(dir, "log.jsonl"), "utf8"), /"warm-limit"/);

  // compaction ends warming (the stored body is the pre-compaction prefix)
  h.ctx.onGenerate = undefined;
  const base = h.generated.length;
  const c = await send(h, { sessionID: "cmp", kind: "primary", model: VERTEX, request: req(messagesBody()) });
  await respond(h, c);
  await send(h, { sessionID: "cmp", kind: "compaction", model: VERTEX, request: req(messagesBody()) });
  await sleep(80); // a surviving warm is due within ~30 ms (5 ms interval, timer up to 24 ms late)
  assert.ok(!h.generated.slice(base).some((x) => x.sessionID === "cmp"), "compaction stops warming");
  h.cleanup();

  // Usage parsing must not throw on a consumed/failed clone or delay OpenCode while a stream is still open.
  for (const debug of [false, true]) {
    const d = await harness({ keepWarm: false, debug });
    const r = await send(d, { sessionID: "dbg", kind: "primary", model: VERTEX, request: req(messagesBody()) });
    const used = new Response("{}");
    await used.text();
    await d.hooks["http.response"]({ ...r, response: used });
    let controller;
    const streaming = new Response(new ReadableStream({ start(c) { controller = c; } }));
    await Promise.race([
      d.hooks["http.response"]({ ...r, response: streaming }),
      sleep(100).then(() => { throw new Error("response hook waited for the usage stream"); }),
    ]);
    controller.error(new Error("provider stream failed"));
    await sleep(10); // rejected clone read must be swallowed, not an unhandled rejection
    d.cleanup();
  }
}

// 5. idle compaction: the final tick, at lastActive + maxIdle, compacts (when available and worth it by the catalog
//    economics) instead of warming
{
  const minute = 60_000, after = 100 / minute, idle = 370 / minute; // same sizing as section 3: warms at ~100/200/300 ms, final tick at 370 ms
  const bigBody = messagesBody();
  bigBody.messages[0].content[0].text = "x".repeat(600_000); // ~150k tokens: worth compacting at the catalog prices
  const carrier = (h) => async ({ sessionID }) => {
    const e = await send(h, { sessionID, kind: "generate", model: VERTEX, request: req({}) });
    await respond(h, e);
  };
  const run = async (options, flags, body = bigBody) => {
    const logFile = join(dir, `compact-${Math.random()}.jsonl`);
    const h = await harness({ warmAfterMinutes: after, maxIdleMinutes: idle, coreCompactionWarm: true, ...options }, { ...flags, logFile });
    h.ctx.onGenerate = carrier(h);
    const e = await send(h, { sessionID: "idle", kind: "primary", model: VERTEX, request: req(body) });
    await respond(h, e);
    await sleep(450); // the final tick is due at 370 ms
    h.cleanup();
    return { ...h, log: readFileSync(logFile, "utf8") };
  };
  const big = await run({ compactMinTokens: 1 }, { compact: true });
  assert.equal(big.generated.length, 3, "warms run up to the idle limit");
  assert.deepEqual(big.compacted, [{ sessionID: "idle", delivery: "queue" }], "one queued compaction on the final tick");
  assert.match(big.log, /"compact.idle"/);
  assert.doesNotMatch(big.log, /"idle-limit"/);
  const small = await run({}, { compact: true }, messagesBody());
  assert.equal(small.compacted.length, 0, "below compactMinTokens: no compaction");
  assert.match(small.log, /"idle-limit"/);
  const off = await run({ compactMinTokens: 1, compactOnIdle: false }, { compact: true });
  assert.equal(off.compacted.length, 0, "compactOnIdle:false disables it");
  assert.match(big.log, /"compact.enabled"/, "activation is logged once compact exists");

  // a real request whose body is still being read must cancel a due final tick (review round 2)
  {
    const logFile = join(dir, "race.jsonl");
    const h = await harness({ warmAfterMinutes: after, maxIdleMinutes: idle, compactMinTokens: 1 }, { compact: true, logFile });
    const realSetTimeout = globalThis.setTimeout, armed = [];
    let third;
    const thirdDone = new Promise((resolve, reject) => { third = { resolve, reject }; });
    h.ctx.onGenerate = async (input) => {
      try {
        await carrier(h)(input);
        if (h.generated.length !== 3) return;
        // From here the plugin re-arms after warm 3: record what it arms (the final tick, not a 4th warm).
        globalThis.setTimeout = (fn, delay, ...args) => (armed.push(delay), realSetTimeout(fn, delay, ...args));
        third.resolve();
      } catch (error) { third.reject(error); throw error; } // a failed carrier must fail the test, not pass it
    };
    const e = await send(h, { sessionID: "race", kind: "primary", model: VERTEX, request: req(bigBody) });
    await respond(h, e);
    const guard = setTimeout(() => third.reject(new Error("warm 3 never completed")), 3000); // bounded wait that fails
    try { await thirdDone; } finally { clearTimeout(guard); } // warms at ~100/200/300 ms; final tick due at 370 ms
    assert.equal(h.generated.length, 3, "warms ran up to the idle limit");
    await new Promise((r) => setImmediate(r)); // let warm 3 return into the plugin, which arms the final tick
    globalThis.setTimeout = realSetTimeout;
    // 370 ms limit - 3 warms of >= 100 ms leaves <= ~70 ms; a 4th warm would be armed for 100 ms
    assert.ok(armed.length === 1 && armed[0] < 100, `final tick armed before the request arrives (armed delays: ${armed})`);
    const text = JSON.stringify(bigBody);
    const slow = new Request(URL1, {
      method: "POST", duplex: "half", headers: { "content-type": "application/json" },
      body: new ReadableStream({ start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(text)); c.close(); }, 200); } }),
    });
    const pending = send(h, { sessionID: "race", kind: "primary", model: VERTEX, request: slow });
    await sleep(150); // past the final tick's due time (<= ~95 ms from here), body still unread (200 ms)
    assert.equal(h.compacted.length, 0, "no compaction while a real request is being prepared");
    await pending;
    h.cleanup();
  }
  const missing = await run({ compactMinTokens: 1 }, {});
  assert.match(missing.log, /"compact.unavailable"/, "no session.compact in the plugin API: logged, nothing else");
  assert.doesNotMatch(missing.log, /"compact.enabled"/);
  assert.equal(missing.generated.length, 3, "no extra warm in place of the compaction");
}

rmSync(dir, { recursive: true, force: true });
console.log("anthropic-cache-v2: all checks passed");
