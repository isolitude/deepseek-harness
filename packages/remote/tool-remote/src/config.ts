/**
 * Resolve the per-analysis remote configuration that backs the `remote_*`
 * tools: starting at the calling session's cwd, walk up to the nearest
 * `analyses/<analysis>/.dsh/config.yml` declaring a `remote:` block, and turn
 * it into a fully-materialized {@link RemoteConnection}. Credentials resolve
 * here (`keyPath` files are pointed at, `passwordRef` names resolve through
 * `ctx.credentials`) but never enter a tool argument or result surface.
 * @module @deepseek-ai/dsh-tool-remote/config
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Session } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-remote'
import type { RemoteAuth, RemoteConnection } from '@deepseek-ai/dsh-remote'
import { parse as parseYaml } from 'yaml'
/** `remote:` block declared in an analysis `.dsh/config.yml`. */
export interface RemoteConfigFile {
  host: unknown
  port?: unknown
  user: unknown
  remoteRoot: unknown
  /** Auth block: `{ kind: 'key', keyPath?, passphraseRef? } | { kind: 'password', passwordRef } | { kind: 'agent' }`. */
  auth?: unknown
  /** Expected host-key SHA256 fingerprint (base64). Absent = strict refusal. */
  hostKeyFingerprint?: unknown
  /** Positive command deadline. Default 60s. */
  timeoutMs?: unknown
  /** Connection-establishment deadline. Default 15s. */
  connectTimeoutMs?: unknown
  /** Positive transfer cap in bytes. Default 256 MiB. */
  maxTransferBytes?: unknown
  /** Empty when the file or the `remote:` block is absent. */
  missing?: boolean
}

/** Walk up from a directory looking for a `<dir>/.dsh/config.yml`. */
export async function findAnalysisDotDsh(startDir: string): Promise<string | undefined> {
  let current = isAbsolute(startDir) ? startDir : join(process.cwd(), startDir)
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = join(current, '.dsh', 'config.yml')
    try {
      await readFile(candidate)
      return candidate
    } catch {
      /* keep walking up */
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** One awkward helper: assert a schema value exists in a config block. */
function required(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteError(`remote config: '${field}' must be a non-empty string`, 'REMOTE_CONNECT_FAILED')
  }
  return value
}

function positiveInteger(field: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RemoteError(`remote config: '${field}' must be a positive number`, 'REMOTE_CONNECT_FAILED')
  }
  return value
}

/** Resolve one credential reference; the credentials service is optional unless used. */
async function resolveCredential(
  ctx: Context,
  ref: string,
): Promise<{ value: string } | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new RemoteError(
      `remote config: credential '${ref}' requested but no credentials service is mounted; load @deepseek-ai/dsh-credentials-local`,
      'REMOTE_AUTH_FAILED',
    )
  }
  return credentials.resolve(credentialRef(ref))
}

/** Resolve the auth materialization for one config file auth block. */
async function resolveAuth(
  ctx: Context,
  analysisDir: string,
  auth: unknown,
): Promise<RemoteAuth> {
  if (auth === undefined || typeof auth !== 'object' || auth === null) {
    // Default: key file at the analysis .dsh/secrets/id_ed25519.
    return { kind: 'key', keyPath: join(analysisDir, '.dsh', 'secrets', 'id_ed25519') }
  }
  const block = auth as Record<string, unknown>
  const kind = block['kind']
  if (kind === 'key') {
    const keyPath = block['keyPath']
    if (typeof keyPath !== 'string' || keyPath.length === 0) {
      throw new RemoteError("remote config: auth.kind 'key' requires a keyPath", 'REMOTE_AUTH_FAILED')
    }
    const absolute = isAbsolute(keyPath) ? keyPath : join(analysisDir, keyPath)
    const passphraseRef = block['passphraseRef']
    if (passphraseRef !== undefined) {
      if (typeof passphraseRef !== 'string') {
        throw new RemoteError('remote config: passphraseRef must be a string', 'REMOTE_AUTH_FAILED')
      }
      const hit = await resolveCredential(ctx, passphraseRef)
      if (hit === undefined) {
        throw new RemoteError(
          `remote config: passphrase credential '${passphraseRef}' is not configured`,
          'REMOTE_AUTH_FAILED',
        )
      }
      return { kind: 'key', keyPath: absolute, passphrase: hit.value }
    }
    return { kind: 'key', keyPath: absolute }
  }
  if (kind === 'password') {
    const passwordRef = block['passwordRef']
    if (typeof passwordRef !== 'string' || passwordRef.length === 0) {
      throw new RemoteError("remote config: auth.kind 'password' requires a passwordRef", 'REMOTE_AUTH_FAILED')
    }
    const hit = await resolveCredential(ctx, passwordRef)
    if (hit === undefined) {
      throw new RemoteError(
        `remote config: password credential '${passwordRef}' is not configured`,
        'REMOTE_AUTH_FAILED',
      )
    }
    return { kind: 'password', password: hit.value }
  }
  if (kind === 'agent') {
    return { kind: 'agent' }
  }
  throw new RemoteError(
    `remote config: unknown auth.kind '${String(kind)}' (expected key | password | agent)`,
    'REMOTE_AUTH_FAILED',
  )
}

/**
 * Load and materialize the remote connection for the calling session.
 * @param ctx - the plugin context (used for credential resolution).
 * @param session - the calling agent's session, whose cwd anchors the search.
 * @returns the resolved connection, or undefined when no `.dsh/config.yml` has a `remote:` block.
 */
export async function loadRemoteConnection(
  ctx: Context,
  session: Session,
): Promise<RemoteConnection | undefined> {
  const cwd = session.header.cwd
  if (cwd === undefined) return undefined
  const configPath = await findAnalysisDotDsh(cwd)
  if (configPath === undefined) return undefined
  let raw: unknown
  try {
    raw = parseYaml(await readFile(configPath, 'utf8'))
  } catch (cause) {
    /* v8 ignore next 2 -- the YAML parser rejects with Error instances; a bare-value cause is defensive. */
    throw new RemoteError(
      `cannot parse '${configPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
      'REMOTE_CONNECT_FAILED',
      { cause },
    )
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const root = raw as Record<string, unknown>
  const remote = root['remote']
  if (typeof remote !== 'object' || remote === null) return undefined
  const cfg = remote as RemoteConfigFile
  const host = required('remote.host', cfg.host)
  const user = required('remote.user', cfg.user)
  const remoteRoot = required('remote.remoteRoot', cfg.remoteRoot)
  const analysisDir = dirname(dirname(configPath))
  const auth = await resolveAuth(ctx, analysisDir, cfg.auth)
  // The optional command deadline is validated when present; the tool layer
  // resolves it as its own default, so it never rides the connection.
  positiveInteger('remote.timeoutMs', cfg.timeoutMs, Number.NaN)
  return {
    id: analysisDir,
    host,
    port: positiveInteger('remote.port', cfg.port, 22),
    user,
    auth,
    remoteRoot,
    connectTimeoutMs: positiveInteger('remote.connectTimeoutMs', cfg.connectTimeoutMs, 15_000),
    maxTransferBytes: positiveInteger('remote.maxTransferBytes', cfg.maxTransferBytes, 256 * 1024 * 1024),
    ...(typeof cfg.hostKeyFingerprint === 'string' && cfg.hostKeyFingerprint.length > 0
      ? { hostKeyFingerprint: cfg.hostKeyFingerprint }
      : {}),
  }
}
