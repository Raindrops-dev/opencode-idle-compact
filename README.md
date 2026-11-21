# opencode-idle-compact

An OpenCode v2 plugin for prompt-cache lifetime, cache warming and idle compaction. It can set a 1-hour cache lifetime
and refresh the cache while a session is idle. It compacts idle sessions based on context size and estimated savings.

By default, the plugin does not send its own cache-warming requests. OpenCode can set a 1-hour cache and warm it without
this plugin. See [OpenCode's own cache settings](#opencodes-own-cache-settings). The plugin also adds idle compaction.

Each cache-warming request and compaction is a billed provider request. Compaction loses detail. See
[Costs and safety](#costs-and-safety).

[Install](#install) · [Recommended setup](#defaults-and-the-recommended-setup) · [Options](#options) · [Privacy](#privacy)

## Terms

- **Prompt cache:** The provider stores the start of a request, including the system prompt, tools and earlier
  conversation. When the next request starts with the same text, the provider reads it from the cache at a low price.
- **Cache breakpoint:** A `cache_control: {"type": "ephemeral"}` marker in the request body. It tells the provider
  where a cached part ends. Anthropic-style APIs, for example Claude, use these markers.
- **TTL** (time to live): How long the provider keeps a cache entry after its last use.
- **Compaction:** OpenCode replaces the conversation with a short summary. The next request is then small.
- **Root session:** A session that you start. **Child session:** A subagent session that another session starts.
- **Catalog:** The model list that OpenCode gives to plugins (`ctx.model.list()`), with prices per model.

The plugin's internal ID and its default log file still use the old name `anthropic-cache`.

## What it does

The plugin holds no provider or model names. It decides everything from the catalog and from its options.

### 1. A 1-hour cache TTL

An ephemeral breakpoint without a TTL uses the provider's default lifetime, which is 5 minutes on Anthropic. By default,
the plugin rewrites every explicit ephemeral breakpoint to `"ttl": "1h"` when the model's catalog entry has a cache-write
price above 0. It also does this on every route listed in `topLevelCache`, even without a cache-write price. On other
routes, it leaves a model alone when the catalog does not know it or has no cache-write price. The plugin's `ttl` option
replaces any TTL that OpenCode wrote on a rewritten breakpoint, for example from `settings.cache.ttl`. See
[OpenCode's own cache settings](#opencodes-own-cache-settings).

Child sessions keep the TTL that OpenCode sends unless you set `subagents: true`. By default, OpenCode sends none, so the
provider's default applies. Child sessions usually run without pauses and are rarely resumed. One-hour cache writes cost
more than 5-minute writes, so they would mostly be wasted on child sessions.

### 2. Keep-warm

Shortly before the 1-hour cache entry expires, the plugin resends the session's last real request with its output limit set to 1 token
(`max_completion_tokens` when the request has that field, otherwise `max_tokens`).
This request is called a **warm**. If the cached part is still there, the provider reads it and refreshes its TTL. The
plugin does not check whether a warm read the cache. Nothing is added to the session's history.

- The first warm comes `warmAfterMinutes` (default 55) after the last cache touch. A cache touch is a real request, a
  warm, or a warm request from OpenCode's own warming feature. An OpenCode warm counts only when its response is ok,
  the plugin is tracking that session, and the plugin rewrote that warm's TTL.
- Warming stops `maxIdleMinutes` (default 50) after the last real request. With the defaults, the plugin never sends a
  warm of its own. See
  [Defaults and the recommended setup](#defaults-and-the-recommended-setup).
- Only root sessions on routes with explicit breakpoints are warmed. In practice this means Anthropic-style caching,
  for example Claude. Child sessions are never warmed.
- A request is not warmed when its Anthropic `thinking.type` is `"enabled"` (a thinking budget), or when an
  OpenRouter-style `reasoning` object asks for an effort, a `max_tokens` value or `enabled`. A 1-token reply cannot fit
  such a request. Adaptive thinking is warmed.
- To send a warm, the plugin calls `session.generate` with OpenCode's keep-alive prompt. It replaces the request body
  on its way out, so the request goes through OpenCode with its normal sign-in.

### 3. Idle compaction

When a session is idle, the plugin asks OpenCode to compact it according to its size and savings rules. It uses three
scopes:

| Scope | Which sessions | When |
| --- | --- | --- |
| `warm` | Root sessions that the plugin warms | At the last planned tick: the earlier of the next warm and the last real request plus `maxIdleMinutes` |
| `root` | Other root sessions | `idleCompactMinutes` (default 30) after the session's last activity |
| `child` | Child sessions | `childIdleSeconds` (default 90) after the session's last activity |

Each compaction waits until the session is idle. The plugin drops the compaction if the session has new activity in the
meantime. If the session went idle less than a quiet period ago, the plugin waits for the rest of that period.

For priced models, the plugin compacts only when both of these are true:

- The context has at least `compactMinTokens` tokens (default 100000). The size comes from the token counts in the
  provider's last reply. Without those counts, the plugin uses the token usage OpenCode recorded with the newest usable
  answer of the same provider, plus about 4 characters per token for what that usage did not cover. Without either, it
  estimates about 4 characters per token over the serialized request. In these character estimates, inline media that
  carries its type (a `mime`, `mediaType` or `media_type` field next to its `data` or `uri`, as OpenCode and the
  Anthropic request format store it) counts as 1,500 tokens for an image and 2,000 for a PDF, as OpenCode's own
  estimate counts them, plus the characters of the rest of that object; its `data` or `uri` value is not counted. Other media
  types, a bare data URI string and a request body that is not JSON count all their characters, base64 data included.
- The expected saving is at least `compactSaveMin` US dollars (default 0.02).

The expected saving is an estimate. It assumes that the session is resumed later, the summary is about 4000 tokens, and
the catalog prices of the session's model apply. It does not use the actual summary model. Catalog prices are in US
dollars per million tokens, for the context size:

```text
cold   = cache-write price, or the input price when there is no cache-write price
read   = cache-read price, or the input price when there is no cache-read price
saving = (rate × max(0, tokens − 4000) × cold − (tokens × read + 4000 × output price)) / 1,000,000
```

- `rate` is 1 for the `warm` and `root` scopes, and `childResumeRate` (default 0.3) for the `child` scope.
- For models whose catalog entry uses native provider compaction, the read is priced cold (`cold` instead of `read`).
  `coreCompactionWarm` overrides this behavior.
- Models that match `flatRate` are never compacted.
- A model with no prices (no catalog entry, or an empty cost list) compacts on size alone. Set
  `compactUnpriced: false` to skip such models.

### What it does not do

The plugin does not detect each provider's cache window. The TTL is one setting (`ttl`), and `warmAfterMinutes` is one
delay, for every route the plugin handles. The plugin does not detect a cache miss either. See
[Costs and safety](#costs-and-safety).

## OpenCode's own cache settings

OpenCode can give a session a 1-hour cache and keep it warm without this plugin:

- **Cache lifetime** (since v2.2.0). Set `settings.cache.ttl` on a provider or a model, for example `"1h"`. Without it,
  OpenCode sends no TTL and the provider uses its own default, which is 5 minutes on Anthropic. See
  [Cache lifetime](https://opencode.ai/v2/docs/models#cache-lifetime).
- **Warming.** The `warming` setting sends keep-alive requests while you pause. It is off by default. Provider and
  model warming settings (`settings.cache.warming`) and `interval: "auto"` came in v2.2.6. Since v2.2.7, `"auto"` is
  the default. The time between warms is 90% of the model's `cache.ttl`, or 4 minutes when the model has none. Since
  v2.2.7, warming also stops for a session when a warm misses the cache. The `duration` setting controls how long
  warming continues after the last request that is not a warm. Its default is `"30 minutes"`. See
  [Warming](https://opencode.ai/v2/docs/warming).

This example from the OpenCode warming page sets a 1-hour cache for Anthropic and warms it for 2 hours. A cache that
lasts longer than `duration` is not warmed. A 1-hour cache therefore needs a `duration` above the 30-minute default.

```jsonc
{
  "warming": { "duration": "2 hours" },
  "providers": {
    "anthropic": { "settings": { "cache": { "ttl": "1h" } } }
  }
}
```

OpenCode does not compact idle sessions when the price says that this saves money. That is the part this plugin adds.

If you use OpenCode's settings and the plugin together:

- The plugin's `ttl` option replaces the TTL that OpenCode wrote on each breakpoint it rewrites.
- In a session that the plugin warms, each OpenCode warm with an ok response counts as a cache touch, so the plugin's
  own warms come later.
- In OpenCode 2.3.0, OpenCode's own warm requests run plugins' `generate` hook, not their `context` hook. Changes that
  other plugins make to the system prompt or tools in a `context` hook are missing from those warms. The prefix differs,
  the warm misses the cache, and OpenCode stops warming. This is open upstream as
  [anomalyco/opencode#61775](https://github.com/anomalyco/opencode/issues/61775).
- For that reason, the plugin copies the system prompt, the tools and the thinking settings of the session's last
  request into OpenCode's warms, so they match the cached prefix. It does this only when the warm goes to the same URL
  and uses the same conversation field as that request, and never when either request carries `previous_response_id`.

## Why

When a session's cache expires, the next request has to send the whole context again at the cold price. For a long
session, that request can cost more than many cache reads. Keep-warm keeps the cache alive for a while at a low price.
When the session stays idle longer, compaction makes the restart small. A later resume does not pay the cold price for
the whole context.

## Requirements

- **OpenCode v2.** The plugin uses the OpenCode v2 plugin API. It does not work with OpenCode v1 plugins.
- The plugin is in daily use on OpenCode 2.2.6 and 2.3.0. Earlier 2.x releases are untested.
- The default pricing of the summary read assumes that OpenCode's compaction reuses the cache. OpenCode has done this
  since v2.1.0 ([anomalyco/opencode#57091](https://github.com/anomalyco/opencode/pull/57091)).
- **No npm dependencies.** The plugin uses only Node.js built-in modules (`node:fs`, `node:os`, `node:path`).

The plugin uses these parts of the plugin context (`ctx`):

| Call | Use |
| --- | --- |
| `ctx.options` | Reads the plugin's options |
| `ctx.location` | Reads the folder and workspace ID, for stored deadlines and the log |
| `ctx.session.hook("context", ...)` | Notes session activity and starts idle timers |
| `ctx.session.hook("compaction", ...)` | Stops warming and idle timers when a session is compacted |
| `ctx.session.hook("http.request", ...)` | Rewrites the cache TTL and sends warms |
| `ctx.session.hook("http.response", ...)` | Reads token counts and plans the next warm |
| `ctx.session.hook("retry", ...)` | Stops OpenCode from retrying a failed warm |
| `ctx.session.generate` | Sends a warm |
| `ctx.session.compact` | Asks OpenCode to compact an idle session (`delivery: "queue"`) |
| `ctx.session.get` | Tells root from child sessions and reads when a session went idle |
| `ctx.session.wait` | Waits until a session is idle |
| `ctx.session.context` | Reads the session's active context to size it from the recorded token usage |
| `ctx.model.list` | Reads the catalog (cached, refreshed every 10 minutes) |
| `ctx.storage` (`set`, `remove`, `scan`) | Keeps idle-compaction deadlines across plugin reloads |

## Install

1. In the folder that holds your OpenCode config file, clone the plugin:

   ```sh
   git clone https://github.com/Raindrops-dev/opencode-idle-compact plugins/opencode-idle-compact
   ```

2. Add a `plugins` entry to that config file. A relative path resolves from the config file that holds the entry:

   ```jsonc
   {
     "plugins": [
       { "package": "./plugins/opencode-idle-compact", "options": {} }
     ]
   }
   ```

An entry in the global config (`~/.config/opencode/opencode.jsonc`) loads the plugin in every project. An entry in a
project's config loads it only in that project. All options are optional.

## Defaults and the recommended setup

With the defaults (`maxIdleMinutes: 50`, `warmAfterMinutes: 55`), the plugin compacts but never sends a warm of its own.
The first warm would come at minute 55, after the idle limit of 50 minutes. For a session that the plugin warms, the
compaction is planned for 50 minutes after its last real request.

The default is 50 because of how OpenCode unloads plugins. OpenCode unloads a folder's services, plugins included, 60
minutes after the last durable session event in that folder. The setting `experimental.location_idle_timeout` changes
this time. Its default is `"60 minutes"`. When the plugin is unloaded, it loses its pending warms and the in-memory
timer of the final compaction. A limit of 50 minutes lets the compaction run before that happens.

For three warms, raise both the idle limit and the unload time:

```jsonc
{
  "plugins": [
    { "package": "./plugins/opencode-idle-compact", "options": { "maxIdleMinutes": 170 } }
  ],
  "experimental": { "location_idle_timeout": "24 hours" }
}
```

`location_idle_timeout` is an experimental setting. The OpenCode docs say: "Experimental settings may change, break, or
be removed in any release without notice." With `"24 hours"`, OpenCode keeps that folder's services loaded for up to
24 hours without session activity.

With this setup, the plugin plans warms 55, 110 and 165 minutes after the last real request, and a compaction at
minute 170. A fourth warm would come at minute 220, past the limit, so the plugin plans the compaction at 170 instead.
These times are a plan, not a promise. New activity, a failed warm, a context below the thresholds or an unload can
change or cancel them.

OpenCode's own warming feature (the `warming` setting) is off by default. If you turn it on, each of its warm requests
with an ok response also counts as a cache touch. The plugin's warms then come later, and fewer of them fit before
minute 170.

`maxIdleMinutes` must be below 1440. For any value of 60 or more, `experimental.location_idle_timeout` should be set
above it. Otherwise OpenCode unloads the plugin first and warming stops early.

## Options

Set options in the `options` object of the plugin entry. The plugin gives no warning for a wrong value. It reads them
like this:

- `keepWarm`, `compactOnIdle`, `rootCompact`, `childCompact` and `compactUnpriced` are on unless the value is exactly
  `false`.
- `subagents` and `debug` are on only when the value is exactly `true`.
- `coreCompactionWarm` counts only when it is `true` or `false`.
- A number of the wrong type or out of range gets the default.
- `ttl` is `"5m"` only when the value is exactly `"5m"`. Any other value means `"1h"`.
- `nativeWarmPrompt` and `logFile` get the default when the value is not a non-empty string.
- An array option that is not an array means `[]`. Entries that are not non-empty strings are dropped.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ttl` | `"1h"` or `"5m"` | `"1h"` | TTL written to every breakpoint. Any other value means `"1h"`. |
| `subagents` | boolean | `false` | Also give child sessions the TTL. Child sessions are never warmed. |
| `keepWarm` | boolean | `true` | Send warms. |
| `warmAfterMinutes` | number | `55` with `"1h"`, `4` with `"5m"` | Delay after the last cache touch before a warm. Must be above 0 and below the TTL in minutes. |
| `maxIdleMinutes` | number | `50` | Stop warming this long after the last real request. Must be above 0 and below 1440. |
| `nativeWarmPrompt` | string | OpenCode's keep-alive prompt | The prompt of OpenCode's own warm requests. Change it only if you changed `warming.prompt` in OpenCode. |
| `compactOnIdle` | boolean | `true` | Compact `warm` and `root` scope sessions when idle. |
| `rootCompact` | boolean | `true` | Compact root sessions that the plugin does not warm. |
| `idleCompactMinutes` | number | `30` | `root` scope: minutes after the last activity. Must be above 0 and below 60. |
| `childCompact` | boolean | `true` | Compact child sessions when quiet. |
| `childIdleSeconds` | number | `90` | `child` scope: quiet seconds after the last activity. Must be above 0 and below 86400. |
| `childResumeRate` | number | `0.3` | Share of child sessions that are resumed, from 0 to 1. Weights the saving in the `child` scope. |
| `compactMinTokens` | number | `100000` | Compact only contexts at least this large. Must be above 0. |
| `compactSaveMin` | number | `0.02` | Minimum expected saving in US dollars. Must be 0 or more. |
| `compactUnpriced` | boolean | `true` | Compact models with no prices on size alone. `false` never compacts them. |
| `flatRate` | string array | `[]` | `provider/model` patterns billed per request or by subscription. Never compacted; the TTL rewrite and warms still apply. `*` matches any characters. |
| `excludeSessions` | string array | `[]` | Session IDs that the plugin never compacts, in any scope. |
| `topLevelCache` | string array | `[]` | `provider/model` patterns where a request with no breakpoint gets one top-level cache marker. These routes are never warmed. |
| `coreCompactionWarm` | boolean | not set | `true` prices the summary read warm, `false` cold. Not set: warm, except for models with native provider compaction. |
| `debug` | boolean | `false` | Also log token counts per request and the reasons for skipped compactions. |
| `logFile` | string | `~/.local/state/opencode/anthropic-cache.jsonl` | Path of the log file. |

The default `nativeWarmPrompt` is:

```text
This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK
```

## Costs and safety

- **Billed requests that no person starts.** Every warm and every compaction is a real, billed provider request. Warms
  also count against your rate limits. A warm that reads the cache costs one cache read of the context plus one output
  token. A compaction costs one read of the context plus the summary.
- **Missed warms cost a full write.** The plugin does not detect a cache miss. A warm that misses is billed as a full
  cold write of the context, and warming continues. A miss does not stop warming; a failed warm or an HTTP error reply
  (for example 429 rate limit or 503) does.
- **At most 12 warms per idle stretch**, whatever the timing options say.
- **No retries.** The plugin stops warming a session after a failed warm or an error reply, and it tells OpenCode not
  to retry a warm.
- **Flat-rate routes.** List every route billed per request or by subscription in `flatRate`. The catalog prices do
  not show that you pay per request, and a model with no prices compacts on size alone by default. `flatRate` stops
  compaction only: the TTL rewrite and warms still happen on those routes. If warms cost you per request, set
  `keepWarm: false`.
- **Sessions you want to keep whole.** Compaction loses detail. List those session IDs in `excludeSessions`, or turn
  off a scope with `compactOnIdle`, `rootCompact` or `childCompact`.

## Privacy

- **Memory.** To send warms, the plugin keeps the last request body of up to 16 sessions in memory. It also keeps the
  whole last request body except the conversation (for example the system prompt, the tools and every other field) of
  up to 32 sessions. It copies the system prompt, the tools and the thinking settings from it into OpenCode's own warm
  requests, under the conditions in [OpenCode's own cache settings](#opencodes-own-cache-settings).
- **Storage.** For each pending idle compaction, the plugin stores the folder, the workspace ID, the scope flags,
  the model, the token count, where that count came from and the deadline in `ctx.storage`. It stores no prompt or
  reply text there.
- **Session reads.** When an idle timer reaches its size check and the session has settled, the plugin reads the
  session's active context with `ctx.session.context`, where OpenCode offers it, to size it from the recorded token
  usage. It keeps only the resulting number.
- **Network.** The plugin makes no network call of its own. Its requests go only through OpenCode's session API.
- **Log.** The plugin writes JSON lines to `~/.local/state/opencode/anthropic-cache.jsonl` by default. When the plugin
  creates the file, it creates it with mode 600. Each line has a time (`t`), the ID of the OpenCode process that wrote
  it (`pid`) and an event name (`event`). The other fields are metadata:
  - session ID, scope, reason, estimated token count, basis, provider and model names, request kind and HTTP status;
  - the ID of the compaction request when known (`inboxID`, on `compact.idle` and `compact.duplicate`);
  - folder path (at setup);
  - counts (re-armed and dropped compactions);
  - error messages as received, cut to 200 characters and not redacted;
  - with `debug` only: option values, breakpoint counts and the provider's token-usage object.

  The plugin never logs prompt or reply text itself. An error message from OpenCode or the provider can contain any
  text.

## Limits

- **Warm timers live in memory.** They are lost when OpenCode unloads the plugin (a restart, or the folder's idle
  timeout).
- **Idle-compaction deadlines persist** in `ctx.storage`. When OpenCode loads the plugin again for the same folder, it
  re-arms them (log event `compact.rearmed`). It removes deadlines that are more than 60 minutes past due without
  compacting.
- **`compact.idle` in the log** means that OpenCode accepted the compaction request. It does not mean that the
  compaction finished.
- **One OpenCode server per host.** Two servers that share one database also share the stored deadlines. When
  OpenCode reports when the session went idle, the idle compaction carries an ID derived from the session and that
  time, so OpenCode accepts it once. While the first request is still pending, the second server gets the same request
  back and logs `compact.idle` with the same `inboxID`; once it has run, the second server logs `compact.duplicate`.
  Without that idle time there is no shared ID. Some timing cases with two servers can still compact a session twice.
- **Routes without readable usage.** When the plugin never sees the provider's usage in an HTTP response, it sizes
  the session from the usage OpenCode recorded with the newest usable answer (no error, a positive prompt count) of the
  same provider, plus about 4 characters per token for what that usage did not cover. After a compaction with no such
  answer since, or when the context cannot be read, it estimates about 4 characters per token. A failed read logs
  `compact.context-failed` with the error's tag or name, `error` when it has neither, or `not an array` for an answer
  that is not a list; never the error's message.
- **OpenCode chooses the summary model.** The plugin never calls a model itself for the summary.

## Tests

From the cloned plugin folder, run:

```sh
npm test
```

The tests run offline against a fake plugin context and fake catalog. They do not test against a real OpenCode.

## Credits

The idle-compaction idea was inspired by oh-my-pi (OMP), <https://github.com/can1357/oh-my-pi> (MIT). No OMP code is
included.

The default `nativeWarmPrompt` is OpenCode's own keep-alive prompt text (OpenCode, MIT,
<https://github.com/anomalyco/opencode>), copied so the plugin can recognise OpenCode's native warms.

## Licence

MIT, see [LICENSE](LICENSE).
