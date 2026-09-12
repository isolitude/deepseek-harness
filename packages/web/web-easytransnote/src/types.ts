/**
 * easytransnote wire types for the search and fetch requests this package
 * sends, and the response shapes it parses. Only the fields the providers read
 * are declared; the API returns more, and the extra fields are ignored rather
 * than inventoried. The endpoint, path, and payload field names are the
 * provider's contract, not the seam's — the seam vocabulary lives in
 * `@deepseek-ai/dsh-web`.
 * @module @deepseek-ai/dsh-web-easytransnote/types
 */

/** Response body of `POST /beta/v1/web/fetch`. */
export interface EasyTransnoteFetchResponse {
  /** Opaque request id echoed by the API. */
  readonly id?: string
  /** Markdown rendering of the fetched page. */
  readonly markdown?: string
  /** Raw HTML of the fetched page. */
  readonly html?: string
}

/** Response body of `POST /beta/v1/web/search`. */
export interface EasyTransnoteSearchResponse {
  /** Generated answer text or search summary, with inline citation markers. */
  readonly text?: string
  /** Plain URLs returned for the topic, in result order. */
  readonly urls?: readonly string[]
  /** Citation spans pointing into `text`; used only to associate a URL. */
  readonly citations?: readonly EasyTransnoteCitation[]
}

/** One citation span in a search response. */
export interface EasyTransnoteCitation {
  readonly start_index?: number
  readonly end_index?: number
  readonly segments?: readonly {
    readonly label?: string
    readonly short_url?: string
    readonly value?: string
  }[]
}
