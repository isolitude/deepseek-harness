/**
 * `remote_push` / `remote_pull` — stream one file between the local session
 * workspace and the analysis's remote server over SFTP, atomically.
 * @module @deepseek-ai/dsh-tool-remote/transfer
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-remote'
import { requireConnection } from './connection.ts'
import type { ConnectionLoader } from './connection.ts'

/** Default transfer cap in bytes (the `maxTransferBytes` config). */
export const transferDefaultMaxBytes = 256 * 1024 * 1024

interface TransferOptions {
  connectionLoader: ConnectionLoader
  defaultMaxTransferBytes: number
}

/**
 * Resolve a local-side path against the calling session cwd, without escaping
 * the workspace (mirrors the tool-fs session-cwd posture at the tool boundary).
 */
function resolveLocalPath(cwd: string, path: string): string {
  if (isAbsolute(path)) return path
  return join(cwd, path)
}

/** Register `remote_push`.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader and default transfer cap).
 */
export function applyPushTool(ctx: Context, options: TransferOptions): void {
  ctx.tools.register(defineTool({
    name: 'remote_push',
    description: 'Upload one local file to the remote server (SFTP). Refuses to overwrite an existing remote file unless overwrite is true.',
    parameters: {
      local_path: {
        type: 'string',
        required: true,
        description: 'Local source path, relative to the session workspace.',
      },
      remote_path: {
        type: 'string',
        required: true,
        description: 'Remote destination path; relative paths resolve against the analysis remoteRoot.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing remote file. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          local_path: { type: 'string', required: true },
          remote_path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `uploaded ${value.bytes} bytes to ${value.remote_path}`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new RemoteError('remote_push requires an agent session', 'REMOTE_CONNECT_FAILED')
      }
      const cwd = exec.agent.session.header.cwd
      if (cwd === undefined) {
        throw new RemoteError('remote_push requires a session workspace', 'LOCAL_NOT_FOUND')
      }
      const connection = await requireConnection(ctx, exec.agent.session, options.connectionLoader)
      const result = await ctx.remote.push(connection, {
        localPath: resolveLocalPath(cwd, args.local_path),
        remotePath: args.remote_path,
        ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
        signal: exec.signal,
      })
      return { local_path: args.local_path, remote_path: args.remote_path, bytes: result.bytes }
    },
  }))
}

/** Register `remote_pull`.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader and default transfer cap).
 */
export function applyPullTool(ctx: Context, options: TransferOptions): void {
  ctx.tools.register(defineTool({
    name: 'remote_pull',
    description: 'Download one remote file to the local session workspace (SFTP). Refuses to overwrite an existing local file unless overwrite is true.',
    parameters: {
      remote_path: {
        type: 'string',
        required: true,
        description: 'Remote source path; relative paths resolve against the analysis remoteRoot.',
      },
      local_path: {
        type: 'string',
        required: true,
        description: 'Local destination path, relative to the session workspace.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing local file. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          local_path: { type: 'string', required: true },
          remote_path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `downloaded ${value.bytes} bytes from ${value.remote_path}`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new RemoteError('remote_pull requires an agent session', 'REMOTE_CONNECT_FAILED')
      }
      const cwd = exec.agent.session.header.cwd
      if (cwd === undefined) {
        throw new RemoteError('remote_pull requires a session workspace', 'LOCAL_NOT_FOUND')
      }
      const connection = await requireConnection(ctx, exec.agent.session, options.connectionLoader)
      const result = await ctx.remote.pull(connection, {
        remotePath: args.remote_path,
        localPath: resolveLocalPath(cwd, args.local_path),
        ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
        signal: exec.signal,
      })
      return { local_path: args.local_path, remote_path: args.remote_path, bytes: result.bytes }
    },
  }))
}
