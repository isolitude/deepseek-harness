/**
 * `remote_exec` — run one shell command on the analysis's remote server.
 * @module @deepseek-ai/dsh-tool-remote/exec
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-remote'
import type { RemoteConnection, RemoteRunHandle, RemoteRunResult, RemoteRunStream } from '@deepseek-ai/dsh-remote'
import type { JobId, JobOutputSource, JobRegistry, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { requireConnection } from './connection.ts'
import type { ConnectionLoader } from './connection.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    remote: 'remote'
  }
}

/** Default command deadline in milliseconds (the `timeoutMs` config). */
export const execDefaultTimeoutMs = 60_000

interface ExecOptions {
  connectionLoader: ConnectionLoader
  defaultTimeoutMs: number
  defaultWorkdir: string | undefined
}

/** The `remote_exec` call arguments, whether foreground or background. */
interface RemoteExecArgs {
  command: string
  workdir?: string
  timeout_ms?: number
  run_in_background?: boolean
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

/** Project a settled remote run onto the generic job-outcome vocabulary. */
function outcomeOf(result: RemoteRunResult): JobOutcome {
  if (result.signal !== null) return { status: 'killed', detail: `signal: ${result.signal}` }
  return { status: 'completed', detail: `exit code: ${result.exitCode ?? 0}` }
}

/** One job pull source over a remote run stream's retained bytes. */
function sourceOf(stream: () => RemoteRunStream | undefined): JobOutputSource {
  return {
    read: (fromByte) => {
      const live = stream()
      if (live === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      return live.readFrom(fromByte)
    },
  }
}

/** Register `remote_exec` as the tool for one composition state.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader, default timeout, default workdir).
 * @param jobs - the job registry when a background surface is composed, else undefined.
 */
export function applyExecTool(ctx: Context, options: ExecOptions, jobs: JobRegistry | undefined): void {
  ctx.tools.register(remoteExec(ctx, options, jobs))
}

/** One registration of `remote_exec`. With a registry it advertises and
 * enforces `run_in_background`; without one the tool is foreground-only.
 * @param ctx - the tool execution context used to register the tool.
 * @param options - the executor options (connection loader, default timeout, default workdir).
 * @param jobs - the job registry when a background surface is composed, else undefined.
 * @returns the registry-ready tool definition.
 */
export function remoteExec(ctx: Context, options: ExecOptions, jobs: JobRegistry | undefined): ToolDefinition {
  const background = jobs !== undefined
  return defineTool({
    name: 'remote_exec',
    description: 'Run a shell command on the remote server configured for this analysis. '
      + 'Returns bounded stdout/stderr and the remote exit code; a non-zero exit is a reported result, not a failure.'
      + (background
        ? ' Set `run_in_background: true` for long-running commands: the call returns a job id immediately; '
          + 'read its output with `job_output` and stop it with `job_kill`.'
        : ''),
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
      ...background ? {
        run_in_background: {
          type: 'boolean' as const,
          description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              job_id: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'result' },
              exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }] as const, required: true },
              signal: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
              stdout: { type: 'string', required: true },
              stderr: { type: 'string', required: true },
              timed_out: { type: 'boolean', required: true },
            },
          },
        ],
      },
      render: (_args, value) => {
        if (value.kind === 'background') return [{ type: 'text', text: `started background job ${value.job_id}` }]
        return [{
          type: 'text',
          text: renderRunExit({
            exitCode: value.exit_code,
            signal: value.signal ?? null,
            stdout: value.stdout,
            stderr: value.stderr,
            timedOut: value.timed_out,
          }),
        }]
      },
    },
    async execute(args: RemoteExecArgs, exec) {
      // exec.agent.session is the calling session; the agent loop always sets it.
      if (exec.agent === undefined) {
        throw new RemoteError('remote_exec requires an agent session', 'REMOTE_CONNECT_FAILED')
      }
      if (!(typeof args.command === 'string' && args.command.length > 0)) {
        throw new RemoteError('invalid command: expected a non-empty string', 'REMOTE_IO_ERROR')
      }
      const connection = await requireConnection(ctx, exec.agent.session, options.connectionLoader)
      const workdir = args.workdir ?? options.defaultWorkdir ?? connection.remoteRoot
      if (args.run_in_background === true) {
        if (jobs === undefined) {
          throw new RemoteError(
            'background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs',
            'REMOTE_IO_ERROR',
          )
        }
        // Dispatchablility of the abort is governed by the tool registry, which
        // short-circuits a pre-aborted signal before the body and folds a
        // mid-body abort into the returned result; the guard is a last-resort
        // check before registering a job the caller can no longer read.
        /* v8 ignore next 2 -- the registry already routes aborts at dispatch and post-body, so this guard is unreachable in tests. */
        if (exec.signal.aborted) throw new RemoteError('remote_exec aborted', 'REMOTE_ABORTED')
        const jobId = startRemoteJob(ctx, jobs, connection, { command: args.command, cwd: workdir }, exec.agent.id)
        return { kind: 'background' as const, job_id: jobId }
      }
      const result = await ctx.remote.run(connection, {
        command: args.command,
        cwd: workdir,
        timeoutMs: args.timeout_ms ?? options.defaultTimeoutMs,
        signal: exec.signal,
      })
      return {
        kind: 'result' as const,
        exit_code: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: result.timedOut,
      }
    },
  })
}

/** Register the remote command as a background job; the remote run starts
 * inside the job's starter, after the registry admits it, so a rejected
 * admission never leaks a detached process. Returns the issued job id.
 */
function startRemoteJob(
  ctx: Context,
  jobs: JobRegistry,
  connection: RemoteConnection,
  request: { command: string; cwd: string },
  agentId: SessionId,
): JobId {
  // The handle is assigned by `ctx.remote.start` inside the starter; the pull
  // sources and `done` bind lazily over the mutable handle, so reads before the
  // start resolves yield nothing and the pump keeps the model cursor untouched.
  let handle: RemoteRunHandle | undefined
  let cancelled = false
  return jobs.start({
    kind: 'remote',
    label: request.command,
    owner: agentId,
    output: [
      sourceOf(() => handle?.stdout),
      sourceOf(() => handle?.stderr),
    ],
    run: () => ({
      done: (async (): Promise<JobOutcome> => {
        try {
          handle = await ctx.remote.start(connection, request)
          // A cancel that raced the start must still terminate the launched run.
          if (cancelled) handle.kill()
          return outcomeOf(await handle.done)
        } catch (error: unknown) {
          return {
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          }
        }
      })(),
      cancel: () => {
        cancelled = true
        handle?.kill()
      },
    }),
  })
}
