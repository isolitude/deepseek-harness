import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
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
    expect(searchProvider({ ...base, apiKey: '', resolveApiKey: undefined }).available()).toBe(false)
  })

  it('is available through a resolver', () => {
    const options = { ...base, apiKey: undefined, resolveApiKey: async () => 'resolved' }
    expect(searchProvider(options).available()).toBe(true)
  })
})

describe('search request', () => {
  it('posts the query as topic with the model and an auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: 'answer', urls: ['https://a.test'] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchProvider(base).search({ query: 'latest AI' })
    expect(result.content).toBe('answer')
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.easytransnote.test/beta/v1/web/search')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ authorization: 'Bearer et-key', 'content-type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({ model: 'web-search-base', topic: 'latest AI' })
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
    const options = { ...base, apiKey: undefined, resolveApiKey: async () => undefined }
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
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
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.easytransnote.test/beta/v1/web/fetch')
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ authorization: 'Bearer et-key' })
    expect(JSON.parse(init.body)).toEqual({ model: 'web-fetch-lite', url: 'https://en.wikipedia.org/wiki/AI' })
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
