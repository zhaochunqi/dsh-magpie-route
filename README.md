# dsh-magpie-route

A DeepSeek Harness (`dsh`) plugin that shows the **real upstream model** behind a [magpie](https://usemagpie.ai) routing-group alias, directly below the composer.

DSH's model picker only knows the routing-group alias you configured (for example `magpie/group/daily`). The local magpie gateway decides which upstream provider/model actually serves each request, and that can change from turn to turn. This plugin reads the gateway's own trace and shows the real result.

```
● magpie real route · 13:32 magpie/group/daily → workbuddy/glm-5.3
```

## Features

- **Composer dock line** — sits below the composer, refreshes every 15 seconds, and refreshes immediately on click. Shows the time, the asked alias, the real `provider/model`, and the matched routing rule.
- **`/magpie-route` slash command** — `/magpie-route` shows the last 5 settled requests; `/magpie-route 10` shows up to 20; `/magpie-route <magpie-session-id>` queries one session route.
- **`magpie_route` agent tool** — the same data, callable by the agent (`session`, `limit` optional).

Read-only: it sends no model request, changes no routing, and injects no headers. If the gateway is down the dock and the command say so.

## Requirements

- DeepSeek Harness with the composer dock slot (0.2.x).
- A running [magpie](https://usemagpie.ai) gateway. Default base URL `http://127.0.0.1:3425`, overridable in the bundle config.

## Install

Install the `dsh-magpie-route` package into your DSH profile (Plugin Manager → Add plugin, or `install_bundle` with the npm spec), then reload/restart so the client bundle is picked up.

For a local checkout instead, install the bundle directory with `plugin_manager` `install_bundle` and refresh the page.

## Configuration

Edit the plugin row's config in your profile's `cordis.patch.yml` (a Host-only bundle has no UI config form):

```yaml
- id: magpie-route
  config:
    baseURL: http://127.0.0.1:3425
    agent: dsh
    limit: 5
```

`agent` is the magpie trace agent name to filter on (default `dsh`); `limit` is the default number of rows.

## How it works

- The Host half reads `GET {baseURL}/v1/magpie/trace` (real `provider/model` and rule per settled request) and `GET {baseURL}/v1/magpie/route?session=...` (one session route).
- The client half polls the package's same-origin route `/plugins/magpie-route/route`, because the magpie gateway sends no CORS headers.

## Limitations

- Shows the **most recent settled** request, not the request currently in flight: a request still running has no `usage`, so its final route is not known yet. When the dock says "另有 N 条进行中", those are in-flight requests that are counted but not reported.
- The dock line is the latest settled `dsh` request **across all DSH sessions**, because DSH does not send `X-Magpie-Session` and the gateway cannot tie a route to a DSH session.
- `trace` keeps a recent window (about 60 rows), not full history. For full history use `magpie usage --csv`.
- `trace` reports `provider/model`; the final `served_model` (for example `hy4-free`) appears in `magpie usage --csv`.
- Routing groups use session affinity and rules, so the "current real model" can change per turn.

## Uninstall

Remove the `dsh-magpie-route` bundle from Plugin Manager, or `remove_bundle` it from the profile.

## License

MIT. This is an unofficial integration; magpie is a separate product, and this project is not affiliated with it.
