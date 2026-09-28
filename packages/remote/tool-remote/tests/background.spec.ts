/**
 * tool-remote background tests: `remote_exec` with `run_in_background` registers
 * a `ctx.jobs` job when a registry is composed, returns a job id at once, and
 * the output is collectable through the job controls. No real network — the
 * fake executor supplies a controllable detached handle.
 * @module @deepseek-ai/dsh-tool-remote/tests
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolSsh from '@deepseek-ai/dsh-tool-remote'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRemoteExecutor, stubRunHandleDetail, stubSettledHandle } from './harness.ts'
import type { FakeCalls } from './harness.ts'

const CONFIG = `
remote:
  host: compute-1
  port: 2222
  user: phys
  remoteRoot: /home/phys/workspace
  hostKeyFingerprint: pinned-fp
  auth:
    kind: agent
`

function fakeCalls(): FakeCalls {
  return {
    runs: [],
    starts: [],
    reads: [],
    writes: [],
    edits: [],
    pushes: [],
    pulls: [],
    nextRun: { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    nextStart: () => stubRunHandleDetail().handle,
    nextRead: { path: 'f', lines: [], totalLines: 0, truncated: false },
    nextWrite: { path: 'f', created: true },
    nextEdit: { path: 'f', occurrences: 1 },
    nextTransfer: { localPath: 'l', remotePath: 'r', bytes: 0 },
    throwError: undefined,
  }
}

let cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup = []
})

/** Build a context with the jobs registry, model controls, and tool-remote. */
async function setup(): Promise<{ ctx: Context; calls: FakeCalls; analysisDir: string; owner: SessionId }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-remote-bg-'))
  const analysisDir = join(dir, 'analyses', 'kk_test')
  await mkdir(join(analysisDir, '.dsh'), { recursive: true })
  await writeFile(join(analysisDir, '.dsh', 'config.yml'), CONFIG)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // Publish a live owner agent at the session the tool calls report so the
  // job registry's owner-liveness gate passes (its disposal cancels the job).
  const session = SessionId('session-kk_test')
  await ctx.agents.register(stubAgent(session))
  // Mount the registry and controls BEFORE tool-remote so `apply`'s
  // `ctx.get('jobs')` observes it and advertises `run_in_background`.
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
  await ctx.plugin(ToolJobs)
  const calls = fakeCalls()
  new FakeRemoteExecutor(ctx, calls)
  await ctx.plugin(ToolSsh)
  return { ctx, calls, analysisDir, owner: session }
}

function call(ctx: Context, analysisDir: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  return ctx.tools.execute({
    signal: signal ?? new AbortController().signal,
    callId: ToolCallId(`remote-bg-${Math.random()}`),
    name,
    arguments: args,
    agent: { id: 'session-kk_test', session: { header: { cwd: analysisDir } } } as never,
  })
}

/** A minimal live Agent published into the registry for the owner gate. */
function stubAgent(id: string): Agent {
  const ctx = new Context()
  const session = { id, header: {} } as never
  return {
    id: id as never,
    options: {},
    session,
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as never }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Extract the issued job id from a successful background tool result. */
function backgroundJobId(result: ToolExecutionResult): JobId {
  if (result.isError) throw new Error('expected a background result')
  const value = result.value
  if (!isJsonValue(value) || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected a JSON background result')
  }
  const jobId = value['job_id']
  if (value['kind'] !== 'background' || typeof jobId !== 'string') {
    throw new Error('expected a background result')
  }
  return jobId as JobId
}

describe('remote_exec background', () => {
  it('returns a job id immediately instead of blocking foreground', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    const result = await call(ctx, analysisDir, 'remote_exec', {
      command: 'while kill -0 435200 2>/dev/null; do sleep 60; done',
      workdir: '/home/phys/workspace',
      run_in_background: true,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'background' })
    const id = backgroundJobId(result)
    expect(id).toBeTruthy()
    expect(text(result)).toContain('started background job')
    // Detached: the remote `start` was called, not a blocking `run`.
    expect(calls.starts).toHaveLength(1)
    expect(calls.runs).toHaveLength(0)
    expect(ctx.jobs.list(owner).some(job => job.id === id)).toBe(true)
  })

  it('settles the job completed with the remote exit code', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    calls.nextStart = () => stubSettledHandle(3, null)
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'exit 3', run_in_background: true })
    const id = backgroundJobId(result)
    const view = await ctx.jobs.wait(id, 5_000, owner)
    expect(view.status).toBe('completed')
    expect(view.detail).toContain('exit code: 3')
  })

  it('defaults a completed job with an unknown exit code to exit code: 0', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    calls.nextStart = () => stubSettledHandle(null, null)
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'run', run_in_background: true })
    const id = backgroundJobId(result)
    const view = await ctx.jobs.wait(id, 5_000, owner)
    expect(view.status).toBe('completed')
    expect(view.detail).toContain('exit code: 0')
  })

  it('settles a killed detached job via a non-zero signal', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    calls.nextStart = () => stubSettledHandle(null, 'SIGKILL')
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'run', run_in_background: true })
    const id = backgroundJobId(result)
    const view = await ctx.jobs.wait(id, 5_000, owner)
    expect(view.status).toBe('killed')
    expect(view.detail).toContain('signal: SIGKILL')
  })

  it('exposes the background output through the job ring', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    const detail = stubRunHandleDetail()
    detail.stdout.write('partial output')
    calls.nextStart = () => detail.handle
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'run', run_in_background: true })
    const id = backgroundJobId(result)
    // The registry pumps the output source; eventually the text lands in the ring.
    const view = await waitFor(() => ctx.jobs.readAt(id, 0, owner).chunks.map(c => c.text).join(''))
    expect(view).toContain('partial output')
  })

  it('supports killing the background job, which terminates the remote run', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    const detail = stubRunHandleDetail()
    let killed = false
    const handle = detail.handle
    // Wrap kill to observe it fired on the remote handle.
    const observedHandle = {
      ...handle,
      kill: () => { killed = true; detail.handle.kill() },
    }
    calls.nextStart = () => observedHandle
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'sleep 60', run_in_background: true })
    const id = backgroundJobId(result)
    const action = ctx.jobs.kill(id, owner, 'caller kill')
    expect(action).toBe('requested')
    await waitFor(() => killed ? killed : undefined)
    // After kill the remote run's done settles, so the job leaves the running set.
    await waitFor(() => ctx.jobs.list(owner).find(job => job.id === id && job.status !== 'running'))
    expect(killed).toBe(true)
  })

  it('records a failed outcome when the detached start rejects', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    calls.throwError = new Error('spawn failed')
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'run', run_in_background: true })
    const id = backgroundJobId(result)
    const view = await ctx.jobs.wait(id, 5_000, owner)
    expect(view.status).toBe('failed')
    expect(view.detail).toContain('spawn failed')
  })

  it('normalizes a non-Error detached start rejection into a failed outcome', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    calls.nextStartReject = 'raw producer failure'
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'run', run_in_background: true })
    const id = backgroundJobId(result)
    const view = await ctx.jobs.wait(id, 5_000, owner)
    expect(view.status).toBe('failed')
    expect(view.detail).toBe('raw producer failure')
  })

  it('rejects a background call aborted before the job registers', async () => {
    const { ctx, calls, analysisDir } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'run', run_in_background: true }, controller.signal)
    expect(result.isError).toBe(true)
    // The job never registered, so no detached run started.
    expect(calls.starts).toHaveLength(0)
  })

  it('kills a run whose start resolved after the cancel raced it', async () => {
    const { ctx, calls, analysisDir, owner } = await setup()
    const detail = stubRunHandleDetail()
    let killed = false
    const observedHandle = { ...detail.handle, kill: () => { killed = true; detail.handle.kill() } }
    calls.nextStart = () => observedHandle
    // Hold the start promise open so `cancelled` is set before the handle exists.
    let release!: () => void
    calls.startGate = new Promise<void>((resolve) => { release = resolve })
    const result = await call(ctx, analysisDir, 'remote_exec', { command: 'sleep 60', run_in_background: true })
    const id = backgroundJobId(result)
    // Cancel while `ctx.remote.start` is still pending: the cancel callback marks
    // `cancelled` with no live handle, so the race path must kill on assignment.
    const cancel = ctx.jobs.kill(id, owner, 'racer')
    expect(cancel).toBe('requested')
    release()
    await waitFor(() => killed ? killed : undefined)
    await ctx.jobs.wait(id, 5_000, owner)
    expect(killed).toBe(true)
  })
})

/** Poll a reader until it yields a truthy value or times out. */
async function waitFor<T>(read: () => T, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error('condition not reached before timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
