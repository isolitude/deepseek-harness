---
description: "easytransnote 支撑的 ctx.web 搜索与抓取 provider：部署方通过一个托管 API 同时搜索网页并把 URL 抓取为文本或 markdown。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-easytransnote

[English](README.md) | 中文

## 概述

用 `dsh-web-easytransnote`，harness 通过一个托管的 easytransnote API 同时搜索网页并抓取 URL，而非分开的多个厂商后端，适合没有原生 `web_search` 工具的自建 DeepSeek。它在 `ctx.web` 下以 `easytransnote` id 同时注册搜索与抓取两个 provider。API 密钥按操作经凭据服务解析，且每个请求携带 `Authorization: Bearer` 头并在重定向时失败而非转发凭据。当你持有 easytransnote API 密钥、并希望从一个端点同时获得搜索与抓取时选用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本 provider。它以 `easytransnote` 同时作为搜索与抓取的 provider id 注册，因此当它是每个能力中唯一可用后端时 `ctx.web.search()` 与 `ctx.web.fetch()` 自动解析到它——或用 `searchProvider: easytransnote` 与 `fetchProvider: easytransnote` 固定。

### 何时选用

当一个部署持有 easytransnote API 密钥、并想从一个托管 API 同时获得搜索与抓取时选用本后端——例如暴露了没有原生服务端 web 搜索的自建 DeepSeek。搜索端点返回生成式答案加纯 URL；抓取端点返回 markdown（与 HTML）。当密钥为空或端点基址无法解析时 provider 不可用——每次调用都以结构化错误失败。

### 最小配置

加载 web 服务与 provider；API 密钥回退到 `$EASYTRANSNOTE_API_KEY` 与 `$EASYTRANSNOTE_BASE_URL`，其余设置都有默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-easytransnote'
  config:
    apiKeyEnv: EASYTRANSNOTE_API_KEY
```

| 键 | 默认 | 含义 |
|---|---|---|
| `apiKey` | （未设） | 字面 easytransnote API 密钥；优先用 `apiKeyEnv` 使机密不进配置文件。非空字面值优先于解析器 |
| `apiKeyEnv` | `EASYTRANSNOTE_API_KEY` | 每次操作经 `ctx.credentials` 解析的凭据引用，或凭据服务缺失时的启动环境。缺失值以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败 |
| `baseURL` | `https://api.easytransnote.com` | 端点基址；`/beta/v1/web/search` 与 `/beta/v1/web/fetch` 被追加。回退到 `$EASYTRANSNOTE_BASE_URL` |
| `searchModel` | `web-search-base` | 发送给搜索端点的 `model` 搜索模型名 |
| `fetchModel` | `web-fetch-lite` | 发送给抓取端点的 `model` 抓取模型名 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-easytransnote) 是每个接受字段及其 JSDoc 的穷举来源。

### 一次搜索返回什么

`content` 在存在时携带 easytransnote 答案文本；`sources[]` 携带返回的纯 URL，按结果顺序去重。因为 easytransnote 返回裸 URL、无每个来源的标题或摘要，`WebSearchSource` 项只携带 `url`——省略可选字段的生产者让接缝保持诚实而非虚构它们。接缝的 `maxResults` 上限在返回路径上生效。

### 一次抓取返回什么

抓取端点返回 `markdown` 与 `html`。provider 优先 `markdown` 并映射为 `text` 类型 `WebFetchBody`；`markdown` 缺失时把 `html` 映射为 `html` body。两者皆缺则以 `WEB_PROVIDER_ERROR` 响亮失败。结果 `statusCode` 为 `200`，因为 easytransnote 成功抓取意味着 API 已处理该请求；API 以非 2xx 响应报告失败。

### 失败与恢复

Provider 失败——HTTP 错误、网络失败、无法解析或形状错误的 body——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；缺失凭据为 `WEB_PROVIDER_CREDENTIAL_MISSING`；调用方取消为 `WEB_ABORTED`。每个请求都以 `redirect: 'error'` 发送，因此重定向响应不会被跟随，也不会把 `Authorization` 头转发到另一来源。调用方按 code 路由；模型可见的 `web_search` 与 `web_fetch` 工具在各自错误包装下呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节解释 provider 背后的设计决策；可观察行为在[使用本包](#use-this-package)中完整覆盖。

### 设计思路

- **一个 API，两个 provider。** 两个 provider 都访问同一托管 API 但分别注册：搜索进搜索注册表、抓取进抓取注册表，各用 `easytransnote` id。它们共享同一端点基址与凭据，但每个能力各自自动选择，因此只挂载搜索时把抓取留给另一个 provider，反之亦然。
- **带凭据的请求绝不跟随重定向。** 每个请求携带 `Authorization: Bearer <key>` 并以 `redirect: 'error'` 发送，因此重定向无法把凭据或请求体转发到另一来源。这是本包对 web 能力带凭据请求策略的自选加入。
- **按操作解析凭据。** API 密钥每次操作经 `ctx.credentials` 解析（回退到启动环境），因此轮换的密钥无需重启即到达下次调用。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、Settings 段、按操作选项投影、provider 注册 |
| [`src/provider.ts`](src/provider.ts) | `EasyTransnoteSearchProvider` 与 `EasyTransnoteFetchProvider`、共享 POST helper、响应映射 |
| [`src/types.ts`](src/types.ts) | 搜索与抓取响应的 easytransnote 线格式类型 |

### 请求流程

每次操作把当前 Settings 段投影为 provider 选项，经 `ctx.credentials`（或环境）解析凭据引用，再以 `redirect: 'error'` 向搜索或抓取端点 POST JSON。响应被解析并映射为接缝的规范化结果：搜索把 `urls[]` 映射到 `sources[]`、`text` 映射到 `content`；抓取把 `markdown`（或 `html`）映射到封闭的 `WebFetchBody`。非 2xx、无法解析或形状不完整的响应成为 `WebError`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不足时阅读以下页面。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 穷尽的搜索/抓取请求与结果词汇及错误码。
- [dsh-web](../web/README.zh.md) — 本 provider 注册进的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 模型可见的 `web_search` 与 `web_fetch` 工具。
- [dsh-web-search-deepseek](../web-search-deepseek/README.zh.md) — 已内建 DeepSeek 原生搜索后端，用于你的端点支持时。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 `dsh-tool-web`：搜索把返回的答案与来源 URL 渲染为可引用 markdown 链接；抓取把抓到的 markdown 或已转换 HTML 渲染为文本。本包不贡献自己的提示或 schema。

#### KV 缓存影响

无直接失效；`dsh-tool-web` 拥有请求前缀变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **无每来源标题或摘要** — 搜索端点返回裸 URL，因此 `WebSearchSource` 项只携带 `url`；形状字段保持缺失而非虚构。
- **必须配置凭据** — 无 easytransnote API 密钥时 provider 不可用，缺失密钥使每次操作以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。
- **每个能力一个 provider id** — 搜索与抓取各自在其注册表以 `easytransnote` 注册，因此不能在搜索用 easytransnote 的同时在同一 id 用另一厂商；接缝的 provider 选择仍逐能力自动选择或固定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
