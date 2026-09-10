/**
 * Model-facing remote SSH tools over `ctx.remote`: `remote_exec`,
 * `remote_read`, `remote_write`, `remote_edit`, `remote_push`, `remote_pull`.
 * Each tool resolves the calling session's per-analysis `.dsh/config.yml`
 * (walking up from the session cwd) into a fully-explicit
 * {@link RemoteConnection} and delegates to the mounted provider. All defaults
 * live here (`timeoutMs`, transfer caps default at 60s / 256 MiB unless the
 * config overrides them); errors surface as typed, stable messages.
 * @module @deepseek-ai/dsh-tool-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { loadRemoteConnection } from './config.ts'
import { applyExecTool } from './exec.ts'
import { applyReadTool, applyWriteTool, applyEditTool } from './files.ts'
import { applyPushTool, applyPullTool } from './transfer.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-remote'

/** Services required by the remote tool suite. */
export const inject = ['tools', 'remote', 'systemPrompt']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default command deadline in milliseconds. Default 60s. */
  timeoutMs?: number
  /** Maximum lines returned by one `remote_read` call. Default 2000. */
  readLimit?: number
  /** Default transfer cap in bytes. Default 256 MiB. */
  maxTransferBytes?: number
  /** Default remote working directory for `remote_exec`. Default = config.remoteRoot. */
  workdir?: string
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(60_000),
  readLimit: z.number().default(2000),
  maxTransferBytes: z.number().default(256 * 1024 * 1024),
  workdir: z.string(),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'workdir'>> & Pick<Config, 'workdir'>

/** Every tunable must be a positive finite number. */
function assertPositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`tool-remote: ${name} must be a positive finite number`)
  }
}

/** Register the full `remote_*` tool suite. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveNumber('timeoutMs', resolved.timeoutMs)
  assertPositiveNumber('readLimit', resolved.readLimit)
  assertPositiveNumber('maxTransferBytes', resolved.maxTransferBytes)
  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: 'tool:remote',
    order: ctx.systemPrompt.getSectionOrder('TOOL_REMOTE'),
    text: 'Use the remote_* tools to execute commands and transfer files on the analysis\'s remote server: '
      + 'remote_exec runs a shell command, remote_read/write/edit manage remote text files, '
      + 'remote_push uploads a local file (scripts), remote_pull downloads a remote file (results). '
      + 'Paths are relative to the remote workspace root unless absolute; overwrites require explicit overwrite: true.',
  })
  // Load the connection inside each execution so per-call session context and
  // freshly rotated credentials apply; never cache it at registration.
  const connectionLoader = loadRemoteConnection
  applyExecTool(ctx, { connectionLoader, defaultTimeoutMs: resolved.timeoutMs, defaultWorkdir: resolved.workdir })
  applyReadTool(ctx, { connectionLoader, defaultLimit: resolved.readLimit })
  applyWriteTool(ctx, { connectionLoader })
  applyEditTool(ctx, { connectionLoader })
  applyPushTool(ctx, { connectionLoader, defaultMaxTransferBytes: resolved.maxTransferBytes })
  applyPullTool(ctx, { connectionLoader, defaultMaxTransferBytes: resolved.maxTransferBytes })
}

export {
  execDefaultTimeoutMs,
} from './exec.ts'
export {
  readDefaultLimit,
} from './files.ts'
export {
  transferDefaultMaxBytes,
} from './transfer.ts'
export type {
  ConnectionLoader,
} from './connection.ts'
