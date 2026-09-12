# Agent Note: easytransnote-backed web search and fetch provider

Status: implemented

English | [中文](2026-09-12-web-easytransnote-provider.zh.md)

## Problem

The harness's `web_search` and `web_fetch` tools are model-facing over the `ctx.web` seam, but the shipped provider set is not universal. Search requires Exa, Perplexity, or DeepSeek native search; fetch requires direct anonymous HTTP(S). A self-hosted DeepSeek deployment often exposes the Anthropic-compatible Messages API but no native `web_search_20250305` server tool, so the shipped `dsh-web-search-deepseek` provider returns no `web_search_tool_result` block and fails loud. Such a deployment also may not reach some sites directly, needing a hosted fetch API. There was no shipped provider that calls one hosted API for both search and fetch.

## Decision

Add `@deepseek-ai/dsh-web-easytransnote`, a plugin that registers two providers in `ctx.web`, both under the `easytransnote` id in their own capability registry:
- `EasyTransnoteSearchProvider` POSTs `{ model, topic: query }` to `/beta/v1/web/search` and maps `urls[]` to `sources[]` and `text` to `content`.
- `EasyTransnoteFetchProvider` POSTs `{ model, url }` to `/beta/v1/web/fetch` and maps `markdown` (preferred) to a `text` body, falling back to `html` to an `html` body.

Both resolve the API key per operation through `ctx.credentials` (falling back to the launching environment), and every request is sent with `redirect: 'error'` because it carries an `Authorization: Bearer` header — a redirect must not forward the credential or body to another origin. The plugin installs a Settings section (`web-easytransnote`) so endpoint, models, and the key reference are user-configurable, and the providers project that section per operation so a committed change needs no re-registration.

The package is mounted beside `dsh-web` and `dsh-tool-web` and pinned with the `easytransnote` search/fetch ids, which is how a self-hosted DeepSeek without native web search gains both `web_search` and `web_fetch` from one hosted API.

## Verification

- Provider unit tests (16) assert: `mapSearchResponse` maps urls/text, dedupes, and drops empty entries; `mapFetchResponse` prefers markdown, falls back to html, and fails loud with neither; `available()` reflects a key or resolver; `search` and `fetch` POST the right endpoint/body with an auth header and `redirect: 'error'`, map the response, surface cancellation as `WEB_ABORTED`, non-2xx as `WEB_PROVIDER_ERROR`, and a missing credential as `WEB_PROVIDER_CREDENTIAL_MISSING`.
- The package compiles under `tsc -b` and is registered in `tsconfig.host.json`; the generated config catalog carries its `Config`.
- The web group unit suite (251 tests) passes alongside the new package.

## Alternatives considered

**Reuse the DeepSeek Messages search even without native search.** Rejected: the provider requires a `web_search_tool_result` block and throws `WEB_PROVIDER_ERROR` when absent, so a self-hosted endpoint without the native tool cannot use it.

**Point the self-hosted DeepSeek at the easytransnote search via `baseURL`.** Rejected: `baseURL` only renames the endpoint of the same provider; it cannot change which API or response shape the provider speaks.

**Route easytransnote search through a new `dsh-web` capability instead of a provider.** Rejected: the seam already owns search/fetch selection and errors; a new capability would duplicate selection and the `web_search`/`web_fetch` tools.

**Add only a fetch provider.** Rejected: a self-hosted DeepSeek without native search still needs search; one package covering both keeps the mount and configuration in one place.

## Consequences

- A self-hosted DeepSeek deployment can enable both `web_search` and `web_fetch` through one easytransnote API key and endpoint, without relying on a native search tool.
- The search result carries bare URLs only (no per-source title or snippet), because easytransnote returns them without those fields; the seam omits them rather than inventing content.
- The fetch body is the API's markdown or HTML; the `WebFetchBody` kind follows what the API returns, so the tool's HTML→markdown conversion applies only on the `html` fallback path.
- Every easytransnote request is credential-bearing and fails on any redirect response, consistent with the web capability's credentialed-request policy.
