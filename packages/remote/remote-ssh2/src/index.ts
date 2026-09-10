/**
 * SSH2 remote-execution provider (`ctx.remote`): one live SSH client per
 * connection identity, reused across calls while the config is unchanged and
 * closed on idle timeout and on disposal. Implements remote `bash` runs with
 * bounded collected output, bounded line-window text reads, atomic SFTP
 * temp-file+rename writes and literal edits, and streamed push/pull transfers.
 * Host keys are verified against an expected SHA256 fingerprint — a connection
 * without a pinned fingerprint is refused rather than accepted by TOFU.
 * Every request is fully explicit; the tool layer owns all defaults.
 * @module @deepseek-ai/dsh-remote-ssh2
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename as localRename, stat as localStat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Client, SFTPWrapper } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import {
  RemoteError,
  RemoteExecutor,
  resolveRemotePath,
} from '@deepseek-ai/dsh-remote'
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

/**
 * Provider config: shared connection and payload limits. Values that vary per
 * analysis live on the tool-built {@link RemoteConnection}, never here.
 */
export interface Config {
  /** Close a pooled connection after this idle time. Default 60s. */
  idleTimeoutMs?: number
  /** Connection-establishment deadline. Default 15s. */
  connectTimeoutMs?: number
  /** Per-stream cap for one command's collected output. Default 256 KiB. */
  maxOutputBytes?: number
  /** Cap for one text read/write/edit payload. Default 16 MiB. */
  maxReadBytes?: number
}

export const Config: z<Config> = z.object({
  idleTimeoutMs: z.number().default(60_000),
  connectTimeoutMs: z.number().default(15_000),
  maxOutputBytes: z.number().default(256 * 1024),
  maxReadBytes: z.number().default(16 * 1024 * 1024),
})

/** One pooled SSH client plus its liveness state. */
interface PooledClient {
  readonly client: Client
  /** Lazily opened SFTP handle bound to this client. */
  sftp: SFTPWrapper | undefined
  /** Idle-sweep timer; cleared on use. */
  idleTimer: NodeJS.Timeout | undefined
  /** Serialized identity this client was connected with. */
  fingerprint: string
  /** True once the connection closed (any reason); the pool then discards it. */
  closed: boolean
}

/** Human-readable message from an unknown thrown value. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** SHA256 base64 fingerprint of a host key, as `ssh2` reports it. */
function fingerprintOf(hostKey: Buffer): string {
  return createHash('sha256').update(hostKey).digest('base64')
}

/** Serialized identity of one resolved connection (the pool key). */
function connectionFingerprint(connection: RemoteConnection): string {
  const auth = connection.auth
  const authId = auth.kind === 'key'
    ? `key:${auth.keyPath}`
    : auth.kind === 'password'
      ? 'pw'
      : 'agent'
  return `${connection.id}|${connection.host}:${connection.port}|${connection.user}|${authId}`
}

/** Read and materialize the auth half of the connect config. */
async function authConfig(connection: RemoteConnection): Promise<ConnectConfig> {
  const auth = connection.auth
  if (auth.kind === 'key') {
    let privateKey: string | Buffer
    try {
      privateKey = await readFile(auth.keyPath)
    } catch (cause) {
      throw new RemoteError(
        `cannot read ssh key '${auth.keyPath}': ${messageOf(cause)}`,
        'REMOTE_AUTH_FAILED',
        { cause },
      )
    }
    return auth.passphrase === undefined
      ? { privateKey }
      : { privateKey, passphrase: auth.passphrase }
  }
  if (auth.kind === 'password') {
    return { password: auth.password }
  }
  const sock = process.env.SSH_AUTH_SOCK
  return sock ? { agent: sock } : {}
}

/**
 * The host-key verifier: strict by default. A connection without a pinned
 * `hostKeyFingerprint` is refused; there is deliberately no trust-on-first-use.
 */
function hostVerifier(connection: RemoteConnection): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const expected = connection.hostKeyFingerprint
    if (expected === undefined) {
      throw new RemoteError(
        `host key not pinned for '${connection.host}'; set hostKeyFingerprint in the analysis .dsh configuration`,
        'REMOTE_HOST_KEY_MISMATCH',
      )
    }
    return fingerprintOf(key) === expected
  }
}

function classifyConnectError(cause: unknown, connection: RemoteConnection): RemoteError {
  if (cause instanceof RemoteError) return cause
  const message = messageOf(cause)
  if (/host key/i.test(message)) {
    return new RemoteError(`host key verification failed for '${connection.host}'`, 'REMOTE_HOST_KEY_MISMATCH', { cause })
  }
  if (/(authentication|permission denied|all configured authentication methods failed)/i.test(message)) {
    return new RemoteError(
      `authentication failed for '${connection.user}@${connection.host}'`,
      'REMOTE_AUTH_FAILED',
      { cause },
    )
  }
  return new RemoteError(
    `cannot connect to '${connection.user}@${connection.host}:${connection.port}': ${message}`,
    'REMOTE_CONNECT_FAILED',
    { cause },
  )
}

/** Establish one live client, mapping failure to typed errors. */
async function connectClient(
  connection: RemoteConnection,
  connectTimeoutMs: number,
): Promise<Client> {
  const client = new Client()
  const auth = await authConfig(connection)
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => { reject(err) }
      const onReady = (): void => {
        client.removeListener('error', onError)
        resolve()
      }
      client.on('error', onError)
      client.on('ready', onReady)
      client.connect({
        host: connection.host,
        port: connection.port,
        username: connection.user,
        readyTimeout: connectTimeoutMs,
        hostVerifier: hostVerifier(connection),
        ...auth,
      })
    })
    return client
  } catch (cause) {
    client.end()
    throw classifyConnectError(cause, connection)
  }
}

/** Promise wrapper around `client.exec`. */
function execChannel(client: Client, command: string): Promise<import('ssh2').ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) reject(err)
      else resolve(channel)
    })
  })
}

/** A monotonic closed marker wired before any settlement query. */
function trackClose(channel: import('ssh2').ClientChannel): {
  isClosed: () => boolean
  wait: () => Promise<void>
} {
  let closed = channel.destroyed
  if (!closed) channel.on('close', () => { closed = true })
  return {
    isClosed: () => closed,
    wait: () => new Promise((resolve) => {
      if (closed) resolve()
      else channel.on('close', () => { resolve() })
    }),
  }
}

function abortError(connection: RemoteConnection): RemoteError {
  return new RemoteError(
    `remote operation aborted for '${connection.user}@${connection.host}'`,
    'REMOTE_ABORTED',
  )
}

/** A never-settling placeholder so an absent signal cannot short-circuit a race. */
const NEVER: Promise<never> = new Promise<never>(() => {})

/** A rejection-shaped cancel when the caller owns a signal. */
function abortPromise(signal: AbortSignal | undefined, connection: RemoteConnection): Promise<never> {
  if (signal === undefined) return NEVER
  return new Promise<never>((_, reject) => {
    const abort = (): void => { reject(abortError(connection)) }
    /* v8 ignore next 2 -- both aborted-at-entry and fired-later reject through `abort`; abort tests cover both. */
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** One bounded text stream collector. */
function collectBounded(maxBytes: number): { write: (chunk: Buffer) => void; text: () => string } {
  let text = ''
  let bytes = 0
  return {
    write(chunk: Buffer) {
      const take = Math.min(chunk.byteLength, maxBytes - bytes)
      if (take > 0) {
        text += chunk.subarray(0, take).toString('utf8')
        bytes += take
      }
    },
    text: () => text,
  }
}

/** Map a remote sftp error into typed failure codes. */
function classifySftpError(cause: unknown, path: string): RemoteError {
  if (cause instanceof RemoteError) return cause
  const message = messageOf(cause)
  if (/(no such file|ENOENT|does not exist)/i.test(message)) {
    return new RemoteError(`remote path '${path}' not found`, 'REMOTE_NOT_FOUND', { cause })
  }
  if (/(permission denied|EACCES)/i.test(message)) {
    return new RemoteError(`permission denied for remote path '${path}'`, 'REMOTE_PERMISSION_DENIED', { cause })
  }
  if (/(already exists|EEXIST)/i.test(message)) {
    return new RemoteError(`remote path '${path}' already exists`, 'REMOTE_ALREADY_EXISTS', { cause })
  }
  return new RemoteError(`remote io error on '${path}': ${message}`, 'REMOTE_IO_ERROR', { cause })
}

/** Publish one remote temp file under its target, overwriting a stale target.
 * Prefers the OpenSSH `posix-rename@openssh.com` extension (rename-over-existing);
 * falls back to a guarded plain `rename` that removes a stale target first, for
 * servers without the extension. */
function sftpPublishTemp(
  sftp: SFTPWrapper,
  tmp: string,
  target: string,
): Promise<void> {
  const publish = (): Promise<void> => new Promise((resolve, reject) => {
    sftp.rename(tmp, target, (err: Error | null | undefined) => {
      if (err) {
        sftp.unlink(tmp, () => {})
        reject(classifySftpError(err, target))
        return
      }
      resolve()
    })
  })
  const posixRename: unknown = (sftp as unknown as Record<string, unknown>)['ext_openssh_rename']
  if (typeof posixRename === 'function') {
    // The extension method lives on the prototype and must be this-bound.
    // Any wrapper failure — a synchronous throw (surfaced as an executor
    // rejection), a broken-extension callback error, or an asynchronous
    // rejection — lands on the guarded fallback path.
    return new Promise<void>((resolve, reject) => {
      try {
        ;(posixRename as (oldPath: string, newPath: string, cb: (err: Error | null | undefined) => void) => void)
          .call(sftp, tmp, target, (err: Error | null | undefined) => {
            if (!err) {
              resolve()
              return
            }
            sftp.unlink(target, () => {
              publish().then(resolve, reject)
            })
          })
      } catch {
        sftpUnlinkAndPublish(sftp, target, publish).then(resolve, reject)
      }
    })
  }
  return sftpUnlinkAndPublish(sftp, target, publish)
}

/** Remove a stale target, then publish the temp file under it. */
function sftpUnlinkAndPublish(
  sftp: SFTPWrapper,
  target: string,
  publish: () => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(target, () => {
      publish().then(resolve, reject)
    })
  })
}

/** Read a whole remote file through SFTP, failing when it exceeds the cap. */
function sftpReadAll(sftp: SFTPWrapper, path: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const stream = sftp.createReadStream(path)
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        stream.destroy(new RemoteError(
          `remote file '${path}' exceeds the ${maxBytes}-byte read cap`,
          'REMOTE_TOO_LARGE',
        ))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => { resolve(Buffer.concat(chunks)) })
    stream.on('error', (err: Error) => { reject(classifySftpError(err, path)) })
  })
}

/** Decode strictly as UTF-8 text, rejecting binary payloads. */
function decodeText(buffer: Buffer, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (cause) {
    throw new RemoteError(
      `remote file '${path}' is not valid UTF-8 text`,
      'REMOTE_NOT_TEXT',
      { cause },
    )
  }
}

/** Split text into lines, dropping the phantom trailing newline entry. */
function splitLines(text: string): string[] {
  const parts = text.split('\n')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

/** Write one remote file through a temp sibling and an atomic SFTP rename. */
function sftpWriteAtomic(sftp: SFTPWrapper, path: string, content: Buffer): Promise<void> {
  const tmp = `${path}.dsh-tmp-${randomUUID()}`
  return new Promise((resolve, reject) => {
    const out = sftp.createWriteStream(tmp)
    out.on('close', () => {
      sftpPublishTemp(sftp, tmp, path).then(resolve, reject)
    })
    out.on('error', (err: Error) => {
      sftp.unlink(tmp, () => {})
      reject(classifySftpError(err, tmp))
    })
    out.end(Buffer.from(content))
  })
}

/** Stream a local file into a remote temp sibling, then atomically rename it. */
function sftpPutAtomic(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<number> {
  const tmp = `${remotePath}.dsh-tmp-${randomUUID()}`
  return new Promise((resolve, reject) => {
    const source = createReadStream(localPath)
    const out = sftp.createWriteStream(tmp)
    let bytes = 0
    source.on('data', (chunk: string | Buffer) => { bytes += Buffer.byteLength(chunk) })
    out.on('close', () => {
      sftpPublishTemp(sftp, tmp, remotePath).then(() => { resolve(bytes) }, reject)
    })
    out.on('error', (err: Error) => {
      source.destroy()
      sftp.unlink(tmp, () => {})
      reject(classifySftpError(err, tmp))
    })
    /* v8 ignore next 3 -- a stat-confirmed file failing mid-read needs a kernel/hardware fault racing the transfer. */
    source.on('error', (err: Error) => {
      out.destroy()
      reject(new RemoteError(`cannot read local file '${localPath}': ${err.message}`, 'LOCAL_NOT_FOUND', { cause: err }))
    })
    source.pipe(out)
  })
}

/** Stream a remote file into a local temp sibling, then atomically rename it. */
function sftpGetAtomic(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<number> {
  const tmp = `${localPath}.dsh-tmp-${randomUUID()}`
  return new Promise((resolve, reject) => {
    const out = createWriteStream(tmp)
    const source = sftp.createReadStream(remotePath)
    let bytes = 0
    source.on('data', (chunk: string | Buffer) => { bytes += Buffer.byteLength(chunk) })
    out.on('close', () => {
      /* v8 ignore next 3 -- temp→target rename failure needs a local publish fault after a successful stream. */
      localRename(tmp, localPath)
        .then(() => { resolve(bytes) })
        .catch((err: unknown) => { reject(new RemoteError(`cannot publish local file '${localPath}': ${messageOf(err)}`, 'LOCAL_PERMISSION_DENIED', { cause: err })) })
    })
    /* v8 ignore next 3 -- temp-file write failure needs a local quota/permission fault, not reachable on a verified temp sibling. */
    out.on('error', (err: Error) => {
      source.destroy()
      reject(new RemoteError(`cannot write local file '${localPath}': ${err.message}`, 'LOCAL_PERMISSION_DENIED', { cause: err }))
    })
    source.on('error', (err: Error) => {
      out.destroy()
      reject(classifySftpError(err, remotePath))
    })
    source.pipe(out)
  })
}

/** Resolve a remote path for a file operation (relative against remoteRoot). */
function remoteFile(connection: RemoteConnection, path: string): string {
  return resolveRemotePath(connection, path)
}

/** Stat a remote path through SFTP (undefined when absent). */
function sftpExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (err) => { resolve(err == null) })
  })
}

/** Open (or lazily open) the SFTP handle for a pooled client. */
function sftpOf(pooled: PooledClient): Promise<SFTPWrapper> {
  if (pooled.sftp !== undefined) return Promise.resolve(pooled.sftp)
  return new Promise((resolve, reject) => {
    pooled.client.sftp((err, sftp) => {
      if (err) reject(new RemoteError(`cannot open sftp channel: ${err.message}`, 'REMOTE_IO_ERROR', { cause: err }))
      else {
        pooled.sftp = sftp
        resolve(sftp)
      }
    })
  })
}

/** Terminate a pooled client and delete its slot. */
function free(pooled: PooledClient): void {
  if (pooled.idleTimer !== undefined) clearTimeout(pooled.idleTimer)
  pooled.client.end()
}

/**
 * SSH2 backing for `ctx.remote`. One instance per composition; pooled clients
 * are keyed by connection identity and torn down on context disposal.
 */
export class Ssh2RemoteExecutor extends RemoteExecutor {
  static Config: z<Config> = z.object({
    idleTimeoutMs: z.number().default(60_000),
    connectTimeoutMs: z.number().default(15_000),
    maxOutputBytes: z.number().default(256 * 1024),
    maxReadBytes: z.number().default(16 * 1024 * 1024),
  })

  private readonly pool = new Map<string, PooledClient>()
  private readonly opts: Required<Config>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.opts = {
      idleTimeoutMs: config.idleTimeoutMs ?? 60_000,
      connectTimeoutMs: config.connectTimeoutMs ?? 15_000,
      maxOutputBytes: config.maxOutputBytes ?? 256 * 1024,
      maxReadBytes: config.maxReadBytes ?? 16 * 1024 * 1024,
    }
    /* v8 ignore next 3 -- fiber-disposal teardown is exercised by composition lifecycle tests. */
    ctx.effect(() => {
      return () => { this.dispose() }
    })
  }

  /** Close every pooled connection now. Idempotent; pooled slots are dropped. */
  public dispose(): void {
    for (const pooled of this.pool.values()) free(pooled)
    this.pool.clear()
  }

  /** Acquire (or establish) the pooled connection for one call. */
  private async acquire(connection: RemoteConnection): Promise<PooledClient> {
    const fingerprint = connectionFingerprint(connection)
    const existing = this.pool.get(fingerprint)
    if (existing !== undefined && !existing.closed) {
      if (existing.idleTimer !== undefined) {
        clearTimeout(existing.idleTimer)
        existing.idleTimer = undefined
      }
      return existing
    }
    if (existing !== undefined) {
      free(existing)
      this.pool.delete(fingerprint)
    }
    const client = await connectClient(connection, this.opts.connectTimeoutMs)
    const pooled: PooledClient = { client, sftp: undefined, idleTimer: undefined, fingerprint, closed: false }
    client.on('close', () => { pooled.closed = true })
    this.pool.set(fingerprint, pooled)
    return pooled
  }

  /** Schedule idle close for a returned pooled client. */
  private release(pooled: PooledClient): void {
    /* v8 ignore next 3 -- clearing a live idle timer needs two releases inside the idle window. */
    if (pooled.idleTimer !== undefined) clearTimeout(pooled.idleTimer)
    pooled.idleTimer = setTimeout(() => {
      const current = this.pool.get(pooled.fingerprint)
      /* v8 ignore next 3 -- a stale slot means the caller replaced the pooled client before the idle sweep ran. */
      if (current === pooled) {
        free(current)
        this.pool.delete(pooled.fingerprint)
      }
    }, this.opts.idleTimeoutMs)
    pooled.idleTimer.unref()
  }

  override async run(connection: RemoteConnection, request: RemoteRunRequest): Promise<RemoteRunResult> {
    const pooled = await this.acquire(connection)
    const channel = await execChannel(pooled.client, 'bash -s').catch((cause: unknown) => {
      throw new RemoteError(
        `cannot open remote channel: ${messageOf(cause)}`,
        'REMOTE_IO_ERROR',
        { cause },
      )
    })
    const stdout = collectBounded(this.opts.maxOutputBytes)
    const stderr = collectBounded(this.opts.maxOutputBytes)
    let exitCode: number | null = null
    let signal: string | null = null
    let timedOut = false
    // Attach collectors BEFORE writing so no output escapes between spawn and
    // the first data event.
    /* v8 ignore start -- ssh2 delivers Buffer chunks; string chunks are a defensive branch. */
    channel.stdout.on('data', (chunk: string | Buffer) => { stdout.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
    channel.stderr.on('data', (chunk: string | Buffer) => { stderr.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
    /* v8 ignore stop */
    const closing = trackClose(channel)
    channel.on('exit', (code: number | null, sig: string | null) => {
      exitCode = code
      signal = sig
    })
    channel.write(`${request.command}\n`)
    channel.end()
    const deadline = new Promise<never>(() => {
      const timer = setTimeout(() => {
        timedOut = true
        channel.signal('KILL')
        channel.close()
      }, request.timeoutMs)
      // The timer is cleared on the settle path below.
      channel.on('close', () => { clearTimeout(timer) })
    })
    try {
      await Promise.race([
        closing.wait(),
        deadline,
        abortPromise(request.signal, connection),
      ])
    } finally {
      // Abort or deadline may still hold the channel open; force-close it.
      if (!closing.isClosed()) channel.close()
      await closing.wait()
      this.release(pooled)
    }
    return {
      exitCode,
      signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut,
    }
  }

  override async readText(connection: RemoteConnection, request: RemoteReadRequest): Promise<RemoteReadResult> {
    const pooled = await this.acquire(connection)
    try {
      const sftp = await sftpOf(pooled)
      const path = remoteFile(connection, request.path)
      const buffer = await sftpReadAll(sftp, path, this.opts.maxReadBytes)
      const text = decodeText(buffer, path)
      const lines = splitLines(text)
      const total = lines.length
      const start = Math.max(0, request.offset - 1)
      const window = lines.slice(start, start + request.limit)
      return {
        path: request.path,
        lines: window.map((text, i) => ({ number: start + i + 1, text })),
        totalLines: total,
        truncated: start + request.limit < total,
      }
    } finally {
      this.release(pooled)
    }
  }

  override async writeText(connection: RemoteConnection, request: RemoteWriteRequest): Promise<RemoteWriteResult> {
    const pooled = await this.acquire(connection)
    try {
      const sftp = await sftpOf(pooled)
      const path = remoteFile(connection, request.path)
      const buffer = Buffer.from(request.content, 'utf8')
      if (buffer.byteLength > this.opts.maxReadBytes) {
        throw new RemoteError(
          `write payload for '${path}' exceeds the ${this.opts.maxReadBytes}-byte cap`,
          'REMOTE_TOO_LARGE',
        )
      }
      const existed = await sftpExists(sftp, path)
      await sftpWriteAtomic(sftp, path, buffer)
      return { path: request.path, created: !existed }
    } finally {
      this.release(pooled)
    }
  }

  override async editText(connection: RemoteConnection, request: RemoteEditRequest): Promise<RemoteEditResult> {
    const pooled = await this.acquire(connection)
    try {
      const sftp = await sftpOf(pooled)
      const path = remoteFile(connection, request.path)
      const buffer = await sftpReadAll(sftp, path, this.opts.maxReadBytes)
      const text = decodeText(buffer, path)
      const occurrences = text.split(request.oldString).length - 1
      if (occurrences === 0) {
        throw new RemoteError(
          `old_string not found in remote file '${path}'`,
          'REMOTE_AMBIGUOUS_EDIT',
        )
      }
      if (!request.replaceAll && occurrences !== 1) {
        throw new RemoteError(
          `old_string appears ${occurrences} times in remote file '${path}'; set replace_all or make old_string specific`,
          'REMOTE_AMBIGUOUS_EDIT',
        )
      }
      const updated = request.replaceAll
        ? text.split(request.oldString).join(request.newString)
        : text.replace(request.oldString, request.newString)
      await sftpWriteAtomic(sftp, path, Buffer.from(updated, 'utf8'))
      return { path: request.path, occurrences }
    } finally {
      this.release(pooled)
    }
  }

  override async push(connection: RemoteConnection, request: RemotePushRequest): Promise<RemoteTransferResult> {
    const pooled = await this.acquire(connection)
    try {
      const sftp = await sftpOf(pooled)
      let local: Awaited<ReturnType<typeof localStat>>
      try {
        local = await localStat(request.localPath)
      } catch (cause) {
        throw new RemoteError(`local file '${request.localPath}' not found`, 'LOCAL_NOT_FOUND', { cause })
      }
      if (!local.isFile()) {
        throw new RemoteError(
          `local path '${request.localPath}' is not a regular file`,
          'LOCAL_NOT_FOUND',
        )
      }
      if (local.size > connection.maxTransferBytes) {
        throw new RemoteError(
          `local file '${request.localPath}' is ${local.size} bytes, exceeding the ${connection.maxTransferBytes}-byte transfer cap`,
          'REMOTE_TOO_LARGE',
        )
      }
      const remotePath = remoteFile(connection, request.remotePath)
      const exists = await sftpExists(sftp, remotePath)
      if (exists && request.overwrite !== true) {
        throw new RemoteError(
          `remote file '${remotePath}' already exists; set overwrite to replace it`,
          'REMOTE_ALREADY_EXISTS',
        )
      }
      const bytes = await sftpPutAtomic(sftp, remotePath, request.localPath)
      return { localPath: request.localPath, remotePath: request.remotePath, bytes }
    } finally {
      this.release(pooled)
    }
  }

  override async pull(connection: RemoteConnection, request: RemotePullRequest): Promise<RemoteTransferResult> {
    const pooled = await this.acquire(connection)
    try {
      const sftp = await sftpOf(pooled)
      const remotePath = remoteFile(connection, request.remotePath)
      let size: number
      try {
        const remote = await new Promise<import('ssh2').Stats>((resolve, reject) => {
          sftp.stat(remotePath, (err, stats) => {
            if (err) reject(classifySftpError(err, remotePath))
            else resolve(stats)
          })
        })
        size = remote.size
      } catch (cause) {
        /* v8 ignore next -- the sftp stat callback rejects with plain errors; a RemoteError passthrough is defensive. */
        throw cause instanceof RemoteError ? cause : classifySftpError(cause, remotePath)
      }
      if (size > connection.maxTransferBytes) {
        throw new RemoteError(
          `remote file '${remotePath}' is ${size} bytes, exceeding the ${connection.maxTransferBytes}-byte transfer cap`,
          'REMOTE_TOO_LARGE',
        )
      }
      try {
        await localStat(request.localPath)
        if (request.overwrite !== true) {
          throw new RemoteError(
            `local file '${request.localPath}' already exists; set overwrite to replace it`,
            'LOCAL_ALREADY_EXISTS',
          )
        }
      } catch (cause) {
        if (cause instanceof RemoteError) throw cause
        // ENOENT is the expected path.
      }
      const bytes = await sftpGetAtomic(sftp, remotePath, request.localPath)
      return { localPath: request.localPath, remotePath: request.remotePath, bytes }
    } finally {
      this.release(pooled)
    }
  }
}

export default Ssh2RemoteExecutor
