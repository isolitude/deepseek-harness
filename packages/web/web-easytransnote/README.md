---
description: "The easytransnote-backed web search and fetch providers for ctx.web: how deployments use one hosted API for both searching the web and fetching a URL to text or markdown."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-easytransnote

English | [中文](README.zh.md)

## Summary

With `dsh-web-easytransnote`, the harness searches the web and fetches a URL through one hosted easytransnote API instead of separate vendor backends, which suits a self-hosted DeepSeek that has no native `web_search` tool. It registers both a search and a fetch provider under the `easytransnote` id in `ctx.web`. The API key resolves per operation through the credentials service, and every request carries an `Authorization: Bearer` header and fails on redirects rather than forwarding credentials. Choose it when you have an easytransnote API key and want both search and fetch from one endpoint.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service. It registers `easytransnote` as both the search and the fetch provider id, so `ctx.web.search()` and `ctx.web.fetch()` resolve it automatically when it is the only usable backend in each capability — or pin it with `searchProvider: easytransnote` and `fetchProvider: easytransnote`.

### When to choose it

Choose this backend when a deployment holds an easytransnote API key and wants both search and fetch from one hosted API — for example a self-hosted DeepSeek that exposes no native server-side web search. The search endpoint returns a generated answer plus plain URLs; the fetch endpoint returns markdown (and HTML). The provider is unavailable — and every call fails with a structured error — when the key is empty or the endpoint base does not parse.

### Minimal configuration

Load the web service and the provider; the API key falls back to `$EASYTRANSNOTE_API_KEY` and `$EASYTRANSNOTE_BASE_URL`, and all other settings have defaults.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-easytransnote'
  config:
    apiKeyEnv: EASYTRANSNOTE_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal easytransnote API key; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins over the resolver |
| `apiKeyEnv` | `EASYTRANSNOTE_API_KEY` | Credential reference resolved for each operation through `ctx.credentials`, or from the launching environment when the credentials service is absent. A missing value fails as `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `baseURL` | `https://api.easytransnote.com` | Endpoint base; `/beta/v1/web/search` and `/beta/v1/web/fetch` are appended. Falls back to `$EASYTRANSNOTE_BASE_URL` |
| `searchModel` | `web-search-base` | Search model name sent as `model` to the search endpoint |
| `fetchModel` | `web-fetch-lite` | Fetch model name sent as `model` to the fetch endpoint |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-easytransnote) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

`content` carries the easytransnote answer text when present; `sources[]` carries the returned plain URLs, deduplicated in result order. Because easytransnote returns bare URLs with no per-source title or snippet, `WebSearchSource` items carry only `url` — a producer that omits the optional fields keeps the seam honest rather than inventing them. The seam's `maxResults` bound applies on the way back.

### What a fetch returns

The fetch endpoint returns `markdown` and `html`. The provider prefers `markdown` and maps it to a `text` `WebFetchBody`; when `markdown` is absent it maps `html` to an `html` body. A response with neither fails loud as `WEB_PROVIDER_ERROR`. The result's `statusCode` is `200` because a successful easytransnote fetch means the API processed the request; the API reports failures as non-2xx responses.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; a missing credential is `WEB_PROVIDER_CREDENTIAL_MISSING`; caller cancellation is `WEB_ABORTED`. Every request is sent with `redirect: 'error'`, so a redirect response is not followed and does not forward the `Authorization` header to another origin. Callers route on the code; the model-facing `web_search` and `web_fetch` tools surface failures under their own error wrappers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the providers; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One API, two providers.** Both providers talk to the same hosted API but register separately: search under the search registry and fetch under the fetch registry, each using the `easytransnote` id. They share the same endpoint base and credential, but each capability auto-selects independently, so mounting only search leaves fetch to another provider and vice versa.
- **Credential-bearing requests never follow redirects.** Every request carries `Authorization: Bearer <key>` and is sent with `redirect: 'error'`, so a redirect cannot forward the credential or request body to another origin. This is the package's opt-in to the web capability's credentialed-request policy.
- **Per-operation credential resolution.** The API key resolves through `ctx.credentials` (falling back to the launching environment) on each operation, so a rotated key reaches the next call without a restart.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, Settings section, per-operation option projection, provider registration |
| [`src/provider.ts`](src/provider.ts) | `EasyTransnoteSearchProvider` and `EasyTransnoteFetchProvider`, the shared POST helper, and response mapping |
| [`src/types.ts`](src/types.ts) | easytransnote wire types for the search and fetch responses |

### Request flow

Each operation projects the current Settings section into provider options, resolves the credential reference through `ctx.credentials` (or the environment), then POSTs JSON to the search or fetch endpoint with `redirect: 'error'`. The response is parsed and mapped into the seam's normalized result: search maps `urls[]` to `sources[]` and `text` to `content`; fetch maps `markdown` (or `html`) to the closed `WebFetchBody`. Non-2xx, unparseable, or shape-incomplete responses become `WebError`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search/fetch request and result vocabulary and error codes.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` and `web_fetch` tools.
- [dsh-web-search-deepseek](../web-search-deepseek/README.md) — the shipped DeepSeek native-search backend, for when your endpoint supports it.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`: search renders the returned answer and source URLs as citeable markdown links; fetch renders the fetched markdown or converted HTML to text. This package contributes no prompt or schema of its own.

#### KV Cache effect

No direct invalidation; `dsh-tool-web` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No per-source title or snippet** — the search endpoint returns bare URLs, so `WebSearchSource` items carry only `url`; the shaped fields stay absent rather than invented.
- **Credentials must be configured** — the provider is unavailable without an easytransnote API key, and a missing key fails each operation as `WEB_PROVIDER_CREDENTIAL_MISSING`.
- **One provider id per capability** — search and fetch each register as `easytransnote` in their own registry, so you cannot use easytransnote for search and a different vendor at the same id; the seam's provider selection still auto-selects or pins per capability.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
