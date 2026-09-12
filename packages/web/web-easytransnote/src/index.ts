/**
 * Register easytransnote-backed search and fetch providers in `ctx.web`. Both
 * talk to the same hosted API; each registers under the `easytransnote` id in
 * its own capability registry. The API key resolves per operation through
 * `ctx.credentials` (falling back to the launching environment), so a rotated
 * key reaches the next call without a restart.
 * @module @deepseek-ai/dsh-web-easytransnote
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
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

/** Settings namespace carrying this provider's endpoint, models, and key reference. */
export const WEB_EASYTRANSNOTE_SETTINGS_NAMESPACE = 'web-easytransnote'

/** Plugin config (all optional — `apply` fills credential, env, and constant defaults). */
export interface Config {
  /** Literal easytransnote API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each operation; defaults to `EASYTRANSNOTE_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/beta/v1/web/search` and `/beta/v1/web/fetch` are appended. */
  baseURL?: string
  /** Search model name. Defaults to `web-search-base`. */
  searchModel?: string
  /** Fetch model name. Defaults to `web-fetch-lite`. */
  fetchModel?: string
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  searchModel: z.string().default(DEFAULT_SEARCH_MODEL),
  fetchModel: z.string().default(DEFAULT_FETCH_MODEL),
})

/**
 * Project one resolved section into the options the providers serve their next
 * operation with. Environment fallbacks stay here rather than in the providers.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search or fetch.
 */
function resolveOptions(ctx: Context, config: Config): EasyTransnoteProviderOptions {
  const ref = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value
      ?? EASYTRANSNOTE_DEFAULT_BASE_URL,
    searchModel: config.searchModel ?? DEFAULT_SEARCH_MODEL,
    fetchModel: config.fetchModel ?? DEFAULT_FETCH_MODEL,
  }
}

/** Register the easytransnote search and fetch providers with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_EASYTRANSNOTE_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // The registration carries no resolved value: each provider projects the
      // section per operation, so a committed change needs no re-registration.
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new EasyTransnoteSearchProvider(() => resolveOptions(ctx, current())))
  ctx.web.registerFetchProvider(new EasyTransnoteFetchProvider(() => resolveOptions(ctx, current())))
}
