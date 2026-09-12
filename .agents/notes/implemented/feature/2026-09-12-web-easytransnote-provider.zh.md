# Agent Note: easytransnote-backed web search and fetch provider

Status: implemented

[English](2026-09-12-web-easytransnote-provider.md) | 中文

## Problem

harness 的 `web_search` 与 `web_fetch` 工具是 `ctx.web` 接缝之上的模型可见工具，但内建 provider 集并不通用。搜索需要 Exa、Perplexity 或 DeepSeek 原生搜索；抓取需要直接匿名 HTTP(S)。自建 DeepSeek 部署常暴露 Anthropic 兼容的 Messages API 但没有原生 `web_search_20250305` 服务端工具，因此内建的 `dsh-web-search-deepseek` provider 拿不到 `web_search_tool_result` 块并响亮失败。这样的部署也可能无法直连某些站点，需要一个托管抓取 API。此前没有调用一个托管 API 同时承担搜索与抓取的内建 provider。

## Decision

新增 `@deepseek-ai/dsh-web-easytransnote`，一个在 `ctx.web` 注册两个 provider 的插件，两者均以 `easytransnote` id 注册到各自能力注册表：
- `EasyTransnoteSearchProvider` 向 `/beta/v1/web/search` POST `{ model, topic: query }`，把 `urls[]` 映射到 `sources[]`、`text` 映射到 `content`。
- `EasyTransnoteFetchProvider` 向 `/beta/v1/web/fetch` POST `{ model, url }`，把 `markdown`（优先）映射为 `text` body，缺省回退到把 `html` 映射为 `html` body。

两者按操作经 `ctx.credentials`（回退到启动环境）解析 API 密钥，且因携带 `Authorization: Bearer` 头，每个请求都以 `redirect: 'error'` 发送——重定向不得把凭据或 body 转发到另一来源。插件安装一个 Settings 段（`web-easytransnote`），使端点、模型与密钥引用可被用户配置，且 provider 按操作投影该段，因此已提交的变更无需重新注册。

该包与 `dsh-web` 和 `dsh-tool-web` 一起挂载，并用 `easytransnote` 的搜索/抓取 id 固定，这正是没有原生 web 搜索的自建 DeepSeek 从一个托管 API 获得 `web_search` 与 `web_fetch` 的方式。

## Verification

- Provider 单元测试（16 个）断言：`mapSearchResponse` 映射 urls/text、去重并丢弃空项；`mapFetchResponse` 优先 markdown、回退 html、两者皆缺时响亮失败；`available()` 反映密钥或解析器；`search` 与 `fetch` 向正确端点/body POST 并带认证头与 `redirect: 'error'`、映射响应、把取消呈现为 `WEB_ABORTED`、非 2xx 为 `WEB_PROVIDER_ERROR`、缺失凭据为 `WEB_PROVIDER_CREDENTIAL_MISSING`。
- 该包在 `tsc -b` 下编译，并注册进 `tsconfig.host.json`；生成的配置目录携带其 `Config`。
- web 组单元套件（251 个）在新增包旁一并通过。

## Alternatives considered

**即使没有原生搜索也复用 DeepSeek Messages 搜索。** 被拒绝：该 provider 需要 `web_search_tool_result` 块，缺失时抛 `WEB_PROVIDER_ERROR`，因此没有原生工具的自建端点无法使用它。

**通过 `baseURL` 把自建 DeepSeek 指到 easytransnote 搜索。** 被拒绝：`baseURL` 只重命名同一 provider 的端点；无法改变该 provider 所说的 API 或响应形状。

**把 easytransnote 搜索路由到一个新的 `dsh-web` 能力而非 provider。** 被拒绝：接缝已拥有搜索/抓取选择与错误；新能力会重复选择与 `web_search`/`web_fetch` 工具。

**只加一个抓取 provider。** 被拒绝：没有原生搜索的自建 DeepSeek 仍需要搜索；一个包同时覆盖两者使挂载与配置集中在一处。

## Consequences

- 无原生搜索工具的自建 DeepSeek 部署，可通过一个 easytransnote API 密钥与端点同时启用 `web_search` 与 `web_fetch`。
- 搜索结果只携带裸 URL（无每来源标题或摘要），因为 easytransnote 返回它们时无这些字段；接缝省略它们而非虚构内容。
- 抓取 body 是 API 的 markdown 或 HTML；`WebFetchBody` 种类跟随 API 返回，因此工具的 HTML→markdown 转换仅在 `html` 回退路径上应用。
- 每个 easytransnote 请求都带凭据并在任何重定向响应上失败，符合 web 能力对带凭据请求的策略。
