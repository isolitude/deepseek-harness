/**
 * Remote-execution Service Definition (`ctx.remote`): run shell commands and
 * perform bounded file operations on a per-call resolved remote connection (SSH).
 * The seam is provider-neutral (`remote-ssh2` is the shipped provider); the tool layer
 * builds the fully-explicit {@link RemoteConnection} from per-analysis configuration,
 * so this service never sees a secret and never applies a hidden default.
 * @module @deepseek-ai/dsh-remote
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { RemoteError } from './types.ts'
import type {
  RemoteConnection,
  RemoteEditRequest,
  RemoteEditResult,
  RemotePullRequest,
  RemotePushRequest,
  RemoteReadRequest,
  RemoteReadResult,
  RemoteRunRequest,
  RemoteRunResult,
  RemoteTransferResult,
  RemoteWriteRequest,
  RemoteWriteResult,
} from './types.ts'

export {
  RemoteError,
} from './types.ts'
export type {
  RemoteAuth,
  RemoteConnection,
  RemoteEditRequest,
  RemoteEditResult,
  RemoteErrorCode,
  RemoteJumpHost,
  RemotePullRequest,
  RemotePushRequest,
  RemoteReadLine,
  RemoteReadRequest,
  RemoteReadResult,
  RemoteRunRequest,
  RemoteRunResult,
  RemoteTransferResult,
  RemoteWriteRequest,
  RemoteWriteResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remote: RemoteExecutor
  }
}

/** Resolve a remote path against a connection's root, rejecting parent escape.
 * @param connection - the resolved connection carrying the remote root.
 * @param path - the candidate remote path (absolute, or root-relative).
 * @returns the normalized path confirmed under the root.
 * @throws {@link RemoteError} with `REMOTE_PERMISSION_DENIED` when the path escapes the root.
 */
export function resolveRemotePath(connection: RemoteConnection, path: string): string {
  const joined = path.startsWith('/') ? path : `${connection.remoteRoot}/${path}`
  const normalized = posix.normalize(joined)
  const root = posix.normalize(connection.remoteRoot)
  const stripped = normalized.replace(/\/+$/, '')
  // The root itself is valid; every other path must start with `root/` so a
  // sibling like `/root-other` cannot pass the boundary check.
  if (stripped !== root && !stripped.startsWith(`${root}/`)) {
    throw new RemoteError(`path '${path}' escapes remote root '${connection.remoteRoot}'`, 'REMOTE_PERMISSION_DENIED')
  }
  return stripped
}

/**
 * Abstract remote executor. One provider registers `ctx.remote` per composition;
 * every operation takes the fully-explicit {@link RemoteConnection} produced by the
 * consuming tool layer, so provider defaults never sneak into a call. Caller
 * cancellation rides each request's `signal` (the tool passes `exec.signal`).
 */
export abstract class RemoteExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remote')
  }

  /**
   * Run one remote shell command. A non-zero exit is a result, not a failure;
   * the method rejects only for infrastructure failures (connection, host key,
   * auth) or a transfer-limit violation. The returned output is bounded by the
   * provider's per-stream caps.
   * @param connection - resolved connection for this call.
   * @param request - explicit command, cwd, deadline, and environment.
   * @returns exit facts and bounded stdout/stderr.
   */
  abstract run(connection: RemoteConnection, request: RemoteRunRequest): Promise<RemoteRunResult>

  /**
   * Read a bounded line-numbered window of a remote UTF-8 text file.
   * @param connection - resolved connection for this call.
   * @param request - remote path, 1-based offset, and line limit.
   * @returns the window plus total lines and truncation truth.
   */
  abstract readText(connection: RemoteConnection, request: RemoteReadRequest): Promise<RemoteReadResult>

  /**
   * Atomically create or replace a remote UTF-8 text file.
   * @param connection - resolved connection for this call.
   * @param request - remote path and complete new content.
   * @returns the written path and whether it was created.
   */
  abstract writeText(connection: RemoteConnection, request: RemoteWriteRequest): Promise<RemoteWriteResult>

  /**
   * Apply one literal text replacement atomically on a remote file.
   * @param connection - resolved connection for this call.
   * @param request - remote path, old/new literal, and optional replace-all.
   * @returns the edited path and the number of replacements.
   */
  abstract editText(connection: RemoteConnection, request: RemoteEditRequest): Promise<RemoteEditResult>

  /**
   * Stream one local file to a remote destination (SFTP), failing when the
   * destination exists unless `overwrite` is set.
   * @param connection - resolved connection for this call.
   * @param request - local source, remote destination, and overwrite flag.
   * @returns both paths and the transferred byte count.
   */
  abstract push(connection: RemoteConnection, request: RemotePushRequest): Promise<RemoteTransferResult>

  /**
   * Stream one remote file to a local destination, failing when the destination
   * exists unless `overwrite` is set.
   * @param connection - resolved connection for this call.
   * @param request - remote source, local destination, and overwrite flag.
   * @returns both paths and the transferred byte count.
   */
  abstract pull(connection: RemoteConnection, request: RemotePullRequest): Promise<RemoteTransferResult>
}
