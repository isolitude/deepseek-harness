/**
 * easytransnote-backed providers for `ctx.web`. One class serves search and one
 * serves fetch, both talking to the same hosted API over gig exchange JSON. The
 * API is credential-bearing (an `Authorization: Bearer` header), so every
 * request is sent with `redirect: 'error'` and a non-2xx or redirected response
 * fails loud rather than forwarding credentials to another origin. The wire
 * format and native `fetch` client are provider-private and do not use
 * `ctx.llm`.
 * @module @deepseek-ai/dsh-web-easytransnote/provider
 */

import { WebError, type WebFetchBody, type WebFetchProvider, type WebFetchRequest, type WebFetchResult, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import type { EasyTransnoteFetchResponse, EasyTransnoteSearchResponse } from './types.ts'

/** Id the search provider registers under. */
export const EASYTRANSNOTE_SEARCH_PROVIDER_ID = 'easytransnote'

/** Id the fetch provider registers under. */
export const EASYTRANSNOTE_FETCH_PROVIDER_ID = 'easytransnote'

/** Default endpoint; `/beta/v1/web/{search,fetch}` is appended. */
export const EASYTRANSNOTE_DEFAULT_BASE_URL = 'https://api.easytransnote.com'

/** Default `Authorization` scheme set from the API key. */
const BEARER_SCHEME = 'Bearer'

/** Attribute sent on every request; a provider-adapter boundary, not the seam. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved options for one operation (the plugin supplies defaults). */
export interface EasyTransnoteProviderOptions {
  /** Literal API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current API key for one operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: string
  /** Endpoint base; `/beta/v1/web/search` or `/beta/v1/web/fetch` is appended. */
  baseURL: string
  /** Search model name sent as `model`. Defaults to `web-search-base`. */
  searchModel: string
  /** Fetch model name sent as `model`. Defaults to `web-fetch-lite`. */
  fetchModel: string
}

/** Normalize an unknown thrown value to a message. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The error every post-dispatch failure of the easytransnote API carries. */
function endpointError(endpoint: string, detail: string, cause?: unknown): WebError {
  return new WebError(
    `easytransnote request to ${JSON.stringify(endpoint)} failed: ${detail}`,
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/** The error a caller-aborted operation carries. */
function abortedError(): WebError {
  return new WebError('easytransnote request aborted', 'WEB_ABORTED')
}

/** True when the thrown value is a fetch abort (`AbortError`). */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Whether the caller already cancelled. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortedError()
}

/** Resolve the API key for one operation, or throw when none can be provided. */
async function resolveApiKey(options: EasyTransnoteProviderOptions, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
  let resolved: string | undefined
  try {
    resolved = await (options.resolveApiKey?.() ?? Promise.resolve(undefined))
  } catch (error: unknown) {
    if (isAbortError(error) || signal?.aborted === true) throw abortedError()
    throw endpointError(options.baseURL, `credential resolution failed: ${messageOf(error)}`, error)
  }
  throwIfAborted(signal)
  if (resolved !== undefined && resolved.length > 0) return resolved
  const ref = options.apiKeyEnv ?? 'EASYTRANSNOTE_API_KEY'
  throw new WebError(
    `easytransnote has no API key for "${ref}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-easytransnote config`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/** Build the credential-bearing request headers, rejecting redirects. */
function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'authorization': `${BEARER_SCHEME} ${apiKey}`,
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': USER_AGENT,
  }
}

/** POST a JSON body and return the parsed response, mapping failures to `WebError`. */
async function postJson(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      // The request carries an Authorization header; a redirect must not forward
      // it to another origin, so the client fails on any redirect response.
      redirect: 'error',
      headers: requestHeaders(apiKey),
      body: JSON.stringify(body),
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError()
    throw endpointError(endpoint, `request failed: ${messageOf(error)}`, error)
  }
  if (!response.ok) {
    const status = response.status
    let detail = `HTTP ${status}`
    try {
      const parsed = await response.json() as Record<string, unknown>
      const message = parsed['message'] ?? parsed['error']
      if (typeof message === 'string' && message.length > 0) detail += `: ${message}`
    } catch {
      if (signal?.aborted === true || isAbortError(response)) throw abortedError()
    }
    throw endpointError(endpoint, detail)
  }
  try {
    return await response.json() as unknown
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError()
    throw endpointError(endpoint, `unprocessable response body: ${messageOf(error)}`, error)
  }
}

/** Map a search topic to the request URL. */
function searchUrl(baseURL: string): string {
  return `${baseURL.replace(/\/$/, '')}/beta/v1/web/search`
}

/** Map a fetch URL to the request URL. */
function fetchUrl(baseURL: string): string {
  return `${baseURL.replace(/\/$/, '')}/beta/v1/web/fetch`
}

/** The easytransnote-backed search provider. */
export class EasyTransnoteSearchProvider implements WebSearchProvider {
  readonly id = EASYTRANSNOTE_SEARCH_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   * at each operation's entry so one search never mixes two sections.
   */
  constructor(private readonly resolveOptions: () => EasyTransnoteProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && options.searchModel.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await resolveApiKey(options, signal)
    const endpoint = searchUrl(options.baseURL)
    const payload = await postJson(endpoint, apiKey, {
      model: options.searchModel,
      topic: request.query,
    }, signal) as EasyTransnoteSearchResponse
    return mapSearchResponse(payload)
  }
}

/** Map an easytransnote search response to the seam's normalized result.
 * @param payload - the raw easytransnote search response.
 * @returns the seam's normalized {@link WebSearchResult}.
 */
export function mapSearchResponse(payload: EasyTransnoteSearchResponse): WebSearchResult {
  const urls = payload.urls ?? []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    sources.push({ url })
  }
  const text = payload.text
  return {
    ...text !== undefined && text.length > 0 ? { content: text } : {},
    sources,
    truncated: false,
  }
}

/** The easytransnote-backed fetch provider. */
export class EasyTransnoteFetchProvider implements WebFetchProvider {
  readonly id = EASYTRANSNOTE_FETCH_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   * at each operation's entry so one fetch never mixes two sections.
   */
  constructor(private readonly resolveOptions: () => EasyTransnoteProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && options.fetchModel.length > 0
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const options = this.resolveOptions()
    const apiKey = await resolveApiKey(options, signal)
    const endpoint = fetchUrl(options.baseURL)
    const payload = await postJson(endpoint, apiKey, {
      model: options.fetchModel,
      url: request.url,
    }, signal) as EasyTransnoteFetchResponse
    return mapFetchResponse(payload, request.url)
  }
}

/** Map an easytransnote fetch response to the seam's normalized fetch result.
 * @param payload - the raw easytransnote fetch response.
 * @param requestedUrl - the originally requested URL, used in the error message and result.
 * @returns the seam's normalized {@link WebFetchResult}.
 */
export function mapFetchResponse(payload: EasyTransnoteFetchResponse, requestedUrl: string): WebFetchResult {
  // Prefer the API's markdown rendering as text; fall back to its HTML so a
  // fetch still yields something when markdown is absent. The seam's closed
  // `WebFetchBody` owns the kind; the API returns HTML, so both arms decode to
  // the text/markdown or html the tool renders.
  const markdown = payload.markdown
  const html = payload.html
  let body: WebFetchBody
  if (markdown !== undefined && markdown.length > 0) {
    body = { kind: 'text', content: markdown }
  } else if (html !== undefined && html.length > 0) {
    body = { kind: 'html', content: html }
  } else {
    throw new WebError(
      `easytransnote returned no markdown or html for ${JSON.stringify(requestedUrl)}`,
      'WEB_PROVIDER_ERROR',
    )
  }
  return {
    url: requestedUrl,
    statusCode: 200,
    body,
    truncated: false,
  }
}
