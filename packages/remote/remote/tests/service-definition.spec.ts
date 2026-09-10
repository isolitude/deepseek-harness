/**
 * Service Definition unit tests: path resolution, error taxonomy, and request
 * vocabulary. No I/O — pure contract checks.
 * @module @deepseek-ai/dsh-remote/tests
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { RemoteError, RemoteExecutor, resolveRemotePath } from '@deepseek-ai/dsh-remote'
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

function connection(overrides: Partial<RemoteConnection> = {}): RemoteConnection {
  return {
    id: 'analysis-a',
    host: 'compute-1',
    port: 22,
    user: 'phys',
    auth: { kind: 'key', keyPath: '/keys/id_ed25519' },
    remoteRoot: '/home/phys/workspace',
    connectTimeoutMs: 15_000,
    maxTransferBytes: 256 * 1024 * 1024,
    ...overrides,
  }
}

describe('resolveRemotePath', () => {
  it('keeps absolute paths inside the remote root', () => {
    expect(resolveRemotePath(connection(), '/home/phys/workspace/run/fit.py'))
      .toBe('/home/phys/workspace/run/fit.py')
  })

  it('resolves relative paths against the remote root', () => {
    expect(resolveRemotePath(connection(), 'run/fit.py'))
      .toBe('/home/phys/workspace/run/fit.py')
  })

  it('normalizes a rooted path without duplicating the root', () => {
    expect(resolveRemotePath(connection(), '/home/phys/workspace/'))
      .toBe('/home/phys/workspace')
  })

  it('rejects parent escape above the remote root', () => {
    expect(() => resolveRemotePath(connection(), '../secret'))
      .toThrow(RemoteError)
    try {
      resolveRemotePath(connection(), '../secret')
      expect.unreachable('must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteError)
      expect((err as RemoteError).code).toBe('REMOTE_PERMISSION_DENIED')
    }
  })

  it('rejects an absolute path outside the remote root', () => {
    expect(() => resolveRemotePath(connection(), '/etc/passwd'))
      .toThrow(/escapes remote root/)
  })

  it('treats the root itself as valid', () => {
    expect(resolveRemotePath(connection(), '/home/phys/workspace')).toBe('/home/phys/workspace')
  })
})

describe('RemoteExecutor service registration', () => {
  class Stub extends RemoteExecutor {
    run(_c: RemoteConnection, _r: RemoteRunRequest): Promise<RemoteRunResult> {
      return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    }

    readText(_c: RemoteConnection, _r: RemoteReadRequest): Promise<RemoteReadResult> {
      return Promise.resolve({ path: 'a', lines: [], totalLines: 0, truncated: false })
    }

    writeText(_c: RemoteConnection, _r: RemoteWriteRequest): Promise<RemoteWriteResult> {
      return Promise.resolve({ path: 'a', created: true })
    }

    editText(_c: RemoteConnection, _r: RemoteEditRequest): Promise<RemoteEditResult> {
      return Promise.resolve({ path: 'a', occurrences: 0 })
    }

    push(_c: RemoteConnection, _r: RemotePushRequest): Promise<RemoteTransferResult> {
      return Promise.resolve({ localPath: 'l', remotePath: 'r', bytes: 0 })
    }

    pull(_c: RemoteConnection, _r: RemotePullRequest): Promise<RemoteTransferResult> {
      return Promise.resolve({ localPath: 'l', remotePath: 'r', bytes: 0 })
    }
  }

  it('registers itself as ctx.remote via its constructor', async () => {
    const ctx = new Context()
    new Stub(ctx)
    // The Service base may wrap a callable instance; the name and dispatch
    // surface are what consumers observe.
    expect(ctx.remote.name).toBe('remote')
    await expect(ctx.remote.run(connection(), { command: 'ls', cwd: '/', timeoutMs: 1 }))
      .resolves.toMatchObject({ exitCode: 0 })
  })
})

describe('RemoteError taxonomy', () => {
  it('carries an opaque stable code', () => {
    const err = new RemoteError('boom', 'REMOTE_ABORTED')
    expect(err.code).toBe('REMOTE_ABORTED')
    expect(err.message).toBe('boom')
    expect(err.name).toBe('RemoteError')
  })

  it('preserves the cause for diagnostics', () => {
    const cause = new Error('tcp reset')
    const err = new RemoteError('unreachable', 'REMOTE_CONNECT_FAILED', { cause })
    expect(err.cause).toBe(cause)
  })
})
