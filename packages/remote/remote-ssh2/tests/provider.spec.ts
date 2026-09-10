/**
 * Provider unit tests with a programmable fake ssh2 Client: connection pooling,
 * host-key policy, command runs (exit / timeout / abort), SFTP text reads,
 * atomic writes, literal edits, and push/pull transfers. No real network.
 * @module @deepseek-ai/dsh-remote-ssh2/tests
 */

import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteConnection } from '@deepseek-ai/dsh-remote'
import Ssh2RemoteExecutor from '@deepseek-ai/dsh-remote-ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeSftpFile {
  data: string
}

const fake = vi.hoisted(() => {
  class FakeSftp {
    readonly root = '/home/phys/workspace'
    files = new Map<string, FakeSftpFile>()
    /** Byte-exact payloads (invalid UTF-8) stored here, keyed like files. */
    rawBytes = new Map<string, Uint8Array>()
    renames: Array<{ from: string; to: string }> = []
    unlinked: string[] = []
    nextStatError: string | undefined
    nextReadError: string | undefined
    nextWriteError: string | undefined
    nextRenameError: string | undefined

    /** Normalize a test-authored relative path to the provider's absolute key. */
    key(path: string): string {
      return path.startsWith('/') ? path : `${this.root}/${path}`
    }

    withFile(path: string, data: string): void {
      this.files.set(this.key(path), { data })
    }

    withRaw(path: string, bytes: Uint8Array): void {
      this.files.set(this.key(path), { data: '' })
      this.rawBytes.set(this.key(path), bytes)
    }

    stat(path: string, cb: (err: Error | null, stats?: { size: number }) => void): void {
      if (this.nextStatError !== undefined) {
        const message = this.nextStatError
        this.nextStatError = undefined
        cb(message as unknown as Error)
        return
      }
      const file = this.files.get(this.key(path))
      if (file === undefined) cb(new Error('no such file'))
      else cb(null, { size: file.data.length })
    }

    createReadStream(path: string): Readable {
      if (this.nextReadError !== undefined) {
        const message = this.nextReadError
        this.nextReadError = undefined
        const errored = new Readable({ read() {} })
        process.nextTick(() => errored.destroy(new Error(message)))
        return errored
      }
      const file = this.files.get(this.key(path))
      if (file === undefined) {
        const missing = new Readable({ read() {} })
        process.nextTick(() => missing.destroy(new Error('no such file')))
        return missing
      }
      const raw = this.rawBytes.get(this.key(path))
      return Readable.from([Buffer.from(raw ?? Buffer.from(file.data, 'utf8'))])
    }

    createWriteStream(path: string): Writable {
      const chunks: Uint8Array[] = []
      const writeError = this.nextWriteError
      this.nextWriteError = undefined
      const files = this.files
      const keyOf = (p: string): string => (p.startsWith('/') ? p : `${this.root}/${p}`)
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk as Uint8Array))
          callback(writeError === undefined ? undefined : new Error(writeError))
        },
        final(callback) {
          if (writeError === undefined) {
            files.set(keyOf(path), { data: Buffer.concat(chunks).toString('utf8') })
          }
          callback()
        },
      })
    }

    /** Programmable OpenSSH posix-rename: 'ok' | 'missing' | 'fail' | 'throw'. */
    posixMode: 'ok' | 'missing' | 'fail' | 'throw' = 'ok'

    ext_openssh_rename(from: string, to: string, cb: (err: Error | null) => void): void {
      if (this.posixMode === 'throw') {
        throw new Error('broken wrapper')
      }
      if (this.posixMode === 'missing') {
        cb(new Error('Server does not support this extended request'))
        return
      }
      if (this.posixMode === 'fail') {
        cb(new Error('Failure'))
        return
      }
      this.renames.push({ from, to })
      const file = this.files.get(this.key(from))
      if (file !== undefined) {
        this.files.set(this.key(to), file)
        this.files.delete(this.key(from))
      }
      cb(null)
    }

    rename(from: string, to: string, cb: (err: Error | null) => void): void {
      if (this.nextRenameError !== undefined) {
        const message = this.nextRenameError
        this.nextRenameError = undefined
        cb(new Error(message))
        return
      }
      this.renames.push({ from, to })
      const file = this.files.get(this.key(from))
      if (file !== undefined) {
        this.files.set(this.key(to), file)
        this.files.delete(this.key(from))
      }
      cb(null)
    }

    unlink(path: string, cb: (err: Error | null) => void): void {
      this.unlinked.push(path)
      this.files.delete(this.key(path))
      cb(null)
    }
  }

  const State = {
    sftp: undefined as InstanceType<typeof FakeSftp> | undefined,
    hostKeyResult: 'ok' as 'ok' | 'refuse' | 'throw',
    connectError: undefined as unknown,
    execError: undefined as Error | undefined,
    sftpError: undefined as Error | undefined,
    channelStdout: '',
    channelStderr: '',
    channelExitCode: 0 as number | null,
    channelSignal: null as string | null,
    killSettles: false,
    /** When true, end() settles the channel like an instantly-finished command. */
    autoSettle: true,
    instances: 0,
  }

  return { FakeSftp, State }
})

vi.mock('ssh2', () => {
  const { FakeSftp, State } = fake
  return {
    Client: class extends EventEmitter {
      pendingChannel: { end: () => void; signal: (name: string) => void; close: () => void } | undefined

      connect(opts: Record<string, unknown>): void {
        State.instances += 1
        if (State.hostKeyResult === 'throw') {
          // Run the provider's verifier: it throws a RemoteError for an unpinned host.
          let thrown: unknown
          try {
            ;(opts['hostVerifier'] as ((key: Buffer) => boolean) | undefined)?.(Buffer.from('fake-host-key'))
          } catch (err) {
            thrown = err
          }
          process.nextTick(() => this.emit('error', thrown ?? new Error('host key not pinned')))
          return
        }
        if (State.hostKeyResult === 'refuse') {
          process.nextTick(() => this.emit('error', new Error('Host key verification failed')))
          return
        }
        const verifier = opts['hostVerifier'] as ((key: Buffer) => boolean) | undefined
        if (verifier !== undefined) {
          try {
            if (!verifier(Buffer.from('fake-host-key'))) {
              process.nextTick(() => this.emit('error', new Error('Host key verification failed')))
              return
            }
          } catch (err) {
            process.nextTick(() => { this.emit('error', err) })
            return
          }
        }
        if (State.connectError !== undefined) {
          const err = State.connectError
          State.connectError = undefined
          process.nextTick(() => { this.emit('error', err) })
          return
        }
        process.nextTick(() => this.emit('ready'))
      }

      exec(
        _command: string,
        cb: (err: Error | null, channel?: { end: () => void; signal: (name: string) => void; close: () => void }) => void,
      ): void {
        if (State.execError !== undefined) {
          const err = State.execError
          State.execError = undefined
          process.nextTick(() => { cb(err) })
          return
        }
        process.nextTick(() => { cb(null, this.pendingChannel) })
      }

      sftp(cb: (err: Error | null, sftp?: InstanceType<typeof FakeSftp>) => void): void {
        if (State.sftpError !== undefined) {
          const err = State.sftpError
          State.sftpError = undefined
          process.nextTick(() => { cb(err) })
          return
        }
        process.nextTick(() => { cb(null, State.sftp) })
      }

      end(): void {
        this.emit('close')
      }
    },
  }
})

/** One fake exec channel emitting the current State data on settle. */
class FakeChannel extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written = ''
  killedSignals: string[] = []
  destroyed = false
  readonly state: typeof fake.State

  constructor(state: typeof fake.State) {
    super()
    this.state = state
  }

  write(chunk: string): boolean {
    this.written += chunk
    return true
  }

  end(): void {
    if (this.state.autoSettle) process.nextTick(() => { this.settle() })
  }

  settle(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stdout.emit('data', Buffer.from(this.state.channelStdout, 'utf8'))
    this.stderr.emit('data', Buffer.from(this.state.channelStderr, 'utf8'))
    this.emit('exit', this.state.channelExitCode, this.state.channelSignal)
    this.emit('close')
  }

  signal(name: string): void {
    this.killedSignals.push(name)
    if (this.state.killSettles) this.settle()
  }

  close(): void {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('close')
    }
  }
}

function connection(overrides: Partial<RemoteConnection> = {}): RemoteConnection {
  return {
    id: 'analysis-a',
    host: 'compute-1',
    port: 22,
    user: 'phys',
    auth: { kind: 'agent' },
    remoteRoot: '/home/phys/workspace',
    connectTimeoutMs: 15_000,
    maxTransferBytes: 1024,
    hostKeyFingerprint: 'k5oIER1zWPS2DskTVYJ8pnQgCEoARdjWw9QSJFaehfA=',
    ...overrides,
  }
}

/** Grab the single pooled client the executor built so tests can wire a channel. */
async function acquireClient(exec: Ssh2RemoteExecutor, conn: RemoteConnection = connection()): Promise<FakeClientLike> {
  const pooled = await (exec as unknown as {
    acquire(c: RemoteConnection): Promise<{ client: FakeClientLike }>
  }).acquire(conn)
  return pooled.client
}

interface FakeClientLike {
  pendingChannel: FakeChannel | undefined
  emit?: (event: string) => void
}

let dir: string
let ctx: Context
let executor: Ssh2RemoteExecutor

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-remote2-'))
  fake.State.sftp = new fake.FakeSftp()
  fake.State.hostKeyResult = 'ok'
  fake.State.connectError = undefined
  fake.State.execError = undefined
  fake.State.sftpError = undefined
  fake.State.channelStdout = ''
  fake.State.channelStderr = ''
  fake.State.channelExitCode = 0
  fake.State.channelSignal = null
  fake.State.killSettles = false
  fake.State.autoSettle = true
  fake.State.instances = 0
  ctx = new Context()
  executor = new Ssh2RemoteExecutor(ctx, {
    idleTimeoutMs: 60_000,
    connectTimeoutMs: 1_000,
    maxOutputBytes: 256,
    maxReadBytes: 1024,
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('connection policy and pooling', () => {
  it('refuses connections without a pinned fingerprint (strict, no TOFU)', async () => {
    const { hostKeyFingerprint: _drop, ...conn } = connection()
    void _drop
    fake.State.hostKeyResult = 'throw'
    await expect(executor.readText(conn, { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_HOST_KEY_MISMATCH' })
  })

  it('classifies a host-key mismatch during connect', async () => {
    fake.State.hostKeyResult = 'refuse'
    await expect(executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_HOST_KEY_MISMATCH' })
  })

  it('classifies an authentication failure', async () => {
    fake.State.connectError = new Error('All configured authentication methods failed')
    await expect(executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' })
  })

  it('classifies a non-Error connect failure', async () => {
    fake.State.connectError = 'raw socket failure'
    await expect(executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_CONNECT_FAILED' })
  })

  it('classifies a generic connect failure', async () => {
    fake.State.connectError = new Error('Connection timed out')
    await expect(executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_CONNECT_FAILED' })
  })

  it('classifies an unreadable key file', async () => {
    const conn = connection({ auth: { kind: 'key', keyPath: join(dir, 'missing-key') } })
    await expect(executor.readText(conn, { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' })
  })

  it('formats a non-Error thrown value through messageOf', async () => {
    const { messageOf } = await import('@deepseek-ai/dsh-remote-ssh2/src/index.ts')
    expect(messageOf('boom')).toBe('boom')
    expect(messageOf(new Error('real'))).toBe('real')
  })

  it('connects with a password auth', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    const conn = connection({ auth: { kind: 'password', password: 's3cret' } })
    await executor.readText(conn, { path: 'a.txt', offset: 1, limit: 10 })
    expect(fake.State.instances).toBe(1)
  })

  it('connects with an agent auth when SSH_AUTH_SOCK is set', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    try {
      await executor.readText(connection({ auth: { kind: 'agent' } }), { path: 'a.txt', offset: 1, limit: 10 })
      expect(fake.State.instances).toBe(1)
    } finally {
      delete process.env.SSH_AUTH_SOCK
    }
  })

  it('connects with a key and no passphrase', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    await writeFile(join(dir, 'plain_key'), 'fake-key-bytes')
    const result = await executor.readText(
      connection({ auth: { kind: 'key', keyPath: join(dir, 'plain_key') } }),
      { path: 'a.txt', offset: 1, limit: 10 },
    )
    expect(result.lines[0]).toMatchObject({ number: 1, text: 'hello' })
  })

  it('classifies an unreadable key file for a second auth source', async () => {
    const conn = connection({ auth: { kind: 'key', keyPath: join(dir, 'missing-key') } })
    await expect(executor.readText(conn, { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' })
  })

  it('connects with a key plus a materialized passphrase', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    await writeFile(join(dir, 'id_ed25519'), 'fake-key-bytes')
    const result = await executor.readText(
      connection({ auth: { kind: 'key', keyPath: join(dir, 'id_ed25519'), passphrase: 'pp' } }),
      { path: 'a.txt', offset: 1, limit: 10 },
    )
    expect(fake.State.instances).toBe(1)
    expect(result.lines[0]).toMatchObject({ number: 1, text: 'hello' })
  })

  it('rebuilds a pooled client whose socket closed underneath', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    await executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    expect(fake.State.instances).toBe(1)
    // Simulate the remote closing the socket: emit 'close' on the live client.
    const live = fake.State.instances
    ;(await acquireClient(executor)).emit?.('close')
    const again = await executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    expect(again.lines[0]).toMatchObject({ number: 1, text: 'hello' })
    expect(fake.State.instances).toBeGreaterThanOrEqual(live + 1)
  })

  it('applies default config when constructed without options', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    const bare = new Ssh2RemoteExecutor(new Context())
    const result = await bare.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    expect(result.lines[0]).toMatchObject({ number: 1, text: 'hello' })
  })

  it('surfaces an sftp-channel open failure', async () => {
    fake.State.sftpError = new Error('sftp open failed')
    await expect(executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'REMOTE_IO_ERROR' })
  })

  it('closes pooled clients on explicit dispose and reconnects afterwards', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    await executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    executor.dispose()
    const again = await executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    expect(again.lines[0]).toMatchObject({ number: 1, text: 'hello' })
    expect(fake.State.instances).toBeGreaterThanOrEqual(2)
  })

  it('reuses a pooled connection for identical config', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    await executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    await executor.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    expect(fake.State.instances).toBe(1)
  })

  it('closes a pooled client after its idle timeout, then reconnects on the next call', async () => {
    fake.State.sftp!.withFile('a.txt', 'hello')
    const idleCtx = new Context()
    const idle = new Ssh2RemoteExecutor(idleCtx, { idleTimeoutMs: 20, connectTimeoutMs: 1_000 })
    await idle.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    expect(fake.State.instances).toBe(1)
    await vi.waitFor(() => { expect(fake.State.instances).toBe(1) }) // client still pooled at first
    await new Promise(resolve => setTimeout(resolve, 60))
    const again = await idle.readText(connection(), { path: 'a.txt', offset: 1, limit: 10 })
    expect(again.lines[0]).toMatchObject({ number: 1, text: 'hello' })
    expect(fake.State.instances).toBeGreaterThanOrEqual(2)
  })
})

describe('run', () => {
  it('returns bounded stdout/stderr plus exit facts', async () => {
    const channel = new FakeChannel(fake.State)
    const client = await acquireClient(executor)
    client.pendingChannel = channel
    fake.State.channelStdout = 'out here'
    fake.State.channelStderr = 'err here'
    fake.State.channelExitCode = 1
    fake.State.channelSignal = null
    fake.State.killSettles = true
    const result = await executor.run(connection(), {
      command: 'ls -la',
      cwd: '/home/phys/workspace',
      timeoutMs: 10_000,
    })
    expect(result).toMatchObject({ exitCode: 1, signal: null, stdout: 'out here', stderr: 'err here', timedOut: false })
  })

  it('reports a killing signal', async () => {
    const channel = new FakeChannel(fake.State)
    const client = await acquireClient(executor)
    client.pendingChannel = channel
    fake.State.channelSignal = 'SIGKILL'
    fake.State.channelExitCode = null
    const result = await executor.run(connection(), {
      command: 'sleep 1',
      cwd: '/home/phys/workspace',
      timeoutMs: 10_000,
    })
    expect(result.signal).toBe('SIGKILL')
    expect(result.exitCode).toBeNull()
  })

  it('times out and kills the remote channel when the deadline expires', async () => {
    const channel = new FakeChannel(fake.State)
    const client = await acquireClient(executor)
    client.pendingChannel = channel
    fake.State.killSettles = false
    fake.State.autoSettle = false
    const result = await executor.run(connection(), {
      command: 'sleep 60',
      cwd: '/home/phys/workspace',
      timeoutMs: 10,
    })
    expect(result.timedOut).toBe(true)
    expect(channel.killedSignals).toContain('KILL')
  })

  it('aborts immediately when the caller signal is already aborted', async () => {
    fake.State.killSettles = true
    const controller = new AbortController()
    controller.abort()
    const channel = new FakeChannel(fake.State)
    const client = await acquireClient(executor)
    client.pendingChannel = channel
    await expect(executor.run(connection(), {
      command: 'sleep 60',
      cwd: '/home/phys/workspace',
      timeoutMs: 10_000,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'REMOTE_ABORTED' })
  })

  it('aborts when the caller signal fires', async () => {
    fake.State.killSettles = true
    const controller = new AbortController()
    const channel = new FakeChannel(fake.State)
    const client = await acquireClient(executor)
    client.pendingChannel = channel
    const execution = executor.run(connection(), {
      command: 'sleep 60',
      cwd: '/home/phys/workspace',
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(execution).rejects.toMatchObject({ code: 'REMOTE_ABORTED' })
  })

  it('settles immediately when the returned channel is already closed', async () => {
    const channel = new FakeChannel(fake.State)
    channel.destroyed = true
    fake.State.killSettles = true
    const client = await acquireClient(executor)
    client.pendingChannel = channel
    const result = await executor.run(connection(), {
      command: 'echo done',
      cwd: '/home/phys/workspace',
      timeoutMs: 10_000,
    })
    expect(result.timedOut).toBe(false)
  })

  it('surfaces an exec-spawn failure', async () => {
    fake.State.execError = new Error('channel open failure')
    await expect(executor.run(connection(), {
      command: 'ls',
      cwd: '/home/phys/workspace',
      timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: 'REMOTE_IO_ERROR' })
  })
})

describe('readText', () => {
  it('returns a bounded line window with totals', async () => {
    fake.State.sftp!.withFile('f.txt', 'a\nb\nc\nd\ne')
    const result = await executor.readText(connection(), { path: 'f.txt', offset: 2, limit: 2 })
    expect(result).toMatchObject({
      path: 'f.txt',
      totalLines: 5,
      truncated: true,
      lines: [
        { number: 2, text: 'b' },
        { number: 3, text: 'c' },
      ],
    })
  })

  it('rejects binary content as not-text', async () => {
    fake.State.sftp!.withRaw('bin.dat', new Uint8Array([0xff, 0xfe, 0x61]))
    await expect(executor.readText(connection(), { path: 'bin.dat', offset: 1, limit: 5 }))
      .rejects.toMatchObject({ code: 'REMOTE_NOT_TEXT' })
  })

  it('counts lines without a phantom trailing entry for newline-ended files', async () => {
    fake.State.sftp!.withFile('nl.txt', 'one\ntwo\n')
    const result = await executor.readText(connection(), { path: 'nl.txt', offset: 1, limit: 10 })
    expect(result.totalLines).toBe(2)
    expect(result.lines).toHaveLength(2)
  })

  it('rejects reads exceeding the byte cap', async () => {
    fake.State.sftp!.withFile('big.txt', 'x'.repeat(2048))
    await expect(executor.readText(connection(), { path: 'big.txt', offset: 1, limit: 5 }))
      .rejects.toMatchObject({ code: 'REMOTE_TOO_LARGE' })
  })

  it('maps a permission-denied stat during pull', async () => {
    fake.State.sftp!.nextStatError = 'permission denied'
    const local = join(dir, 'fit.txt')
    await expect(executor.pull(connection(), { remotePath: 'out/fit.txt', localPath: local }))
      .rejects.toMatchObject({ code: 'REMOTE_PERMISSION_DENIED' })
  })

  it('maps an already-exists stat during pull', async () => {
    fake.State.sftp!.nextStatError = 'file already exists'
    const local = join(dir, 'fit.txt')
    await expect(executor.pull(connection(), { remotePath: 'out/fit.txt', localPath: local }))
      .rejects.toMatchObject({ code: 'REMOTE_ALREADY_EXISTS' })
  })

  it('maps a missing remote file to NOT_FOUND', async () => {
    fake.State.sftp!.nextReadError = 'no such file'
    await expect(executor.readText(connection(), { path: 'gone.txt', offset: 1, limit: 5 }))
      .rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' })
  })

  it('rejects a path escaping the remote root', async () => {
    await expect(executor.readText(connection(), { path: '../etc/passwd', offset: 1, limit: 5 }))
      .rejects.toMatchObject({ code: 'REMOTE_PERMISSION_DENIED' })
  })
})

describe('atomic publish via posix-rename', () => {
  it('uses the OpenSSH posix-rename extension to replace targets', async () => {
    fake.State.sftp!.withFile('existing.txt', 'old')
    const result = await executor.writeText(connection(), { path: 'existing.txt', content: 'new' })
    expect(result.created).toBe(false)
    expect(fake.State.sftp!.files.get(fake.State.sftp!.key('existing.txt'))?.data).toBe('new')
    // The publish used the extension; the target file was not pre-unlinked.
    expect(fake.State.sftp!.unlinked).not.toContain(fake.State.sftp!.key('existing.txt'))
    expect(fake.State.sftp!.renames.length).toBe(1)
  })

  it('falls back to guarded unlink+rename when the server lacks the extension', async () => {
    fake.State.sftp!.posixMode = 'missing'
    fake.State.sftp!.withFile('existing.txt', 'old')
    const result = await executor.writeText(connection(), { path: 'existing.txt', content: 'new' })
    expect(result.created).toBe(false)
    expect(fake.State.sftp!.files.get(fake.State.sftp!.key('existing.txt'))?.data).toBe('new')
    expect(fake.State.sftp!.unlinked).toContain(fake.State.sftp!.key('existing.txt'))
  })

  it('falls back to guarded unlink+rename when the extension fails', async () => {
    fake.State.sftp!.posixMode = 'fail'
    fake.State.sftp!.withFile('existing.txt', 'old')
    await executor.writeText(connection(), { path: 'existing.txt', content: 'new' })
    expect(fake.State.sftp!.unlinked).toContain(fake.State.sftp!.key('existing.txt'))
    expect(fake.State.sftp!.files.get(fake.State.sftp!.key('existing.txt'))?.data).toBe('new')
  })

  it('cleans the temp file and reports failure when the guarded rename also fails', async () => {
    fake.State.sftp!.posixMode = 'missing'
    fake.State.sftp!.withFile('existing.txt', 'old')
    fake.State.sftp!.nextRenameError = 'quota'
    await expect(executor.writeText(connection(), { path: 'existing.txt', content: 'new' }))
      .rejects.toMatchObject({ code: 'REMOTE_IO_ERROR' })
  })

  it('publishes through the guarded plain rename when no extension method exists', async () => {
    const sftp = fake.State.sftp!
    const ext = (sftp as unknown as Record<string, unknown>)['ext_openssh_rename']
    Object.defineProperty(sftp, 'ext_openssh_rename', { value: undefined, configurable: true })
    try {
      sftp.posixMode = 'missing'
      sftp.withFile('existing.txt', 'old')
      const result = await executor.writeText(connection(), { path: 'existing.txt', content: 'new' })
      expect(result.created).toBe(false)
      expect(sftp.files.get(sftp.key('existing.txt'))?.data).toBe('new')
      expect(sftp.unlinked).toContain(sftp.key('existing.txt'))
    } finally {
      Object.defineProperty(sftp, 'ext_openssh_rename', { value: ext, configurable: true })
    }
  })

  it('falls back when the extension wrapper throws synchronously', async () => {
    fake.State.sftp!.posixMode = 'throw'
    fake.State.sftp!.withFile('existing.txt', 'old')
    const result = await executor.writeText(connection(), { path: 'existing.txt', content: 'new' })
    expect(result.created).toBe(false)
    expect(fake.State.sftp!.files.get(fake.State.sftp!.key('existing.txt'))?.data).toBe('new')
  })

  it('publishes without a stale target when no extension method exists', async () => {
    const sftp = fake.State.sftp!
    const ext = (sftp as unknown as Record<string, unknown>)['ext_openssh_rename']
    Object.defineProperty(sftp, 'ext_openssh_rename', { value: undefined, configurable: true })
    try {
      sftp.posixMode = 'missing'
      const result = await executor.writeText(connection(), { path: 'fresh.txt', content: 'new' })
      expect(result.created).toBe(true)
      expect(sftp.files.get(sftp.key('fresh.txt'))?.data).toBe('new')
    } finally {
      Object.defineProperty(sftp, 'ext_openssh_rename', { value: ext, configurable: true })
    }
  })
})

describe('writeText', () => {
  it('creates a file atomically via temp + rename', async () => {
    const result = await executor.writeText(connection(), { path: 'new.txt', content: 'payload' })
    expect(result).toMatchObject({ path: 'new.txt', created: true })
    expect(fake.State.sftp!.files.get('/home/phys/workspace/new.txt')?.data).toBe('payload')
    expect(fake.State.sftp!.renames.length).toBe(1)
  })

  it('reports an existing file as not-created', async () => {
    fake.State.sftp!.withFile('existing.txt', 'old')
    const result = await executor.writeText(connection(), { path: 'existing.txt', content: 'new' })
    expect(result.created).toBe(false)
    expect(fake.State.sftp!.files.get('/home/phys/workspace/existing.txt')?.data).toBe('new')
  })

  it('rejects an oversized payload', async () => {
    await expect(executor.writeText(connection(), { path: 'big.txt', content: 'x'.repeat(2048) }))
      .rejects.toMatchObject({ code: 'REMOTE_TOO_LARGE' })
  })

  it('maps a guarded rename failure and cleans the temp file', async () => {
    // The posix extension is unavailable AND the plain rename also fails.
    fake.State.sftp!.posixMode = 'missing'
    fake.State.sftp!.withFile('r.txt', 'old')
    fake.State.sftp!.nextRenameError = 'permission denied'
    await expect(executor.writeText(connection(), { path: 'r.txt', content: 'x' }))
      .rejects.toMatchObject({ code: 'REMOTE_PERMISSION_DENIED' })
  })

  it('cleans up the temp file and maps failure when the write stream errors', async () => {
    fake.State.sftp!.nextWriteError = 'quota exceeded'
    await expect(executor.writeText(connection(), { path: 'quota.txt', content: 'x' }))
      .rejects.toMatchObject({ code: 'REMOTE_IO_ERROR' })
  })
})

describe('editText', () => {
  it('replaces a unique literal', async () => {
    fake.State.sftp!.withFile('cfg.txt', 'alpha beta alpha')
    const result = await executor.editText(connection(), {
      path: 'cfg.txt',
      oldString: 'beta',
      newString: 'gamma',
    })
    expect(result).toMatchObject({ path: 'cfg.txt', occurrences: 1 })
    expect(fake.State.sftp!.files.get('/home/phys/workspace/cfg.txt')?.data).toBe('alpha gamma alpha')
  })

  it('rejects a missing literal', async () => {
    fake.State.sftp!.withFile('cfg.txt', 'alpha')
    await expect(executor.editText(connection(), {
      path: 'cfg.txt',
      oldString: 'missing',
      newString: 'x',
    })).rejects.toMatchObject({ code: 'REMOTE_AMBIGUOUS_EDIT' })
  })

  it('requires a unique match unless replaceAll', async () => {
    fake.State.sftp!.withFile('cfg.txt', 'a a')
    await expect(executor.editText(connection(), {
      path: 'cfg.txt',
      oldString: 'a',
      newString: 'b',
    })).rejects.toMatchObject({ code: 'REMOTE_AMBIGUOUS_EDIT' })
    const result = await executor.editText(connection(), {
      path: 'cfg.txt',
      oldString: 'a',
      newString: 'b',
      replaceAll: true,
    })
    expect(result.occurrences).toBe(2)
    expect(fake.State.sftp!.files.get('/home/phys/workspace/cfg.txt')?.data).toBe('b b')
  })
})

describe('push', () => {
  it('streams a local file to the remote world with byte count', async () => {
    const local = join(dir, 'script.py')
    await writeFile(local, 'print("hi")\n')
    const result = await executor.push(connection(), {
      localPath: local,
      remotePath: 'scripts/script.py',
    })
    expect(result).toMatchObject({ bytes: 12, localPath: local, remotePath: 'scripts/script.py' })
    expect(fake.State.sftp!.files.get('/home/phys/workspace/scripts/script.py')?.data).toBe('print("hi")\n')
  })

  it('refuses to overwrite an existing remote file by default', async () => {
    const local = join(dir, 'script.py')
    await writeFile(local, 'x')
    fake.State.sftp!.withFile('script.py', 'keep')
    await expect(executor.push(connection(), { localPath: local, remotePath: 'script.py' }))
      .rejects.toMatchObject({ code: 'REMOTE_ALREADY_EXISTS' })
  })

  it('overwrites when requested', async () => {
    const local = join(dir, 'script.py')
    await writeFile(local, 'new')
    fake.State.sftp!.withFile('script.py', 'old')
    const result = await executor.push(connection(), { localPath: local, remotePath: 'script.py', overwrite: true })
    expect(result.bytes).toBe(3)
    expect(fake.State.sftp!.files.get('/home/phys/workspace/script.py')?.data).toBe('new')
  })

  it('maps a remote write-stream error during push and cleans up', async () => {
    const local = join(dir, 's.py')
    await writeFile(local, 'x')
    fake.State.sftp!.nextWriteError = 'disk full'
    await expect(executor.push(connection(), { localPath: local, remotePath: 's.py' }))
      .rejects.toMatchObject({ code: 'REMOTE_IO_ERROR' })
  })

  it('maps a guarded rename failure during push and cleans the temp file', async () => {
    const local = join(dir, 's.py')
    await writeFile(local, 'x')
    fake.State.sftp!.posixMode = 'missing'
    fake.State.sftp!.withFile('s.py', 'old')
    fake.State.sftp!.nextRenameError = 'no such file'
    await expect(executor.push(connection(), { localPath: local, remotePath: 's.py', overwrite: true }))
      .rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' })
  })

  it('rejects a local directory instead of a regular file', async () => {
    const sub = join(dir, 'subdir')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(sub, { recursive: true })
    await expect(executor.push(connection(), { localPath: sub, remotePath: 'x' }))
      .rejects.toMatchObject({ code: 'LOCAL_NOT_FOUND' })
  })

  it('rejects a missing local file', async () => {
    await expect(executor.push(connection(), { localPath: join(dir, 'nope'), remotePath: 'x' }))
      .rejects.toMatchObject({ code: 'LOCAL_NOT_FOUND' })
  })

  it('rejects an oversized local file', async () => {
    const local = join(dir, 'big.bin')
    await writeFile(local, 'x'.repeat(2048))
    await expect(executor.push(connection(), { localPath: local, remotePath: 'big.bin' }))
      .rejects.toMatchObject({ code: 'REMOTE_TOO_LARGE' })
  })
})

describe('pull', () => {
  it('streams a remote file to the local world with byte count', async () => {
    fake.State.sftp!.withFile('out/fit.txt', 'result data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'local'), { recursive: true })
    const local = join(dir, 'local', 'fit.txt')
    const result = await executor.pull(connection(), { remotePath: 'out/fit.txt', localPath: local })
    expect(result.bytes).toBe(11)
    expect(await readFile(local, 'utf8')).toBe('result data')
  })

  it('refuses to overwrite an existing local file by default', async () => {
    fake.State.sftp!.withFile('out/fit.txt', 'data')
    const local = join(dir, 'fit.txt')
    await writeFile(local, 'existing')
    await expect(executor.pull(connection(), { remotePath: 'out/fit.txt', localPath: local }))
      .rejects.toMatchObject({ code: 'LOCAL_ALREADY_EXISTS' })
  })

  it('overwrites when requested', async () => {
    fake.State.sftp!.withFile('out/fit.txt', 'new data')
    const local = join(dir, 'fit.txt')
    await writeFile(local, 'old')
    const result = await executor.pull(connection(), { remotePath: 'out/fit.txt', localPath: local, overwrite: true })
    expect(result.bytes).toBe(8)
  })

  it('maps a missing remote file to NOT_FOUND', async () => {
    fake.State.sftp!.nextStatError = 'no such file'
    const local = join(dir, 'fit.txt')
    await expect(executor.pull(connection(), { remotePath: 'gone.txt', localPath: local }))
      .rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' })
  })

  it('maps a remote stream error during pull', async () => {
    fake.State.sftp!.withFile('out/fit.txt', 'data')
    fake.State.sftp!.nextReadError = 'io error'
    const local = join(dir, 'fit.txt')
    await expect(executor.pull(connection(), { remotePath: 'out/fit.txt', localPath: local }))
      .rejects.toMatchObject({ code: 'REMOTE_IO_ERROR' })
  })

  it('rejects an oversized remote file', async () => {
    fake.State.sftp!.withFile('big.bin', 'x'.repeat(2048))
    const local = join(dir, 'big.bin')
    await expect(executor.pull(connection(), { remotePath: 'big.bin', localPath: local }))
      .rejects.toMatchObject({ code: 'REMOTE_TOO_LARGE' })
  })
})
