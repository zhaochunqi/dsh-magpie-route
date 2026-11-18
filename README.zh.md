# dsh-magpie-route

[![npm 月下载量](https://badgen.net/npm/dm/dsh-magpie-route)](https://www.npmjs.com/package/dsh-magpie-route) [![npm 版本](https://badgen.net/npm/v/dsh-magpie-route)](https://www.npmjs.com/package/dsh-magpie-route) [![GitHub Release](https://badgen.net/github/release/zhaochunqi/dsh-magpie-route)](https://github.com/zhaochunqi/dsh-magpie-route/releases) [![Node.js](https://img.shields.io/node/v/dsh-magpie-route)](https://www.npmjs.com/package/dsh-magpie-route) [![许可证](https://badgen.net/github/license/zhaochunqi/dsh-magpie-route)](https://github.com/zhaochunqi/dsh-magpie-route/blob/main/LICENSE)

![magpie 真实路由显示在输入框下方](https://raw.githubusercontent.com/zhaochunqi/dsh-magpie-route/main/docs/preview.png)

DeepSeek Harness（`dsh`）插件：把 [magpie](https://usemagpie.ai) 路由组别名背后的**真实上游模型**直接显示在输入框下方。

DSH 的模型选择器只知道你配置的路由组别名（例如 `magpie/group/daily`）；请求实际发往哪个上游 provider/model 由本地 magpie 网关决定，而且可能逐轮变化。本插件读取网关自己的路由记录，把真实结果显示出来。

```
● magpie 真实路由 · 13:32 magpie/group/daily → workbuddy/glm-5.3
```

## 功能

- **输入框下方常驻一行**：每 15 秒刷新，点击立即刷新；显示时间、请求别名、真实 `provider/model` 和命中的路由规则。
- **按 DSH 会话**：Host 半给每次 magpie 推理加上 `X-Magpie-Session`，网关就能返回本会话当前/最近的路由；进行中的请求会显示已选定的目标，并标注“进行中”。
- **跟随 DSH 界面语言**：中文界面显示“magpie 真实路由”，英文界面显示“magpie real route”，切换语言时会实时更新。
- 绿点 = 有路由结果；红点 = 网关不可用（点击重试）；灰点 = 暂无路由；悬停显示数据源。
- 只读：不发模型请求、不改路由，只增加一个传输头。
- **不提供命令，也不提供 agent 工具**，插件只负责界面显示。

## 要求

- 带 composer dock slot 的 DeepSeek Harness（0.2.x）。
- 正在运行的 [magpie](https://usemagpie.ai) 网关。插件会跟随 DSH 里 `magpie` provider 已经使用的地址，所以 DSH profile 配的是哪个主机/端口就跟哪个（默认 `http://127.0.0.1:3425`）。

## 安装

把 `dsh-magpie-route` 安装到你的 DSH profile（Plugin Manager → Add plugin，或用 `install_bundle` 传 npm 包），然后重新加载/重启以加载 client bundle。

本地目录安装：用 `plugin_manager` 的 `install_bundle` 指向该目录，然后刷新页面。

## 配置

默认无需配置。Host 半从 DSH 自身取网关地址：每次 magpie 推理都会通过 `llm-pi-ai/request-headers` 报告解析后的 endpoint；首次绘制之前则读 `llm-pi-ai` 的 `providers.magpie.baseURL`（再退 `magpie-anthropic`，最后兜底 `http://127.0.0.1:3425`）。插件行 `config` 里显式设置的 `baseURL` 优先级最高，只有要指向 DSH 不知道的地址时才需要写。

## 工作原理

- Host 半从 DSH 为每次 magpie 推理报告的 `baseURL`（`llm-pi-ai/request-headers` waterfall）推导出网关根地址，不解析任何配置文件；同时加上 `X-Magpie-Session: <dsh session id>`（只加请求头，不改请求体、模型或工具集），然后读取 `GET {baseURL}/v1/magpie/route?session=<dsh session id>` 得到本会话当前/最近的路由。
- 首次推理之前，它从运行中的 Loader 配置读取 `llm-pi-ai` 的 `providers.magpie.baseURL`（兜底 `http://127.0.0.1:3425`），所以首帧就用对端口。
- `GET {baseURL}/v1/magpie/trace` 只作为首次绘制的兜底（Host 进程里还没有发生过推理时）。
- Client 半轮询本包 Host 的同源路由 `/plugins/magpie-route/route`，渲染输入框下方那一行，因为 magpie 网关没有 CORS 头。路由入口先检查 DSH 的 `connection.requestRejection`（Host/Origin 信任与浏览器认证），并额外拒绝 `Origin` 不匹配的请求。

## 限制

- 显示的是**本会话当前/最近**的路由。进行中的请求显示已选定目标并标注“进行中”；最终 served model 仍要等 magpie 完成才能确认。首次绘制（还没发生推理）会退回全局最近一条已完成的 `dsh` trace。
- Host 半记住最近一次发起 magpie 请求的 DSH 会话。如果你切到一个还没发过请求的新会话，dock 可能仍显示上一个会话的路由，直到新会话真正发起请求。
- `trace` 只保留最近窗口（约 60 条），不是完整历史；完整历史用 `magpie usage --csv`。
- `trace` 显示 `provider/model`；最终 `served_model`（如 `hy4-free`）只在 `magpie usage --csv` 里出现。
- 路由组有会话亲和与规则路由，“当前真实模型”可能逐轮变化。
- 网关地址跟 DSH 给 `magpie` provider 配的值一致。如果 DSH 里那个值本身过期了（比如 magpie 换了端口但没重新接入），dock 会显示同一个过期地址；此时用 `config.baseURL` 覆盖即可。

## 卸载

在 Plugin Manager 里移除 `dsh-magpie-route`，或用 `remove_bundle`。

## 许可证

MIT。非官方集成；magpie 是独立产品，本项目与其无隶属关系。
