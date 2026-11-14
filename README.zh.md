# dsh-magpie-route

DeepSeek Harness（`dsh`）插件：把 [magpie](https://usemagpie.ai) 路由组别名背后的**真实上游模型**直接显示在输入框下方。

DSH 的模型选择器只知道你配置的路由组别名（例如 `magpie/group/daily`）；请求实际发往哪个上游 provider/model 由本地 magpie 网关决定，而且可能逐轮变化。本插件读取网关自己的 trace，把真实结果显示出来。

```
● magpie 真实路由 · 13:32 magpie/group/daily → workbuddy/glm-5.3
```

## 功能

- **输入框下方常驻一行**：每 15 秒刷新，点击立即刷新；显示时间、请求别名、真实 `provider/model` 和命中的路由规则。
- 绿点 = 有已完成结果；红点 = 网关不可用（点击重试）；灰点 = 暂无已完成请求；悬停显示数据源。
- 只读：不发模型请求、不改路由、不注入请求头。
- **不提供命令，也不提供 agent 工具**，插件只负责界面显示。

## 要求

- 带 composer dock slot 的 DeepSeek Harness（0.2.x）。
- 正在运行的 [magpie](https://usemagpie.ai) 网关。默认 `http://127.0.0.1:3425`，可在 bundle 配置里改。

## 安装

把 `dsh-magpie-route` 安装到你的 DSH profile（Plugin Manager → Add plugin，或用 `install_bundle` 传 npm 包），然后重新加载/重启以加载 client bundle。

本地目录安装：用 `plugin_manager` 的 `install_bundle` 指向该目录，然后刷新页面。

## 配置

在 profile 的 `cordis.patch.yml` 里改该插件行的 config（Host-only bundle 没有 UI 配置表单）：

```yaml
- id: magpie-route
  config:
    baseURL: http://127.0.0.1:3425
    agent: dsh
    limit: 5
```

`agent` 是 magpie trace 里的 agent 名（默认 `dsh`）；`limit` 是路由返回的最近已完成条数（界面显示第一条）。

## 工作原理

- Host 半读取 `GET {baseURL}/v1/magpie/trace`（每条已完成请求的真实 `provider/model` 与规则），并挂在同源路由 `/plugins/magpie-route/route` 上。
- Client 半轮询这个同源路由，渲染输入框下方那一行，因为 magpie 网关没有 CORS 头。

## 限制

- 显示的是**最近一次已完成**的请求，不是正在进行中的请求：进行中的请求还没有 `usage`，最终落点还未知。界面显示“另有 N 条进行中”时，那 N 条就是进行中、只计数、不当作结论。
- 界面行显示的是**所有 DSH 会话中最近完成的一条** `dsh` 请求，因为 DSH 不发送 `X-Magpie-Session`，网关无法把路由关联到 DSH 会话。
- `trace` 只保留最近窗口（约 60 条），不是完整历史；完整历史用 `magpie usage --csv`。
- `trace` 显示 `provider/model`；最终 `served_model`（如 `hy4-free`）只在 `magpie usage --csv` 里出现。
- 路由组有会话亲和与规则路由，“当前真实模型”可能逐轮变化。

## 卸载

在 Plugin Manager 里移除 `dsh-magpie-route`，或用 `remove_bundle`。

## 许可证

MIT。非官方集成；magpie 是独立产品，本项目与其无隶属关系。
