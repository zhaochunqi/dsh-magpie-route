# dsh-magpie-route

![magpie real route in the DSH composer dock](https://raw.githubusercontent.com/zhaochunqi/dsh-magpie-route/main/docs/preview.png)

A DeepSeek Harness (`dsh`) plugin that shows the **real upstream model** behind a [magpie](https://usemagpie.ai) routing-group alias, directly below the composer.

DSH's model picker only knows the routing-group alias you configured (for example `magpie/group/daily`). The local magpie gateway decides which upstream provider/model actually serves each request, and that can change from turn to turn. This plugin reads the gateway's own route record and shows the real result.

```
● magpie real route · 13:32 magpie/group/daily → workbuddy/glm-5.3
```

## Features

- **Composer dock line** — sits below the composer, refreshes every 15 seconds, and refreshes immediately on click. Shows the time, the asked alias, the real `provider/model`, and the matched routing rule.
- **Per DSH session** — the Host half tags each magpie inference with `X-Magpie-Session`, so the gateway can report this session's current/last route; an in-flight request shows its already-picked target with a "进行中 / in flight" marker.
- **Follows the DSH UI language** — the line reads `magpie real route` in English and `magpie 真实路由` in Chinese (and switches live when the UI language changes).
- Green dot = a route; red dot = the gateway is unreachable (click to retry); grey dot = no route yet.
- Read-only: it sends no model request, changes no routing, and only adds one transport header.
- **No command and no agent tool** — this plugin only displays the route.

## Requirements

- DeepSeek Harness with the composer dock slot (0.2.x).
- A running [magpie](https://usemagpie.ai) gateway on the default `http://127.0.0.1:3425`.

## Install

Install the `dsh-magpie-route` package into your DSH profile (Plugin Manager → Add plugin, or `install_bundle` with the npm spec), then reload/restart so the client bundle is picked up.

For a local checkout instead, install the bundle directory with `plugin_manager` `install_bundle` and refresh the page.

## Configuration

No configuration is required: the plugin talks to the default local gateway at `http://127.0.0.1:3425` and filters the `dsh` agent. Only if your gateway runs elsewhere, override `baseURL` (and optionally `agent`/`limit`) in your profile's `cordis.patch.yml`.

## How it works

- The Host half contributes `X-Magpie-Session: <dsh session id>` through DSH's `llm-pi-ai/request-headers` waterfall (a header only; no request-body, model, or tool change), then reads `GET {baseURL}/v1/magpie/route?session=<dsh session id>` for this session's current/last route.
- `GET {baseURL}/v1/magpie/trace` is the fallback for the first paint, before any inference has happened in this Host process.
- The client half renders the composer-dock line by polling the package's same-origin route `/plugins/magpie-route/route`, because the magpie gateway sends no CORS headers.

## Limitations

- Shows **this session's current/last route**. An in-flight request shows its already-picked target with a "进行中 / in flight" marker; the final served model is still only confirmed after magpie finishes. On the first paint (before any inference), it falls back to the global latest settled `dsh` trace row.
- The Host half remembers the most recent DSH session that sent a magpie request. If you open another session that has not requested anything yet, the dock may still show the previous session's route until that new session runs.
- `trace` keeps a recent window (about 60 rows), not full history. For full history use `magpie usage --csv`.
- `trace` reports `provider/model`; the final `served_model` (for example `hy4-free`) appears in `magpie usage --csv`.
- Routing groups use session affinity and rules, so the "current real model" can change per turn.

## Uninstall

Remove the `dsh-magpie-route` bundle from Plugin Manager, or `remove_bundle` it from the profile.

## License

MIT. This is an unofficial integration; magpie is a separate product, and this project is not affiliated with it.
