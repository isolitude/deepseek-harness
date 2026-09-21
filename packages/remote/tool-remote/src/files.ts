/**
 * `remote_read` / `remote_write` / `remote_edit` — bounded UTF-8 window reads
 * and atomic mutations on the analysis's remote server.
 * @module @deepseek-ai/dsh-tool-remote/files
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-remote'
import { requireConnection } from './connection.ts'
import type { ConnectionLoader } from './connection.ts'

/** Default and maximum lines returned by one `remote_read` call. */
export const readDefaultLimit = 2000

interface ReadOptions {
  connectionLoader: ConnectionLoader
  defaultLimit: number
}

/** Render one remote read window into line-numbered model text. */
function renderRead(path: string, totalLines: number, truncated: boolean, lines: readonly { number: number; text: string }[]): string {
  const body = lines.map(({ number, text }) => `${number}: ${text}`)
  const footer = truncated
    ? `(Output capped. Showing lines ${lines[0]?.number ?? 1}-${lines.at(-1)?.number ?? 0}. Use offset to continue.)`
    : `(End of file - total ${totalLines} lines)`
  return `<${path}>\n${body.join('\n')}\n${footer}`
}

/** Register `remote_read`.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader and default line limit).
 */
export function applyReadTool(ctx: Context, options: ReadOptions): void {
  ctx.tools.register(defineTool({
    name: 'remote_read',
    description: 'Read a text file on the remote server with line numbers. Use offset and limit to page through large files.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path; relative paths resolve against the analysis remoteRoot.' },
      offset: { type: 'number', description: '1-based first line of the window. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum lines returned. Defaults to and caps at ${readDefaultLimit}.` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
          total_lines: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRead(value.path, value.total_lines, value.truncated, value.lines),
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new RemoteError('remote_read requires an agent session', 'REMOTE_CONNECT_FAILED')
      }
      const connection = await requireConnection(ctx, exec.agent.session, options.connectionLoader)
      const offset = args.offset ?? 1
      const limit = args.limit ?? options.defaultLimit
      if (!Number.isInteger(offset) || offset < 1) {
        throw new RemoteError('invalid offset: expected a positive integer', 'REMOTE_IO_ERROR')
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > options.defaultLimit) {
        throw new RemoteError(`invalid limit: expected an integer between 1 and ${options.defaultLimit}`, 'REMOTE_IO_ERROR')
      }
      const result = await ctx.remote.readText(connection, {
        path: args.path,
        offset,
        limit,
        signal: exec.signal,
      })
      return {
        path: args.path,
        lines: result.lines.map(({ number, text }) => ({ number, text })),
        total_lines: result.totalLines,
        truncated: result.truncated,
      }
    },
  }))
}

interface WriteOptions {
  connectionLoader: ConnectionLoader
}

/** Register `remote_write`.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader).
 */
export function applyWriteTool(ctx: Context, options: WriteOptions): void {
  ctx.tools.register(defineTool({
    name: 'remote_write',
    description: 'Create or fully replace a UTF-8 text file on the remote server. The write is atomic; a failed write leaves no partial file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path; relative paths resolve against the analysis remoteRoot.' },
      content: { type: 'string', required: true, description: 'Complete new file content.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<${value.path}>\n${value.created ? 'Created file' : 'Updated file'}`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new RemoteError('remote_write requires an agent session', 'REMOTE_CONNECT_FAILED')
      }
      const connection = await requireConnection(ctx, exec.agent.session, options.connectionLoader)
      const result = await ctx.remote.writeText(connection, {
        path: args.path,
        content: args.content,
        signal: exec.signal,
      })
      return { path: args.path, created: result.created }
    },
  }))
}

interface EditOptions {
  connectionLoader: ConnectionLoader
}

/** Register `remote_edit`.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader).
 */
export function applyEditTool(ctx: Context, options: EditOptions): void {
  ctx.tools.register(defineTool({
    name: 'remote_edit',
    description: 'Apply one literal text replacement to an existing UTF-8 file on the remote server. '
      + 'By default old_string must appear exactly once; set replace_all to replace every occurrence.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path; relative paths resolve against the analysis remoteRoot.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          occurrences: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `The remote file ${value.path} has been updated (${value.occurrences} occurrence${value.occurrences === 1 ? '' : 's'} replaced).`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new RemoteError('remote_edit requires an agent session', 'REMOTE_CONNECT_FAILED')
      }
      if (args.old_string.length === 0) {
        throw new RemoteError('old_string must be a non-empty string', 'REMOTE_AMBIGUOUS_EDIT')
      }
      if (args.old_string === args.new_string) {
        throw new RemoteError('old_string and new_string must differ', 'REMOTE_AMBIGUOUS_EDIT')
      }
      const connection = await requireConnection(ctx, exec.agent.session, options.connectionLoader)
      const result = await ctx.remote.editText(connection, {
        path: args.path,
        oldString: args.old_string,
        newString: args.new_string,
        ...(args.replace_all !== undefined ? { replaceAll: args.replace_all } : {}),
        signal: exec.signal,
      })
      return { path: args.path, occurrences: result.occurrences }
    },
  }))
}
