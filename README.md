# dsh-magpie-route

[![npm downloads](https://badgen.net/npm/dm/dsh-magpie-route)](https://www.npmjs.com/package/dsh-magpie-route) [![npm version](https://badgen.net/npm/v/dsh-magpie-route)](https://www.npmjs.com/package/dsh-magpie-route) [![GitHub release](https://badgen.net/github/release/zhaochunqi/dsh-magpie-route)](https://github.com/zhaochunqi/dsh-magpie-route/releases) [![Node.js](https://img.shields.io/node/v/dsh-magpie-route)](https://www.npmjs.com/package/dsh-magpie-route) [![license](https://badgen.net/github/license/zhaochunqi/dsh-magpie-route)](https://github.com/zhaochunqi/dsh-magpie-route/blob/main/LICENSE)

![magpie real route in the DSH composer dock](https://raw.githubusercontent.com/zhaochunqi/dsh-magpie-route/main/docs/preview.png)

A DeepSeek Harness (`dsh`) plugin that shows the **real upstream model** behind a [magpie](https://usemagpie.ai) routing-group alias, directly below the composer.

DSH's model picker only knows the routing-group alias you configured (for example `magpie/group/daily`). The local magpie gateway decides which upstream provider/model actually serves each request, and that can change from turn to turn. This plugin reads the gateway's own route record and shows the real result.

```
● magpie real route · magpie/group/daily → workbuddy/glm-5.3
```

## Features

- **Composer dock line** — sits below the composer and refreshes immediately on click. It is event-driven, not on a fixed timer: an idle query is held by the Host until the next magpie request starts, and while a request is being routed the line polls once a second, so a new route appears within about a second. Shows the asked alias, the real `provider/model`, and the matched routing rule.
- **Per DSH session** — the Host half tags each magpie inference with `X-Magpie-Session`, so the gateway can report this session's current/last route; an in-flight request shows its already-picked target with a "进行中 / in flight" marker.
- **Follows the DSH UI language** — the line reads `magpie real route` in English and `magpie 真实路由` in Chinese (and switches live when the UI language changes).
- Green dot = a route; red dot = the gateway is unreachable (click to retry); grey dot = no route yet.
- Read-only: it sends no model request, changes no routing, and only adds one transport header.
- **No command and no agent tool** — this plugin only displays the route.

## Requirements

- DeepSeek Harness with the composer dock slot (0.2.x).
- A running [magpie](https://usemagpie.ai) gateway. The plugin follows the endpoint DSH already uses for the `magpie` provider, so it tracks whatever host/port your DSH profile configures (default `http://127.0.0.1:3425`).

## Install

Install the `dsh-magpie-route` package into your DSH profile (Plugin Manager → Add plugin, or `install_bundle` with the npm spec), then reload/restart so the client bundle is picked up.

For a local checkout instead, install the bundle directory with `plugin_manager` `install_bundle` and refresh the page.

## Configuration

No configuration is required. The Host half discovers the gateway from DSH itself: every magpie inference reports its resolved endpoint through `llm-pi-ai/request-headers`, and before the first inference it reads `llm-pi-ai`'s `providers.magpie.baseURL` (then `magpie-anthropic`, then `http://127.0.0.1:3425`). An explicit `baseURL` in the plugin row's `config` wins, so you only set it to point at an address DSH does not know about.

## How it works

- The Host half derives the gateway root from the `baseURL` that DSH reports for each magpie inference through the `llm-pi-ai/request-headers` waterfall (no config-file parsing), contributes `X-Magpie-Session: <dsh session id>` (a header only; no request-body, model, or tool change), then reads `GET {baseURL}/v1/magpie/route?session=<dsh session id>` for this session's current/last route.
- Before the first inference it reads `llm-pi-ai`'s configured `providers.magpie.baseURL` from the live Loader config (falling back to `http://127.0.0.1:3425`), so the first paint already uses the right port.
- The Dock binds its session through the registration's `inject(sessionId)` callback. It never falls back to global `/v1/magpie/trace` records.
- The client half polls `/plugins/magpie-route/route?session=<current session id>` because the gateway sends no CORS headers. The route checks DSH's `connection.requestRejection` and rejects a mismatched `Origin` header.

## Limitations

- Shows **this session's current/last route**. An in-flight request shows its already-picked target; the final served model is confirmed after magpie finishes.
- Sessions without a route show an empty state. Switching sessions never substitutes another session's route.
- `trace` keeps a recent window (about 60 rows), not full history. For full history use `magpie usage --csv`.
- `trace` reports `provider/model`; the final `served_model` (for example `hy4-free`) appears in `magpie usage --csv`.
- Routing groups use session affinity and rules, so the "current real model" can change per turn.
- The gateway address mirrors whatever DSH has configured for the `magpie` provider. If that DSH value is stale (for example after moving magpie without reconnecting it), the dock shows the same stale endpoint; set `config.baseURL` to correct it.

## Uninstall

Remove the `dsh-magpie-route` bundle from Plugin Manager, or `remove_bundle` it from the profile.

## License

MIT. This is an unofficial integration; magpie is a separate product, and this project is not affiliated with it.
