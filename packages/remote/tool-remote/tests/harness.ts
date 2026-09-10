/**
 * Shared plumbing for tool-remote unit tests: a real Cordis context with the tool
 * runtime and system-prompt services, a programmable fake RemoteExecutor, and
 * a temporary analysis tree that owns the `.dsh/config.yml` the tools read.
 * @module @deepseek-ai/dsh-tool-remote/tests/harness
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, RemoteExecutor } from '@deepseek-ai/dsh-remote'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
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
} from '@deepseek-ai/dsh-remote'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolSsh from '@deepseek-ai/dsh-tool-remote'

export interface FakeCalls {
  runs: Array<{ connection: RemoteConnection; request: RemoteRunRequest }>
  reads: Array<{ connection: RemoteConnection; request: RemoteReadRequest }>
  writes: Array<{ connection: RemoteConnection; request: RemoteWriteRequest }>
  edits: Array<{ connection: RemoteConnection; request: RemoteEditRequest }>
  pushes: Array<{ connection: RemoteConnection; request: RemotePushRequest }>
  pulls: Array<{ connection: RemoteConnection; request: RemotePullRequest }>
  nextRun: RemoteRunResult
  nextRead: RemoteReadResult
  nextWrite: RemoteWriteResult
  nextEdit: RemoteEditResult
  nextTransfer: RemoteTransferResult
  throwError: unknown
}

function defaultCalls(): FakeCalls {
  return {
    runs: [],
    reads: [],
    writes: [],
    edits: [],
    pushes: [],
    pulls: [],
    nextRun: { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    nextRead: { path: 'f', lines: [], totalLines: 0, truncated: false },
    nextWrite: { path: 'f', created: true },
    nextEdit: { path: 'f', occurrences: 1 },
    nextTransfer: { localPath: 'l', remotePath: 'r', bytes: 0 },
    throwError: undefined,
  }
}

/** A scripted remote executor that records every delegated call. */
export class FakeRemoteExecutor extends RemoteExecutor {
  readonly calls: FakeCalls

  constructor(ctx: Context, calls: FakeCalls) {
    super(ctx)
    this.calls = calls
  }

  private maybe<T>(value: T): Promise<T> {
    if (this.calls.throwError !== undefined) {
      const cause = this.calls.throwError
      return Promise.reject(cause instanceof Error ? cause : new Error(JSON.stringify(cause)))
    }
    return Promise.resolve(value)
  }

  override run(connection: RemoteConnection, request: RemoteRunRequest): Promise<RemoteRunResult> {
    this.calls.runs.push({ connection, request })
    return this.maybe(this.calls.nextRun)
  }

  override readText(connection: RemoteConnection, request: RemoteReadRequest): Promise<RemoteReadResult> {
    this.calls.reads.push({ connection, request })
    return this.maybe(this.calls.nextRead)
  }

  override writeText(connection: RemoteConnection, request: RemoteWriteRequest): Promise<RemoteWriteResult> {
    this.calls.writes.push({ connection, request })
    return this.maybe(this.calls.nextWrite)
  }

  override editText(connection: RemoteConnection, request: RemoteEditRequest): Promise<RemoteEditResult> {
    this.calls.edits.push({ connection, request })
    return this.maybe(this.calls.nextEdit)
  }

  override push(connection: RemoteConnection, request: RemotePushRequest): Promise<RemoteTransferResult> {
    this.calls.pushes.push({ connection, request })
    return this.maybe(this.calls.nextTransfer)
  }

  override pull(connection: RemoteConnection, request: RemotePullRequest): Promise<RemoteTransferResult> {
    this.calls.pulls.push({ connection, request })
    return this.maybe(this.calls.nextTransfer)
  }
}

/** In-memory credentials provider for password-ref config tests. */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      return Promise.reject(new Error('memory credentials: an empty value cannot be stored; use unset'))
    }
    this.store.set(ref, value)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.store.delete(ref)) {
      this.ctx.emit('credentials/reference-updated', ref)
    }
    return Promise.resolve()
  }

  override readRecord(): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override describeRecord(): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  override modifyRecord(): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override deleteRecord(): Promise<void> {
    return Promise.resolve()
  }
}

/** One built tool-remote harness plus its analysis tree. */
export interface Harness {
  ctx: Context
  calls: FakeCalls
  dir: string
  analysisDir: string
  /** Dispatch one tool call with a synthetic session cwd through the registry. */
  call(name: string, args: unknown, cwd?: string): Promise<ToolExecutionResult>
}

/** Build the harness with a memory credentials service seeded with values. */
export async function buildHarnessWithCredentials(seed: Record<string, string>): Promise<Harness> {
  const h = await buildHarness()
  await h.ctx.plugin(MemoryCredentials, seed)
  return h
}

let callCounter = 0

/** Build the harness over a temporary analysis tree. */
export async function buildHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-remote-'))
  const analysisDir = join(dir, 'analyses', 'kk_test')
  await mkdir(join(analysisDir, '.dsh'), { recursive: true })
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const calls = defaultCalls()
  new FakeRemoteExecutor(ctx, calls)
  await ctx.plugin(ToolSsh)
  const call = (name: string, args: unknown, cwd = analysisDir): Promise<ToolExecutionResult> =>
    dispatch(ctx, name, args, cwd)
  return { ctx, calls, dir, analysisDir, call }
}

/** Direct registry dispatch with a synthesized agent session cwd. */
function dispatch(
  ctx: Context,
  name: string,
  args: unknown,
  cwd: string,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `call-${++callCounter}` as never,
    name,
    arguments: args,
    // An empty cwd renders a workspace-less session header (cwd omitted).
    agent: { session: { header: cwd === '' ? {} : { cwd } } } as never,
  })
}

export async function writeAnalysisConfig(analysisDir: string, body: string): Promise<void> {
  await writeFile(join(analysisDir, '.dsh', 'config.yml'), body, 'utf8')
}

export async function teardownHarness(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export {
  RemoteError,
}
