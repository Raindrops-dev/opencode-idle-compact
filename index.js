// anthropic-cache-v2 — OpenCode v2 plugin: 1-hour prompt cache, keep-warm and idle compaction, driven by the model catalog.
//
// No provider or model names live in this file. What a model supports comes from `ctx.model.list()` (cached, refreshed
// every 10 minutes or when a model is missing) and from the options below.
//
// TTL: OpenCode v2 marks Anthropic-style prompts with `cache_control: {type:"ephemeral"}` (5-minute TTL) by default.
// OpenCode 2.3.0 can also set the lifetime itself (provider or model `settings.cache.ttl`). This plugin rewrites every
// explicit ephemeral breakpoint to `ttl:"1h"` on the native HTTP request when the catalog entry of the model has a
// cache-write price above 0 (the provider bills cache writes: any tier). An unknown model, or one without a
// cache-write price, is left untouched. A body with no breakpoint at all gets a top-level `cache_control` only on
// routes listed in `topLevelCache`.
//
// Keep-warm (root sessions, explicit breakpoints only): shortly before the 1-hour entry expires, the plugin calls
// `session.generate` as an authenticated carrier and swaps its body for the session's last real request with
// `max_tokens: 1`. The provider reads the cached prefix, which refreshes its TTL; nothing is added to history.
// The carrier sends OpenCode's own keep-alive prompt (`nativeWarmPrompt`) so that OpenCode's native warming (root
// sessions, every 4 minutes for 30 minutes) does not restart its window. A native warm is a generate whose LAST user
// message is exactly that prompt: it gets the TTL rewrite and, once its response is ok, counts as a cache touch (the
// plugin timer is re-armed from it).
// Request frame: native warms do not run `context` hooks, so another plugin's changes to
// the system prompt or tools would make their prefix differ from the cached real requests. The plugin keeps the last
// real request of each session (32 most recent sessions) and copies its `system`, `instructions`, `systemInstruction`,
// `tools` and `thinking` into those generates (a field the frame lacks is removed from them); their conversation and
// output controls (`max_tokens` ...) stay their own (same route and conversation key only, never over
// `previous_response_id`).
// Timeline with defaults: native warms 0-30 min, compaction at 50 min (no plugin replay with warmAfterMinutes 55).
//
// Idle compaction (OpenCode selects the summary model; this plugin never calls another model):
//   warm   a plugin-warmed session, at the final tick: min(next warm, last real request + maxIdleMinutes)
//   root   any other root session, `idleCompactMinutes` after its last `context` event
//   child  a child (subagent) session, `childIdleSeconds` after its last `context` event
// All are queued (`delivery: "queue"`), wait for the session to be idle, and are dropped if the session saw new real
// activity meanwhile. Size comes from the last primary response's input (including cache writes/reads) plus output;
// without usable usage, fall back to ~4 chars/token over system and messages, replaced at the idle check by the usage
// OpenCode recorded in the session (`ctx.session.context`, as core sizes a prompt; a failed or non-array read logs
// `compact.context-failed` with the error's tag or name only). Every character estimate counts typed inline media (a
// `mime`/`mediaType`/`media_type` with a `data`/`uri` payload) as core does: image 1,500 tokens, PDF 2,000, other media
// by its characters, not by its base64 text. Catalog economics decide (tier-aware at
// that size, `cold` = cache-write price or
// else input price): saving = rate * (tokens - 4000) * cold - (tokens * read price + 4000 * output price), with rate 1
// for warm/root and `childResumeRate` for child. The read is priced warm by default except for native compaction;
// `coreCompactionWarm` overrides this (explicit false means cold). Compact only if tokens >= compactMinTokens
// and saving >= compactSaveMin USD. `flatRate` routes are never compacted. Unpriced models (no catalog entry,
// `cost: []`) have no economics: with `compactUnpriced` (default true) they compact on size alone (tokens >=
// compactMinTokens, logged as basis "size"); `compactUnpriced: false` skips them.
// A session that went idle less than a quiet period ago (`time.idle` from `ctx.session.get`; without
// it, a wait that took at least min(1 s, half the quiet period) counts as busy) is retried when the quiet period from
// its idle time is over.
// Every compaction carries an id derived from the session and its `time.idle` (when known), so that two processes
// firing the same persisted deadline compact once (`compact.duplicate` in the second). A process that fires after
// the first finished sees a newer `time.idle`; it then sizes the context returned by `ctx.session.context` (a completed
// compaction with no usable anchor after it: ~4 chars/token over that context), so a fresh summary falls below
// compactMinTokens. Known limits with two servers on one host: run one server per host.
// After an idle compaction the session is remembered as compacted until its next real request: a native warm in
// between is aborted before the network (it would only rebuild the dropped cache).
// Warmers live in memory (dropped on unload). Idle-compaction deadlines are persisted in `ctx.storage` (`idle/<id>`)
// when available and restored across reloads for the same location (logged as `compact.rearmed`); entries more than
// 60 minutes past due are removed without compacting.
//
// Options (plugin object form in opencode.jsonc; all optional):
//   ttl: "1h" | "5m"           TTL written to every breakpoint (default "1h")
//   subagents: boolean         also give child (subagent) sessions the TTL (default false: they run back-to-back and
//                              are rarely resumed, so 5m writes are cheaper); child sessions are never warmed
//   keepWarm: boolean          default true
//   warmAfterMinutes: number   delay after the last cache touch before warming; must be below the TTL
//                              (default 55 for 1h, 4 for 5m). At most 12 warms per idle stretch.
//   maxIdleMinutes: number     stop warming a session this long after its last real request (default 50, < 1440);
//                              values >= 60 need OpenCode's experimental.location_idle_timeout set above them,
//                              otherwise the location unloads first and warming stops early
//   nativeWarmPrompt: string   OpenCode's keep-alive prompt (default: its built-in text)
//   compactOnIdle: boolean     compact warm and root sessions when idle (default true)
//   rootCompact: boolean       compact non-warmed root sessions when idle (default true)
//   idleCompactMinutes: number root scope: minutes after the last context event (default 30, < 60, = native warming duration)
//   childCompact: boolean      compact child sessions when quiet (default true)
//   childIdleSeconds: number   child scope: quiet seconds after the last context event (default 90)
//   childResumeRate: number    measured share of child sessions that are resumed, 0 to 1 (default 0.3)
//   compactMinTokens: number   only compact contexts at least this large, usage or estimate (default 100000)
//   compactSaveMin: number     minimum expected saving in USD (default 0.02)
//   compactUnpriced: boolean   compact unpriced models (no catalog entry or empty cost) on size alone, once tokens >=
//                              compactMinTokens and not flatRate (default true; false = never compact them)
//   flatRate: string[]         `provider/model` globs billed per request or subscription: never compacted (default [])
//   excludeSessions: string[]  session IDs never compacted by this plugin (idle, warm or child scope) (default [])
//   topLevelCache: string[]    `provider/model` globs where a breakpoint-less body gets a top-level marker (default [])
//   coreCompactionWarm: boolean  true prices the summary warm, false cold; omitted: warm except native compaction
//                              (upstream PR 57091 fixed cache-preserving compaction, in releases since v2.1.0)
//   debug: boolean             log per-request cache usage and compaction skips to the log file (default false)
//   logFile: string            default ~/.local/state/opencode/anthropic-cache.jsonl

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID = "anthropic-cache";
// Each entry holds the session's last request body (up to a few MB at 1M context); oldest evicted.
const MAX_SESSIONS = 16;
const MAX_WARMS = 12; // hard cap on billed replays per idle stretch, whatever the timing options say
const sessions = new Map(); // sessionID -> { ctx, owned, url, text, model, lastActive, touched, timer, warms }
const warming = new Set(); // sessionIDs whose warm carrier is in flight

const MIN = 60_000;
const FRAME_FIELDS = ["system", "instructions", "systemInstruction", "tools", "thinking"]; // what a cached prefix depends on
const NATIVE_PROMPT = "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";
const CATALOG_TTL = 10 * MIN; // catalog refresh interval
const CATALOG_RETRY = MIN; // a model missing from the catalog (or a failed fetch) is retried at most this often
const MAX_TRACK = 500; // sessions whose idle state is kept; oldest evicted (small records, no bodies)

// The conversation array of a request body (chat `messages`, responses `input`, or `contents`) and its key.
const convKey = (body) => ["messages", "input", "contents"].find((k) => Array.isArray(body?.[k]));
// Text of the LAST user message of a request body: string content, or the text parts joined.
function lastUserText(body) {
  const k = convKey(body);
  const m = k && [...body[k]].reverse().find((x) => x?.role === "user");
  const c = m?.content ?? m?.parts;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : undefined;
}
const key = (model) => `${model.providerID}/${model.id}`;
// `*` matches any characters (including `/`) against `providerID/id`.
const glob = (g) => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*") + "$");
// The provider bills cache writes (any price tier): the only sign, from the catalog, that a cache TTL is worth setting.
export const writes = (info) => !!info?.cost?.some((c) => c.cache?.write > 0);
// Price entry for a context size: the tier with the largest `tier.size` below `tokens`, else the untiered entry.
function price(info, tokens) {
  const costs = info?.cost ?? [];
  const tier = costs.filter((c) => c.tier && c.tier.size < tokens).sort((a, b) => b.tier.size - a.tier.size)[0];
  return tier ?? costs.find((c) => !c.tier) ?? costs[0];
}
// Expected USD saved by compacting an idle context of `tokens`: the cold re-read avoided (times the chance of a
// resume) minus what the summary itself costs (reading the context, writing ~4000 tokens). The read is a warm cache
// read only when `warmRead`; otherwise it is as cold as the avoided re-read. undefined = unpriced.
export function saving(info, tokens, rate, warmRead = true) {
  const c = price(info, tokens);
  if (!c) return undefined;
  const cold = c.cache?.write > 0 ? c.cache.write : c.input;
  const self = (tokens * (warmRead ? c.cache?.read ?? c.input : cold) + 4000 * c.output) / 1e6;
  return (rate * Math.max(0, tokens - 4000) * cold) / 1e6 - self;
}

// Force every ephemeral breakpoint to one TTL (mixed TTLs must run longest-first, so all-equal is the safe shape).
// A body with no breakpoint gets a top-level `cache_control` only when `top` is set. Returns undefined for anything else.
export function cacheBody(text, ttl, top = false) {
  let body;
  try { body = JSON.parse(text); } catch { return undefined; }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages)) return undefined;
  let breakpoints = 0;
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "cache_control" && child && typeof child === "object" && child.type === "ephemeral") {
        breakpoints += 1;
        child.ttl = ttl;
      } else walk(child);
    }
  };
  walk(body);
  const topLevel = breakpoints === 0 && top;
  if (topLevel) body.cache_control = { type: "ephemeral", ttl };
  return { text: JSON.stringify(body), body, breakpoints, topLevel };
}

// The warm replay keeps everything that is rendered into the cached prefix and caps output at one token.
export function warmText(text) {
  const body = JSON.parse(text);
  if ("max_completion_tokens" in body) body.max_completion_tokens = 1;
  else body.max_tokens = 1;
  return JSON.stringify(body);
}

// A thinking budget needs max_tokens > budget, so a one-token replay would be rejected: Anthropic `thinking.type
// "enabled"`, or an OpenRouter `reasoning` request (translated to a budget for Claude). Adaptive thinking is fine.
export function warmable(body) {
  if (body?.thinking?.type === "enabled") return false;
  const r = body?.reasoning;
  return !(r && typeof r === "object" && r.enabled !== false && r.effort !== "none" && (r.effort || r.max_tokens || r.enabled));
}

function options(raw = {}) {
  const ttl = raw.ttl === "5m" ? "5m" : "1h";
  const num = (v, d, max = Infinity) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < max ? v : d);
  const globs = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === "string" && g).map(glob) : []);
  const ttlMinutes = ttl === "1h" ? 60 : 5;
  return {
    ttl,
    subagents: raw.subagents === true,
    keepWarm: raw.keepWarm !== false,
    // A warm at or after the TTL finds the entry gone, and would overflow setTimeout for huge values.
    warmAfterMs: num(raw.warmAfterMinutes, ttl === "1h" ? 55 : 4, ttlMinutes) * MIN,
    // Values >= 60 need OpenCode's experimental.location_idle_timeout set above them;
    // otherwise the location unloads first and warming stops early.
    maxIdleMs: num(raw.maxIdleMinutes, 50, 24 * 60) * MIN,
    nativeWarmPrompt: typeof raw.nativeWarmPrompt === "string" && raw.nativeWarmPrompt ? raw.nativeWarmPrompt : NATIVE_PROMPT,
    compactOnIdle: raw.compactOnIdle !== false,
    rootCompact: raw.rootCompact !== false,
    idleCompactMs: num(raw.idleCompactMinutes, 30, 60) * MIN,
    childCompact: raw.childCompact !== false,
    childIdleMs: num(raw.childIdleSeconds, 90, 24 * 3600) * 1000,
    childResumeRate: typeof raw.childResumeRate === "number" && raw.childResumeRate >= 0 && raw.childResumeRate <= 1 ? raw.childResumeRate : 0.3,
    coreCompactionWarm: typeof raw.coreCompactionWarm === "boolean" ? raw.coreCompactionWarm : undefined,

    compactMinTokens: num(raw.compactMinTokens, 100_000),
    compactSaveMin: typeof raw.compactSaveMin === "number" && raw.compactSaveMin >= 0 ? raw.compactSaveMin : 0.02,
    compactUnpriced: raw.compactUnpriced !== false,
    flatRate: globs(raw.flatRate),
    excludeSessions: new Set(Array.isArray(raw.excludeSessions) ? raw.excludeSessions.filter((s) => typeof s === "string" && s) : []),
    topLevelCache: globs(raw.topLevelCache),
    debug: raw.debug === true,
    logFile: typeof raw.logFile === "string" && raw.logFile
      ? raw.logFile
      : join(homedir(), ".local", "state", "opencode", "anthropic-cache.jsonl"),
  };
}

function rebuild(request, text) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: text, signal: request.signal, redirect: request.redirect });
}

// Scan a cloned response for Anthropic (message_start / JSON) or OpenAI-style usage.
async function usageOf(response) {
  const text = await response.text();
  const usage = {};
  const merge = (u) => u && typeof u === "object" && Object.assign(usage, u);
  for (const line of text.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    try { const e = JSON.parse(data); merge(e.message?.usage); merge(e.response?.usage); merge(e.usage); } catch { /* partial line */ }
  }
  if (!Object.keys(usage).length) try { merge(JSON.parse(text).usage); } catch { /* not JSON */ }
  return usage;
}

// Next prompt includes the reply; prompt_tokens already includes cached input, unlike Anthropic input_tokens.
export function usageTokens(usage) {
  const parts = usage.prompt_tokens !== undefined ? [usage.prompt_tokens]
    : [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
  parts.push(usage.output_tokens ?? usage.completion_tokens ?? 0);
  if (!parts.every((n) => Number.isFinite(n) && n >= 0)) return undefined;
  const tokens = parts.reduce((sum, n) => sum + n, 0);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

// Compaction id of one idle stretch, in OpenCode's message-id shape (`Identifier.create(false, idleAt)` with counter 1:
// `msg_` + the low 48 bits of idleAt * 0x1000 + 1 as 12 hex chars + 14 base62 chars; here the tail comes from a hash of
// session and idle time, not from random bytes). Every process that compacts this stretch sends the same id, so core admits it once.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function idleCompactID(sessionID, idleAt) {
  const time = ((BigInt(Math.trunc(idleAt)) * 0x1000n + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0");
  const hash = createHash("sha256").update(`${sessionID}:${idleAt}`).digest();
  return "msg_" + time + Array.from(hash.subarray(0, 14), (b) => BASE62[b % 62]).join("");
}
// Core fails `session.compact` for a held id with `Session.CompactionConflictError` (a thrown object with `_tag`, no
// message); over HTTP it is a ConflictError whose message says so.
const isCompactionConflict = (error) => error?._tag === "Session.CompactionConflictError"
  || /conflicts with an existing durable record/.test(String(error?.message ?? ""));
// Media sizes as OpenCode core's compaction.ts (v2.3.2) counts them: IMAGE_TOKEN_ESTIMATE, PDF_TOKEN_ESTIMATE, other media 0.
const IMAGE_TOKEN_ESTIMATE = 1500;
const PDF_TOKEN_ESTIMATE = 2000;
const mediaTokens = (mime) => (mime.startsWith("image/") ? IMAGE_TOKEN_ESTIMATE : mime === "application/pdf" ? PDF_TOKEN_ESTIMATE : 0);
// Tokens of a JSON value at ~4 chars/token. A typed media object (a string `mime`, `mediaType` or `media_type`, and a
// string payload `data` or `uri`: a tool-result file, a user attachment, a context-hook asset or an Anthropic base64
// source) counts as core counts it, by its image/PDF type, with the payload left out of the characters. Strings on their
// own (a data URI included) and other media types stay text: core counts those media 0, keeping their characters is the old,
// conservative size. Throws only like JSON.stringify (circular, BigInt).
export function sizeTokens(value) {
  let media = 0;
  const json = JSON.stringify(value, (_k, v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const mime = [v.mime, v.mediaType, v.media_type].find((m) => typeof m === "string")?.toLowerCase();
    const field = ["data", "uri"].find((f) => typeof v[f] === "string");
    const tokens = mime && field ? mediaTokens(mime) : 0;
    if (!tokens) return v;
    media += tokens;
    return { ...v, [field]: "" };
  });
  return (json?.length ?? 0) / 4 + media;
}
// A request body held as text (a stored request): parsed once; text that is not JSON keeps the plain character count.
function textTokens(text) {
  try { return sizeTokens(JSON.parse(text)); } catch { return text.length / 4; }
}
// Prompt size as OpenCode core measures it (`estimatePrompt`): the newest assistant message of the current provider with
// a measured prompt (`hasMeasuredPrompt`: no error, input + cache read + cache write above 0; another provider's count may
// describe a window this one cannot replay), plus ~4 chars/token for what that usage did not cover: the anchor's own
// settled local tool results (the provider never saw them) and every later message. undefined = no usable usage in the context.
function contextTokens(messages, providerID) {
  if (!Array.isArray(messages) || providerID === undefined) return undefined;
  const i = messages.findLastIndex((m) => m?.type === "assistant" && m.model?.providerID === providerID && !m.error && m.tokens
    && m.tokens.input + (m.tokens.cache?.read ?? 0) + (m.tokens.cache?.write ?? 0) > 0);
  if (i < 0) return undefined;
  const { input, output, reasoning, cache } = messages[i].tokens;
  const parts = [input, output, reasoning, cache?.read, cache?.write];
  if (!parts.every((n) => Number.isFinite(n) && n >= 0)) return undefined;
  const measured = parts.reduce((sum, n) => sum + n, 0);
  const results = (messages[i].content ?? [])
    .filter((c) => c?.type === "tool" && c.executed !== true && (c.state?.status === "completed" || c.state?.status === "error"))
    .map((c) => c.state.status === "error" ? { error: c.state.error, content: c.state.content ?? [] } : c.state.content).filter(Boolean); // as core replays them
  const unseen = [...results, ...messages.slice(i + 1)];
  return measured > 0 ? measured + (unseen.length ? sizeTokens(unseen) : 0) : undefined;
}

export default {
  id: ID,
  async setup(ctx) {
    const opt = options(ctx.options);
    const log = (entry) => {
      try {
        mkdirSync(dirname(opt.logFile), { recursive: true, mode: 0o700 });
        appendFileSync(opt.logFile, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + "\n", { mode: 0o600 });
      } catch { /* logging must never break a request */ }
    };
    if (opt.debug) log({ event: "setup", directory: ctx.location?.directory, ttl: opt.ttl, subagents: opt.subagents, keepWarm: opt.keepWarm, warmAfterMs: opt.warmAfterMs, maxIdleMs: opt.maxIdleMs, idleCompactMs: opt.idleCompactMs, childIdleMs: opt.childIdleMs });
    if ((opt.compactOnIdle || opt.childCompact) && typeof ctx.session.compact === "function") {
      log({ event: "compact.enabled", directory: ctx.location?.directory, compactMinTokens: opt.compactMinTokens });
    }
    const owned = new Set();
    const excludedLogged = new Set();
    const excluded = (sessionID) => {
      if (!opt.excludeSessions.has(sessionID)) return false;
      if (opt.debug || !excludedLogged.has(sessionID)) {
        excludedLogged.add(sessionID);
        log({ event: "compact.excluded", sessionID });
      }
      return true;
    };
    // Final Request of a native warm -> { s, at }. http.response carries that same Request object, so only the response
    // to this exact request counts as the touch; a request whose response never comes is garbage-collected with it.
    const nativePending = new WeakMap();
    const primaryPending = new WeakMap(); // final Request -> { t, seq }: usage belongs to this activity, not a later step
    // Frames hold a session's last system/tools/options (can be MBs); only the 32 most recent sessions.
    const MAX_FRAMES = 32;
    const frames = new Map(); // sessionID -> { url, key, rest }: last real request minus its conversation
    const track = new Map(); // sessionID -> { seq, timer, due, child, warm, model, tokens, compacted }: idle-compaction state per session
    const live = new Set(); // sessionIDs touched or compacted on this instance: restore scan skips them
    const ops = new Map(); // sessionID -> tail Promise of serialized storage writes/removes
    const dir = ctx.location?.directory, ws = ctx.location?.workspaceID;
    let storageFailed = false;
    const onStorageErr = (error) => {
      if (storageFailed) return;
      storageFailed = true;
      log({ event: "storage.failed", error: String(error?.message ?? error).slice(0, 200) });
    };
    const runOp = (sessionID, fn) => {
      const p = (ops.get(sessionID) ?? Promise.resolve()).then(fn).catch(onStorageErr);
      ops.set(sessionID, p);
      void p.then(() => { if (ops.get(sessionID) === p) ops.delete(sessionID); });
    };
    const saveIdle = (sessionID, t, due) => {
      t.due = due; // retain the deadline below threshold too: later provider usage can make it worth persisting
      if (!(t.tokens >= opt.compactMinTokens)) return dropIdle(sessionID);
      const v = { dir, ws, child: !!t.child, warm: !!t.warm, model: t.model, tokens: t.tokens, sized: t.sized, due };
      runOp(sessionID, () => ctx.storage?.set(`idle/${sessionID}`, v));
    };
    const dropIdle = (sessionID) => runOp(sessionID, () => ctx.storage?.remove(`idle/${sessionID}`));

    // Model catalog: ctx.model.list(), cached; a missing model or a failed fetch means "unknown" until the next retry.
    let cat; // { at, map }
    const catalog = async (model) => {
      const age = cat ? Date.now() - cat.at : Infinity;
      if (age > CATALOG_TTL || (!cat.map.has(key(model)) && age > CATALOG_RETRY)) {
        const at = Date.now();
        try {
          cat = { at, map: new Map((await ctx.model.list()).data.map((m) => [key(m), m])) };
        } catch (error) {
          cat = { at, map: new Map() };
          log({ event: "catalog.failed", error: String(error?.message ?? error).slice(0, 200) });
        }
      }
      return cat.map.get(key(model));
    };
    const matches = (globs, model) => globs.some((g) => g.test(key(model)));

    const stop = (sessionID, reason) => {
      const s = sessions.get(sessionID);
      if (!s) return;
      clearTimeout(s.timer);
      sessions.delete(sessionID);
      s.owned.delete(sessionID); // the owning instance's set, even when another location evicts it
      if (reason) log({ event: "warm.stop", sessionID, reason });
    };
    // Real activity on a session (a context event or a primary request): cancels its idle timer, voids any compaction
    // already waiting for idle (seq changed), and lifts the idle-compacted veto.
    const touch = (sessionID) => {
      live.add(sessionID);
      let t = track.get(sessionID);
      if (t) track.delete(sessionID);
      else t = { seq: 0 };
      track.set(sessionID, t); // re-insert: Map order = recency for eviction
      clearTimeout(t.timer);
      t.seq += 1;
      t.due = undefined;
      t.compacted = false;
      while (track.size > MAX_TRACK) {
        const [id, old] = track.entries().next().value;
        clearTimeout(old.timer);
        track.delete(id);
      }
      return t;
    };
    // Any compaction (ours or OpenCode's): the stored body is the dead pre-compaction prefix, pending timers are moot.
    // Does not lift the idle-compacted veto: that needs real activity.
    const onCompaction = (sessionID) => {
      live.add(sessionID);
      const t = track.get(sessionID);
      if (t) { clearTimeout(t.timer); t.seq += 1; }
      stop(sessionID, "compacted");
      dropIdle(sessionID);
    };

    // Compaction decision from the catalog economics: { why } to skip, { basis: "size" } to compact on size alone
    // (unpriced), {} to compact on economics.
    const unworthy = async (model, tokens, scope) => {
      if (!model || !(tokens >= opt.compactMinTokens)) return { why: "below compactMinTokens" };
      if (matches(opt.flatRate, model)) return { why: "flatRate" };
      const info = await catalog(model);
      const warmRead = opt.coreCompactionWarm ?? (info?.settings?.compaction?.type !== "native");
      const gain = saving(info, tokens, scope === "child" ? opt.childResumeRate : 1, warmRead);
      if (gain === undefined) return opt.compactUnpriced ? { basis: "size" } : { why: "unpriced" };
      return gain >= opt.compactSaveMin ? {} : { why: `saving ${gain.toFixed(4)} below compactSaveMin` };
    };
    const idleCompact = async (sessionID, scope, seq) => {
      const t = track.get(sessionID);
      const s = sessions.get(sessionID);
      const skip = (reason) => { if (opt.debug) log({ event: "compact.skip", sessionID, scope, reason }); };
      if (!t) return skip("untracked");
      if (excluded(sessionID)) {
        if (scope === "warm") stop(sessionID, "idle-limit");
        dropIdle(sessionID);
        return skip("excluded");
      }
      if (scope !== "warm" && s) return skip("plugin-warmed"); // its own final tick decides
      // Provider input + output from the last primary response; ~4 chars/token only when usage is unavailable.
      let tokens = t.tokens ?? (s && textTokens(s.text));
      // Busy detection starts NOW, before the catalog await: a session busy when the timer fired must count as busy even
      // if it settles during that await, and catalog time must not count as wait time. The wait is timed inside the
      // wrapper. `w` never rejects ({ ok: false } = the wait failed), so no unhandled rejection.
      const started = Date.now();
      const w = (async () => {
        try { await ctx.session.wait?.({ sessionID }); return { ok: true, ms: Date.now() - started }; } catch { return { ok: false }; }
      })();
      // The session's active context (an array), read once and only after the session settled, so it is never an in-flight sample.
      const hasContext = typeof ctx.session.context === "function";
      // A failed or non-array read is [] (no usable usage, nothing compacted), so it is not read a second time.
      const readContext = async () => {
        const failed = (error) => { log({ event: "compact.context-failed", sessionID, error }); return []; };
        try {
          const m = await ctx.session.context({ sessionID });
          return Array.isArray(m) ? m : failed("not an array");
        } catch (e) { return failed([e?._tag, e?.name].find((x) => typeof x === "string") ?? "error"); } // never the message: it can carry session content
      };
      // No HTTP usage was seen (a route whose responses this plugin cannot read, such as a provider that keeps its own
      // session): the character estimate overstates the real context, so size from the usage OpenCode recorded.
      // A completed compaction with no usable anchor after it (another process or a hand compaction ran) replaced the basis
      // of any earlier size, so then the whole context core would send is sized at ~4 chars/token, even over HTTP usage.
      if (hasContext && (await w).ok) {
        const was = t.sized;
        const history = await readContext();
        let measured = contextTokens(history, (t.model ?? s?.model)?.providerID);
        const compacted = measured === undefined && history.some((m) => m?.type === "compaction" && m.status === "completed");
        if (compacted) measured = sizeTokens(history);
        // Apply only while nothing newer arrived during the read: same record, same activity, no HTTP usage since.
        const fresh = compacted || (was !== "usage" && was !== "session");
        if (measured !== undefined && fresh && track.get(sessionID) === t && t.seq === seq && !(t.sized === "usage" && was !== "usage")) { tokens = t.tokens = measured; t.sized = "session"; }
        tokens = t.tokens ?? tokens; // HTTP usage of this same request may have arrived during the read: decide on that, not on the stale local value
      }
      const estimatedTokens = Math.round(tokens);
      const { why, basis } = await unworthy(t.model ?? s?.model, tokens, scope);
      // The session moved on while the catalog was read: this timer is stale, leave the new state alone.
      if (track.get(sessionID) !== t || (scope === "warm" && sessions.get(sessionID) !== s)) return skip("superseded");
      if (t.seq !== seq) { // activity on the same record (touch bumps seq in place)
        if (scope === "warm") stop(sessionID, "new activity");
        return skip("new activity");
      }
      if (why) {
        if (scope === "warm") stop(sessionID, "idle-limit");
        dropIdle(sessionID);
        return skip(why);
      }
      if (typeof ctx.session.compact !== "function") {
        stop(sessionID);
        return log({ event: "compact.unavailable", sessionID, estimatedTokens });
      }
      // The quiet period counts from idle: if the session was still busy, restart a full period after it settles.
      const waited = await w;
      if (!waited.ok) return skip("wait failed");
      const quiet = scope === "child" ? opt.childIdleMs : opt.idleCompactMs;
      // Core's exact signal: `time.idle` is when the session's execution last ended.
      const info = await Promise.resolve(ctx.session.get?.({ sessionID })).catch(() => undefined);
      if (track.get(sessionID) !== t || t.seq !== seq) {
        if (scope === "warm") stop(sessionID, "new activity"); // the root idle timer armed by that activity takes over
        return skip("new activity");
      }
      if (t.compacted) return skip("already compacted");
      const idleAt = info?.time?.idle;
      // Without `time.idle`, heuristic: an idle session's wait still takes a few ms (DB read, runtime bridge),
      // so "busy" = the wait took at least min(1 s, half the quiet period).
      const rearm = typeof idleAt === "number" ? Math.min(quiet, quiet - (Date.now() - idleAt)) : waited.ms >= Math.min(1000, quiet / 2) ? quiet : 0;
      if (rearm > 0) {
        clearTimeout(t.timer);
        t.timer = setTimeout(() => void idleCompact(sessionID, scope, seq), rearm);
        t.timer.unref?.();
        saveIdle(sessionID, t, Date.now() + rearm);
        return skip(typeof idleAt === "number" ? "busy: quiet period from time.idle" : "busy: quiet period restarted");
      }
      stop(sessionID);
      t.compacted = true;
      // One id per idle stretch: a second process that fires the same persisted deadline sends the same id.
      const id = typeof idleAt === "number" && Number.isFinite(idleAt) ? idleCompactID(sessionID, idleAt) : undefined;
      try {
        const res = await ctx.session.compact({ sessionID, ...(id && { id }), delivery: "queue" });
        dropIdle(sessionID);
        log({ event: "compact.idle", sessionID, scope, estimatedTokens, inboxID: res?.id ?? id, ...(basis && { basis }) });
      } catch (error) {
        if (isCompactionConflict(error)) { // this idle stretch was already compacted, by another process
          dropIdle(sessionID);
          return log({ event: "compact.duplicate", sessionID, scope, inboxID: id });
        }
        t.compacted = false;
        log({ event: "compact.failed", sessionID, scope, error: String(error?.message ?? error).slice(0, 200) });
      }
    };
    // Root and child sessions that are not plugin-warmed: compact after a quiet period since the last real activity.
    const armIdle = (sessionID, due) => {
      const t = track.get(sessionID);
      if (!t) return;
      clearTimeout(t.timer);
      t.warm = false;
      const scope = t.child ? "child" : "root";
      if (excluded(sessionID) || !(t.child ? opt.childCompact : opt.compactOnIdle && opt.rootCompact)) return dropIdle(sessionID);
      const seq = t.seq;
      const quiet = t.child ? opt.childIdleMs : opt.idleCompactMs;
      due ??= Date.now() + quiet;
      t.timer = setTimeout(() => void idleCompact(sessionID, scope, seq), Math.max(0, due - Date.now()));
      t.timer.unref?.();
      saveIdle(sessionID, t, due);
    };

    const schedule = (sessionID) => {
      const s = sessions.get(sessionID);
      if (!s) return;
      clearTimeout(s.timer);
      const due = s.touched + opt.warmAfterMs;
      if (due - s.lastActive > opt.maxIdleMs) {
        if (!opt.compactOnIdle || excluded(sessionID)) return stop(sessionID, "idle-limit");
        // The final tick: the next warm would pass the idle limit, so compact at the limit instead.
        const at = Math.min(due, s.lastActive + opt.maxIdleMs);
        const seq = track.get(sessionID)?.seq; // activity since now (not since the tick fires) voids this compaction
        s.timer = setTimeout(() => void idleCompact(sessionID, "warm", seq), Math.max(0, at - Date.now()));
        s.timer.unref?.();
        return;
      }
      if (s.warms >= MAX_WARMS) return stop(sessionID, "warm-limit");
      const seq = track.get(sessionID)?.seq; // context-only activity (no primary request) since now voids this replay
      s.timer = setTimeout(() => void warm(sessionID, seq), Math.max(0, due - Date.now()));
      s.timer.unref?.();
    };
    const warm = async (sessionID, seq) => {
      const s = sessions.get(sessionID);
      if (!s || warming.has(sessionID)) return; // a carrier is still in flight; its response reschedules
      if (track.get(sessionID)?.seq !== seq) return stop(sessionID, "new activity"); // the root idle timer takes over
      s.warms += 1;
      s.touched = Date.now(); // the carrier is a cache touch; also keeps the next tick a full interval away if its HTTP hook never ran
      warming.add(sessionID);
      try {
        await s.ctx.session.generate({ sessionID, prompt: opt.nativeWarmPrompt });
        // Re-arm only after the carrier finished, so one session never has two carriers in flight.
        if (sessions.get(sessionID) === s) schedule(sessionID);
      } catch (error) {
        stop(sessionID, `generate failed: ${String(error?.message ?? error).slice(0, 200)}`);
      } finally {
        warming.delete(sessionID);
      }
    };

    // Same rewrite a real request gets on this route: explicit breakpoints on a cache-write-priced route, or the
    // top-level marker on a `topLevelCache` route (so these generates can read the cache real requests wrote).
    // A child session keeps its own policy: no rewrite unless `subagents`.
    const rewriteTtl = async (event, text) => {
      if (track.get(event.sessionID)?.child && !opt.subagents) return false;
      const top = matches(opt.topLevelCache, event.model);
      if (!(writes(await catalog(event.model)) || top)) return false;
      const cached = cacheBody(text, opt.ttl, top);
      if (!cached?.breakpoints && !cached?.topLevel) return false;
      event.request = rebuild(event.request, cached.text);
      return true;
    };
    // A native warm is sent with the prefix-relevant fields of the session's last real
    // request (FRAME_FIELDS: system, tools and thinking, which other plugins' context hooks may have changed) and its
    // own conversation and output controls, so its prefix matches the cached entry. Only for the same route and conversation key, and never over chained server-side
    // state (`previous_response_id` in the frame or in the generate body). Then the usual TTL rewrite. Returns whether
    // the TTL rewrite applied.
    const prepareGenerate = async (event, text) => {
      const { sessionID, request } = event;
      const f = frames.get(sessionID);
      let swapped = false;
      if (f && request.url === f.url && !f.rest.previous_response_id) {
        try {
          const b = JSON.parse(text);
          if (Array.isArray(b?.[f.key]) && !b.previous_response_id) {
            for (const field of FRAME_FIELDS) { if (field in f.rest) b[field] = f.rest[field]; else delete b[field]; }
            text = JSON.stringify(b);
            swapped = true;
          }
        } catch { /* not JSON: leave it */ }
      }
      const rewritten = await rewriteTtl(event, text);
      if (swapped && !rewritten) event.request = rebuild(request, text);
      return rewritten;
    };
    const storeFrame = async (event, body) => {
      const { sessionID, request } = event;
      frames.delete(sessionID); // a primary that cannot be represented below must not leave the previous frame behind
      if (request.method !== "POST" || request.body === null) return;
      if (!body) try { body = JSON.parse(await event.request.clone().text()); } catch { return; }
      const key = convKey(body);
      if (!key) return;
      const { [key]: _conversation, ...rest } = body;
      frames.set(sessionID, { url: request.url, key, rest });
      while (frames.size > MAX_FRAMES) frames.delete(frames.keys().next().value);
    };
    // A native warm (OpenCode's keep-alive generate: its prompt is the LAST user message): TTL rewrite when eligible,
    // a cache touch once it succeeds, or abort when the plugin already compacted the idle session.
    const nativeWarm = async (event) => {
      const { sessionID, request } = event;
      if (request.method !== "POST" || request.body === null) return;
      const text = await request.clone().text();
      let body;
      try { body = JSON.parse(text); } catch { return; }
      if (lastUserText(body) !== opt.nativeWarmPrompt) return;
      if (track.get(sessionID)?.compacted) {
        log({ event: "native.warm.vetoed", sessionID });
        throw new Error(`${ID}: idle-compacted session; native warm skipped`);
      }
      const s = sessions.get(sessionID); // the record this warm is for, taken before any await
      if (!(await prepareGenerate(event, text))) return;
      if (s && sessions.get(sessionID) === s) nativePending.set(event.request, { s, at: Date.now() }); // the request as sent, after the rewrite
    };

    // The real request: rewrite it and, for a root session on an explicit-breakpoint route, store it for warming.
    // Returns true when the session is now plugin-warmed.
    const primary = async (event, child, seen) => {
      const { sessionID, model, request } = event;
      const info = await catalog(model);
      const top = matches(opt.topLevelCache, model);
      // A real request on another route ends warming: the stored body no longer matches what the session sends.
      if (!(writes(info) || top) || request.method !== "POST" || request.body === null || !(opt.subagents || !child)) {
        stop(sessionID, "route changed");
        return false;
      }
      const cachedBody = cacheBody(await request.clone().text(), opt.ttl, top);
      if (!cachedBody) { stop(sessionID, "not a messages body"); return false; }
      const { text, body } = cachedBody;
      seen.body = body;
      if (!cachedBody.breakpoints && !cachedBody.topLevel) { stop(sessionID, "no explicit breakpoints"); return false; }
      event.request = rebuild(request, text);
      if (opt.debug) log({ event: "request", sessionID, provider: model.providerID, model: model.id, child, breakpoints: cachedBody.breakpoints, topLevel: cachedBody.topLevel, ttl: opt.ttl });
      if (!opt.keepWarm || child) return false;
      const prior = sessions.get(sessionID);
      clearTimeout(prior?.timer);
      if (!warmable(body)) { stop(sessionID, prior ? "thinking budget" : undefined); return false; }
      // Replays are verified only for explicit breakpoints. With a top-level marker a live replay missed and rewrote
      // the prefix (upstream selection is per request), so such routes are never warmed.
      if (cachedBody.topLevel) { stop(sessionID, prior ? "no explicit breakpoints" : undefined); return false; }
      sessions.delete(sessionID); // re-insert to keep Map order = recency for eviction
      const now = Date.now();
      sessions.set(sessionID, { ctx, owned, url: request.url, text, model, lastActive: now, touched: now, timer: undefined, warms: 0 });
      owned.add(sessionID);
      while (sessions.size > MAX_SESSIONS) stop(sessions.keys().next().value, "evicted");
      const t = track.get(sessionID);
      if (t) {
        t.warm = true;
        if (t.tokens === undefined) { // sizing never rejects a request: the plain character count is the fallback
          try { t.tokens = sizeTokens(body); } catch { t.tokens = text.length / 4; }
          t.sized = "chars";
        }
        if (opt.compactOnIdle && !excluded(sessionID)) saveIdle(sessionID, t, now + opt.maxIdleMs);
        else if (opt.compactOnIdle) dropIdle(sessionID);
      }
      return true;
    };

    await ctx.session.hook("context", async (event) => {
      const { sessionID } = event;
      const t = touch(sessionID);
      t.model = event.model;
      // New step's fallback; its primary response replaces this with provider usage once the stream ends.
      t.sized = "chars";
      try { t.tokens = sizeTokens({ system: event.system, messages: event.messages }); } catch { t.tokens = undefined; }
      if (t.child === undefined) {
        try { t.child = !!(await ctx.session.get({ sessionID }))?.parentID; } catch { t.child = false; }
      }
      armIdle(sessionID);
    });

    // Any compaction stops warming and clears pending idle timers.
    await ctx.session.hook("compaction", async ({ sessionID }) => {
      onCompaction(sessionID);
    });

    await ctx.session.hook("http.request", async (event) => {
      const { sessionID, kind, model } = event;
      const request = event.request;
      if (kind === "generate" && warming.has(sessionID)) {
        const s = sessions.get(sessionID);
        // Abort rather than let a transient generate run a full, uncached request on another route.
        if (!s || s.url !== request.url) throw new Error(`${ID}: warm route changed; not warming`);
        s.touched = Date.now();
        event.request = rebuild(request, warmText(s.text));
        log({ event: "warm.send", sessionID, provider: model.providerID, model: model.id });
        return;
      }
      if (kind === "compaction") return onCompaction(sessionID);
      if (kind === "generate") return nativeWarm(event);
      if (kind !== "primary") return;
      // A real request cancels any pending warm, final tick or idle compaction at once, before any read below yields.
      clearTimeout(sessions.get(sessionID)?.timer);
      const t = touch(sessionID);
      const seq = t.seq;
      const child = request.headers.has("x-parent-session-id");
      t.child = !!(t.child || child);
      t.model = model;
      let warmed = false;
      const seen = {};
      try { warmed = await primary(event, child, seen); } finally { if (!warmed) armIdle(sessionID); }
      primaryPending.set(event.request, { t, seq });
      await storeFrame(event, seen.body); // every route, rewritten or not
    });

    await ctx.session.hook("http.response", async (event) => {
      const { sessionID, kind, model } = event;
      const ours = kind === "generate" && warming.has(sessionID);
      const debugUsage = opt.debug && (ours || (kind === "primary" && writes(cat?.map.get(key(model)))));
      if (kind === "primary" || debugUsage) {
        const pending = primaryPending.get(event.request);
        try {
          void usageOf(event.response.clone())
            .then((usage) => {
              if (debugUsage) log({ event: ours ? "warm.usage" : "usage", sessionID, kind, provider: model.providerID, model: model.id, status: event.response.status, usage });
              const tokens = usageTokens(usage);
              if (kind !== "primary" || tokens === undefined || !pending) return;
              const { t, seq } = pending;
              if (track.get(sessionID) !== t || t.seq !== seq || t.compacted) return;
              const grew = !(t.tokens >= opt.compactMinTokens) && tokens >= opt.compactMinTokens;
              t.tokens = tokens;
              t.sized = "usage";
              if (t.due !== undefined) {
                // A long stream may have outlasted a below-threshold idle check; warm sessions keep their own final tick.
                if (grew && !sessions.has(sessionID) && (!t.timer || t.timer._destroyed)) armIdle(sessionID, t.due);
                else saveIdle(sessionID, t, t.due);
              }
            })
            .catch(() => {});
        } catch { /* body already consumed by another hook; usage is best effort */ }
      }
      if (kind === "generate" && !ours) {
        // A native warm counts as a cache touch only once it succeeded, and only for the same session record.
        const pending = nativePending.get(event.request);
        if (pending && event.response.ok && sessions.get(sessionID) === pending.s) {
          pending.s.touched = Math.max(pending.s.touched, pending.at);
          schedule(sessionID);
        }
      }
      const s = sessions.get(sessionID);
      if (!s || !(ours || kind === "primary")) return;
      if (!event.response.ok) return stop(sessionID, `http ${event.response.status}`);
      if (!ours) schedule(sessionID);
    });

    // A failed warm must not be retried into repeated billed calls.
    await ctx.session.hook("retry", (event) => {
      if (warming.has(event.sessionID)) event.decision = { retry: false };
    });

    let unloaded = false;
    if (ctx.storage?.scan && (opt.compactOnIdle || opt.childCompact)) {
      void (async () => {
        let after, count = 0;
        do {
          const page = await ctx.storage.scan({ prefix: "idle/", ...(after && { after }) });
          if (unloaded) return;
          const now = Date.now();
          for (const { key: k, value: v } of page?.entries ?? []) {
            if (!v || typeof k !== "string" || !k.startsWith("idle/")) continue;
            if ((v.dir ?? undefined) !== dir || (v.ws ?? undefined) !== ws) continue;
            const sessionID = k.slice(5);
            if (live.has(sessionID) || track.has(sessionID)) continue;
            if (!(typeof v.due === "number") || now > v.due + 60 * MIN) {
              dropIdle(sessionID);
              continue;
            }
            const child = !!v.child;
            if (excluded(sessionID) || !(child ? opt.childCompact : opt.compactOnIdle && (v.warm || opt.rootCompact))) {
              dropIdle(sessionID);
              continue;
            }
            const t = touch(sessionID);
            t.child = child;
            t.warm = !!v.warm;
            t.model = v.model;
            t.tokens = v.tokens;
            t.sized = v.sized === "usage" || v.sized === "session" ? v.sized : "chars"; // records from older versions: unknown
            t.due = v.due;
            const seq = t.seq;
            t.timer = setTimeout(() => void idleCompact(sessionID, child ? "child" : "root", seq), Math.max(0, v.due - now));
            t.timer.unref?.();
            count += 1;
          }
          after = page?.next;
        } while (after);
        if (count > 0) log({ event: "compact.rearmed", count });
      })().catch(onStorageErr);
    }

    return () => {
      unloaded = true;
      for (const id of [...owned]) stop(id, "unload");
      let count = 0;
      for (const t of track.values()) {
        if (t.timer && !t.timer._destroyed) { // Node marks fired/cleared timers with `_destroyed`; a truthy timer object is not still pending.
          clearTimeout(t.timer);
          count += 1;
        }
      }
      if (count) log({ event: "compact.dropped", count });
      track.clear();
      frames.clear();
    };
  },
};
