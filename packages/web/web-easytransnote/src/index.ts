/**
 * Register easytransnote-backed search and fetch providers in `ctx.web`. Both
 * talk to the same hosted API; each registers under the `easytransnote` id in
 * its own capability registry. The API key resolves per operation through
 * `ctx.credentials` (falling back to the launching environment), so a rotated
 * key reaches the next call without a restart.
 * @module @deepseek-ai/dsh-web-easytransnote
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import {
  EasyTransnoteFetchProvider,
  EasyTransnoteSearchProvider,
  EASYTRANSNOTE_DEFAULT_BASE_URL,
} from './provider.ts'
import type { EasyTransnoteProviderOptions } from './provider.ts'

export {
  EASYTRANSNOTE_DEFAULT_BASE_URL,
  EASYTRANSNOTE_FETCH_PROVIDER_ID,
  EASYTRANSNOTE_SEARCH_PROVIDER_ID,
  EasyTransnoteFetchProvider,
  EasyTransnoteSearchProvider,
} from './provider.ts'
export type { EasyTransnoteProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-easytransnote'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'EASYTRANSNOTE_API_KEY'

const DEFAULT_SEARCH_MODEL = 'web-search-base'
const DEFAULT_FETCH_MODEL = 'web-fetch-lite'

/** Environment variable naming this provider's endpoint base. */
const BASE_URL_ENV = 'EASYTRANSNOTE_BASE_URL'

/** Plugin config (all optional — `apply` fills credential, env, and constant defaults). */
export interface Config {
  /** Literal easytransnote API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each operation; defaults to `EASYTRANSNOTE_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Endpoint base; `/beta/v1/web/search` and `/beta/v1/web/fetch` are appended. */
  baseURL: Volatile<string | undefined>
  /** Search model name. Defaults to `web-search-base`. */
  searchModel: Volatile<string>
  /** Fetch model name. Defaults to `web-fetch-lite`. */
  fetchModel: Volatile<string>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().volatile(),
  searchModel: z.string().default(DEFAULT_SEARCH_MODEL).volatile(),
  fetchModel: z.string().default(DEFAULT_FETCH_MODEL).volatile(),
})

/**
 * Project one resolved section into the options the providers serve their next
 * operation with. Environment fallbacks stay here rather than in the providers:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search or fetch.
 */
function resolveOptions(
  ctx: Context, config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): EasyTransnoteProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value
      ?? EASYTRANSNOTE_DEFAULT_BASE_URL,
    searchModel: config.searchModel,
    fetchModel: config.fetchModel,
  }
}

/** Register the easytransnote search and fetch providers with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new EasyTransnoteSearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(),
    searchModel: config.searchModel.get(), fetchModel: config.fetchModel.get(),
  })))
  ctx.web.registerFetchProvider(new EasyTransnoteFetchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(),
    searchModel: config.searchModel.get(), fetchModel: config.fetchModel.get(),
  })))
}
