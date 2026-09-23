import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import * as easytransnotePlugin from '@deepseek-ai/dsh-web-easytransnote'
import {
  EasyTransnoteFetchProvider,
  EasyTransnoteSearchProvider,
  mapFetchResponse,
  mapSearchResponse,
} from '../src/provider.ts'
import type { EasyTransnoteProviderOptions } from '../src/provider.ts'

const base = {
  apiKey: 'et-key',
  baseURL: 'https://api.easytransnote.test',
  searchModel: 'web-search-base',
  fetchModel: 'web-fetch-lite',
}

/** `base` without the literal `apiKey`, for resolver-based credential tests. */
const baseNoKey = {
  baseURL: base.baseURL,
  searchModel: base.searchModel,
  fetchModel: base.fetchModel,
}

const searchProvider = (options: EasyTransnoteProviderOptions): EasyTransnoteSearchProvider =>
  new EasyTransnoteSearchProvider(() => options)

const fetchProvider = (options: EasyTransnoteProviderOptions): EasyTransnoteFetchProvider =>
  new EasyTransnoteFetchProvider(() => options)

async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof WebError) return error
    throw error
  }
  throw new Error('expected operation to reject')
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mapSearchResponse', () => {
  it('maps urls to sources and text to content', () => {
    const result = mapSearchResponse({
      text: 'summary text',
      urls: ['https://a.test', 'https://b.test'],
    })
    expect(result).toEqual({
      content: 'summary text',
      sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }],
      truncated: false,
    })
  })

  it('dedupes repeated urls and drops empty or non-string ones', () => {
    const result = mapSearchResponse({
      urls: ['https://a.test', 'https://a.test', '', 42 as unknown as string],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
    expect(result.content).toBeUndefined()
  })

  it('omits content when text is absent', () => {
    const result = mapSearchResponse({ urls: ['https://a.test'] })
    expect(result.content).toBeUndefined()
    expect(result.sources).toHaveLength(1)
  })

  it('treats a missing urls field as an empty source list', () => {
    const result = mapSearchResponse({ text: 'summary' })
    expect(result.sources).toEqual([])
    expect(result.content).toBe('summary')
    expect(result.truncated).toBe(false)
  })
})

describe('mapFetchResponse', () => {
  it('prefers markdown as text content', () => {
    const result = mapFetchResponse({ markdown: '# hi', html: '<h1>hi</h1>' }, 'https://a.test')
    expect(result).toEqual({ url: 'https://a.test', statusCode: 200, body: { kind: 'text', content: '# hi' }, truncated: false })
  })

  it('falls back to html content when markdown is absent', () => {
    const result = mapFetchResponse({ html: '<h1>hi</h1>' }, 'https://a.test')
    expect(result.body).toEqual({ kind: 'html', content: '<h1>hi</h1>' })
  })

  it('fails loud when neither markdown nor html is present', () => {
    try {
      mapFetchResponse({}, 'https://a.test')
      throw new Error('expected mapFetchResponse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WebError)
    }
  })
})

describe('available', () => {
  it('is available with a literal key', () => {
    expect(searchProvider(base).available()).toBe(true)
    expect(fetchProvider(base).available()).toBe(true)
  })

  it('is unavailable without a key or resolver', () => {
    expect(searchProvider({ ...base, apiKey: '' }).available()).toBe(false)
  })

  it('is available through a resolver', () => {
    const options = { ...baseNoKey, resolveApiKey: async () => 'resolved' }
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is unavailable on the fetch provider when its model name is empty', () => {
    expect(fetchProvider({ ...base, fetchModel: '' }).available()).toBe(false)
  })

  it('is unavailable on the fetch provider without a key, resolver, or model', () => {
    expect(fetchProvider({ ...baseNoKey, fetchModel: '' }).available()).toBe(false)
  })
})

describe('search request', () => {
  it('posts the query as topic with the model and an auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: 'answer', urls: ['https://a.test'] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchProvider(base).search({ query: 'latest AI' })
    expect(result.content).toBe('answer')
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.easytransnote.test/beta/v1/web/search')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ authorization: 'Bearer et-key', 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ model: 'web-search-base', topic: 'latest AI' })
  })

  it('fails loud on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'quota' }), { status: 429 })))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('HTTP 429')
    expect(error.message).toContain('quota')
  })

  it('surfaces cancellation as WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }, controller.signal))
    expect(error.code).toBe('WEB_ABORTED')
  })

  it('throws WEB_PROVIDER_CREDENTIAL_MISSING when no key resolves', async () => {
    const options = { ...baseNoKey, resolveApiKey: async () => undefined }
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
  })

  it('maps a credential-resolution failure to WEB_PROVIDER_ERROR', async () => {
    const options = { ...baseNoKey, resolveApiKey: async () => { throw new Error('credential store down') } }
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('credential resolution failed')
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('connection refused')
  })

  it('normalizes a non-Error network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('raw socket error'))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('raw socket error')
  })

  it('keeps the status-line detail when an error body carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 123 }, { status: 500 })))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('failed: HTTP 500')
    expect(error.message).not.toContain(': 123')
  })

  it('maps an abort during the fetch to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_ABORTED')
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('unprocessable response body')
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_ABORTED')
  })

  it('surfaces an abort during credential resolution as WEB_ABORTED', async () => {
    const options = { ...baseNoKey, resolveApiKey: async () => { throw new DOMException('aborted', 'AbortError') } }
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_ABORTED')
  })

  it('falls through to credential-missing when no apiKey or resolver is present', async () => {
    const error = await rejectedWebError(searchProvider({ ...baseNoKey }).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const controller = new AbortController()
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return body as unknown as Response
    }))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }, controller.signal))
    expect(error.code).toBe('WEB_ABORTED')
  })

  it('fails loud when the error body cannot be parsed and the response is not an abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('body not json')),
    } as unknown as Response)))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('HTTP 500')
  })

  it('surfaces an abort during error-body parse of an AbortError response as WEB_ABORTED', async () => {
    const response = Object.assign(new DOMException('aborted', 'AbortError'), {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('body not json')),
    }) as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const error = await rejectedWebError(searchProvider(base).search({ query: 'q' }))
    expect(error.code).toBe('WEB_ABORTED')
  })
})

describe('fetch request', () => {
  it('posts the url as the fetch body and maps markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ markdown: '# content', html: 'ignored' }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchProvider(base).fetch({ url: 'https://en.wikipedia.org/wiki/AI' })
    expect(result).toEqual({
      url: 'https://en.wikipedia.org/wiki/AI',
      statusCode: 200,
      body: { kind: 'text', content: '# content' },
      truncated: false,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.easytransnote.test/beta/v1/web/fetch')
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ authorization: 'Bearer et-key' })
    expect(JSON.parse(init.body as string)).toEqual({ model: 'web-fetch-lite', url: 'https://en.wikipedia.org/wiki/AI' })
  })

  it('surfaces a malformed body as WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    const error = await rejectedWebError(fetchProvider(base).fetch({ url: 'https://a.test' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
  })

  it('surfaces cancellation as WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await rejectedWebError(fetchProvider(base).fetch({ url: 'https://a.test' }, controller.signal))
    expect(error.code).toBe('WEB_ABORTED')
  })
})

describe('web-easytransnote plugin registration', () => {
  /** Search and fetch both register under the `easytransnote` id. */
  const webConfig = { searchProvider: 'easytransnote', fetchProvider: 'easytransnote' }

  it('no default export, keeping the namespace plugin export shape', () => {
    expect('default' in easytransnotePlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    // A default export would make `unwrapExports` collapse the namespace and drop `inject: ['web']`.
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(easytransnotePlugin) as Record<string, unknown>
    expect(unwrapped).toBe(easytransnotePlugin)
    expect(unwrapped.name).toBe('web-easytransnote')
    expect(unwrapped.inject).toEqual(['web'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  /** A fetch mock that returns a fresh one-shot Response per call. */
  function searchAndFetchMock() {
    return vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ markdown: '# content', urls: ['https://a.test'] })))
  }

  it('registers search and fetch providers into ctx.web (HMR-safe)', async () => {
    const fetchMock = searchAndFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, webConfig)
    const fiber = await ctx.plugin(easytransnotePlugin, { apiKey: 'et-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await expect(ctx.web.fetch({ url: 'https://a.test' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('boots over ctx.web through the unwrapped module without an inject error', async () => {
    vi.stubGlobal('fetch', searchAndFetchMock())
    const ctx = new Context()
    await ctx.plugin(WebRuntime, webConfig)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(easytransnotePlugin) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { apiKey: 'et-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
  })

  it('falls back to the env key and defaults when config omits them', async () => {
    const prev = process.env.EASYTRANSNOTE_API_KEY
    process.env.EASYTRANSNOTE_API_KEY = 'env-key'
    try {
      const fetchMock = searchAndFetchMock()
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, webConfig)
      easytransnotePlugin.apply(ctx, easytransnotePlugin.Config({}))
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.easytransnote.com/beta/v1/web/search')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer env-key')
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.EASYTRANSNOTE_API_KEY
      else process.env.EASYTRANSNOTE_API_KEY = prev
    }
  })

  it('reports a credential error when neither config nor env supplies a key', async () => {
    const prev = process.env.EASYTRANSNOTE_API_KEY
    delete process.env.EASYTRANSNOTE_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, webConfig)
      await ctx.plugin(easytransnotePlugin, {})
      const error = await rejectedWebError(ctx.web.search({ query: 'q' }))
      expect(error).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    } finally {
      if (prev !== undefined) process.env.EASYTRANSNOTE_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a rotated key needs no restart', async () => {
    const previous = process.env.EASYTRANSNOTE_API_KEY
    delete process.env.EASYTRANSNOTE_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-easytransnote-credentials-'))
    const fetchMock = searchAndFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, webConfig)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(easytransnotePlugin, {})

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('EASYTRANSNOTE_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value.authorization)).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.EASYTRANSNOTE_API_KEY
      else process.env.EASYTRANSNOTE_API_KEY = previous
    }
  })
})
