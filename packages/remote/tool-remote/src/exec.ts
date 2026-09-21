/**
 * `remote_exec` — run one shell command on the analysis's remote server.
 * @module @deepseek-ai/dsh-tool-remote/exec
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-remote'
import type { RemoteRunResult } from '@deepseek-ai/dsh-remote'
import { requireConnection } from './connection.ts'
import type { ConnectionLoader } from './connection.ts'

/** Default command deadline in milliseconds (the `timeoutMs` config). */
export const execDefaultTimeoutMs = 60_000

interface ExecOptions {
  connectionLoader: ConnectionLoader
  defaultTimeoutMs: number
  defaultWorkdir: string | undefined
}

/** Render exit facts into the canonical result to show the model and the UI. */
function renderRunExit(result: RemoteRunResult): string {
  const lines: string[] = []
  if (result.stdout.length > 0) lines.push(result.stdout.replace(/\n$/, ''))
  if (result.stderr.length > 0) {
    lines.push('[stderr]')
    lines.push(result.stderr.replace(/\n$/, ''))
  }
  if (result.timedOut) lines.push('[timed out]')
  if (result.signal !== null) lines.push(`[killed by signal: ${result.signal}]`)
  lines.push(result.exitCode === null ? '[exit status unknown]' : `[exit code: ${result.exitCode}]`)
  return lines.join('\n')
}

/** Register `remote_exec`.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader, default timeout, default workdir).
 */
export function applyExecTool(ctx: Context, options: ExecOptions): void {
  ctx.tools.register(defineTool({
    name: 'remote_exec',
    description: 'Run a shell command on the remote server configured for this analysis. '
      + 'Returns bounded stdout/stderr and the remote exit code; a non-zero exit is a reported result, not a failure.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The shell command to execute on the remote server.',
      },
      workdir: {
        type: 'string',
        description: 'Remote working directory. Defaults to the analysis remoteRoot.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds. The tool applies its configured default and kills the command on expiry.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }] as const, required: true },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          timed_out: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRunExit({
          exitCode: value.exit_code,
          signal: value.signal ?? null,
          stdout: value.stdout,
          stderr: value.stderr,
          timedOut: value.timed_out,
        }),
      }],
    },
    async execute(args, exec) {
      // exec.agent.session is the calling session; the agent loop always sets it.
      if (exec.agent === undefined) {
        throw new RemoteError('remote_exec requires an agent session', 'REMOTE_CONNECT_FAILED')
      }
      if (!(typeof args.command === 'string' && args.command.length > 0)) {
        throw new RemoteError('invalid command: expected a non-empty string', 'REMOTE_IO_ERROR')
      }
      const connection = await requireConnection(ctx, exec.agent.session, options.connectionLoader)
      const workdir = args.workdir ?? options.defaultWorkdir ?? connection.remoteRoot
      const timeoutMs = args.timeout_ms ?? options.defaultTimeoutMs
      const result = await ctx.remote.run(connection, {
        command: args.command,
        cwd: workdir,
        timeoutMs,
        signal: exec.signal,
      })
      return {
        exit_code: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: result.timedOut,
      }
    },
  }))
}
