/**
 * Vocabulary for the remote-execution Service Definition (`ctx.remote`): the explicitly
 * resolved per-call connection, the command and file-operation requests, their results,
 * and the typed error taxonomy. This seam mirrors `dsh-shell`/`dsh-subprocess`: every
 * request is fully explicit and the provider applies no hidden defaults, so the consuming
 * tool layer decides what a remote call means.
 * @module @deepseek-ai/dsh-remote/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * How this connection authenticates. Exactly one materialized form — the tool layer
 * resolves configuration references (key files, credential refs) into these values, so
 * the provider never sees a credential name and no secret enters a tool argument.
 */
export type RemoteAuth =
  /** SSH private key on the local host; the provider reads the file. */
  | { readonly kind: 'key'; readonly keyPath: string; readonly passphrase?: string }
  /** Materialized password. */
  | { readonly kind: 'password'; readonly password: string }
  /** Forward the local ssh-agent (`SSH_AUTH_SOCK`) when a socket is present. */
  | { readonly kind: 'agent' }

/**
 * One fully-resolved remote connection for a single call. Built by the tool layer from
 * the per-analysis `.dsh/config.yml`; identity fields are immutable per call.
 */
export interface RemoteConnection {
  /** Stable per-analysis handle the provider keys its connection cache on. */
  readonly id: string
  /** Remote host name or address. */
  readonly host: string
  /** Remote port. Defaults to 22 at the tool boundary. */
  readonly port: number
  /** Remote user. */
  readonly user: string
  /** Materialized authentication for this connection. */
  readonly auth: RemoteAuth
  /** Absolute remote directory relative paths resolve against; `..` escape is rejected. */
  readonly remoteRoot: string
  /** Connection-establishment deadline in milliseconds. */
  readonly connectTimeoutMs: number
  /** Positive finite byte cap for one transfer; exceeding it fails with `REMOTE_TOO_LARGE`. */
  readonly maxTransferBytes: number
  /** Expected host-key SHA256 fingerprint (base64, no prefix); absent = strict default refuses. */
  readonly hostKeyFingerprint?: string
}

/** Base cancellation carried by every remote request. */
interface RemoteRequestBase {
  /**
   * Caller-owned cancellation for this operation (the tool passes `exec.signal`).
   * Firing aborts the in-flight channel/transfer and cleans up partial artifacts.
   */
  readonly signal?: AbortSignal | undefined
}

/** One command execution request. */
export interface RemoteRunRequest extends RemoteRequestBase {
  /** Shell command; the provider runs `bash -c` in a clean remote environment. */
  readonly command: string
  /** Remote working directory; relative paths resolve against the connection remoteRoot. */
  readonly cwd: string
  /** Positive command deadline in milliseconds; expiry kills the remote process group. */
  readonly timeoutMs: number
  /** Explicit remote environment entries merged over the scrubbed remote base. */
  readonly env?: Readonly<Record<string, string>>
}

/** Exit facts and bounded output of one remote command. */
export interface RemoteRunResult {
  /** Remote exit code; null when the process was killed by a signal. */
  readonly exitCode: number | null
  /** Terminating signal, when the remote reported one. */
  readonly signal: string | null
  /** Bounded remote stdout text. */
  readonly stdout: string
  /** Bounded remote stderr text. */
  readonly stderr: string
  /** True when the command deadline expired and the remote group was killed. */
  readonly timedOut: boolean
}

/** One remote text read request. */
export interface RemoteReadRequest extends RemoteRequestBase {
  /** Remote file path; relative resolves against the connection remoteRoot. */
  readonly path: string
  /** 1-based first line of the returned window. Defaults to 1. */
  readonly offset: number
  /** Maximum number of lines to return. */
  readonly limit: number
}

/** One numbered line of a remote read window. */
export interface RemoteReadLine {
  /** 1-based remote file line number. */
  readonly number: number
  /** The line text, without its trailing newline. */
  readonly text: string
}

/** A validated remote read window plus totals. */
export interface RemoteReadResult {
  /** The remote path as requested. */
  readonly path: string
  /** The requested window lines. */
  readonly lines: readonly RemoteReadLine[]
  /** Total remote file lines. */
  readonly totalLines: number
  /** True when more lines follow the returned window. */
  readonly truncated: boolean
}

/** One atomic remote write request. */
export interface RemoteWriteRequest extends RemoteRequestBase {
  /** Remote file path; relative resolves against the connection remoteRoot. */
  readonly path: string
  /** Complete new file content. */
  readonly content: string
}

/** One remote write outcome. */
export interface RemoteWriteResult {
  /** The remote path as requested. */
  readonly path: string
  /** True when the file did not exist before this write. */
  readonly created: boolean
}

/** One literal remote edit request. */
export interface RemoteEditRequest extends RemoteRequestBase {
  /** Remote file path; relative resolves against the connection remoteRoot. */
  readonly path: string
  /** Literal text to replace. */
  readonly oldString: string
  /** Replacement text. */
  readonly newString: string
  /** Replace every occurrence instead of requiring exactly one. */
  readonly replaceAll?: boolean
}

/** One remote literal-edit outcome. */
export interface RemoteEditResult {
  /** The remote path as requested. */
  readonly path: string
  /** Number of replacements applied. */
  readonly occurrences: number
}

/** One local→remote file transfer request. */
export interface RemotePushRequest extends RemoteRequestBase {
  /** Local source path; relative resolves against the calling session's workspace. */
  readonly localPath: string
  /** Remote destination path; relative resolves against the connection remoteRoot. */
  readonly remotePath: string
  /** Overwrite an existing remote file; defaults to false. */
  readonly overwrite?: boolean
}

/** One remote→local file transfer request. */
export interface RemotePullRequest extends RemoteRequestBase {
  /** Remote source path; relative resolves against the connection remoteRoot. */
  readonly remotePath: string
  /** Local destination path; relative resolves against the calling session's workspace. */
  readonly localPath: string
  /** Overwrite an existing local file; defaults to false. */
  readonly overwrite?: boolean
}

/** One completed file transfer. */
export interface RemoteTransferResult {
  /** Local path as requested. */
  readonly localPath: string
  /** Remote path as requested. */
  readonly remotePath: string
  /** Bytes transferred. */
  readonly bytes: number
}

/** Stable remote-execution failure codes; callers branch on these, never on message text. */
export type RemoteErrorCode =
  | 'REMOTE_CONNECT_FAILED'
  | 'REMOTE_AUTH_FAILED'
  | 'REMOTE_HOST_KEY_MISMATCH'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_ABORTED'
  | 'REMOTE_NOT_FOUND'
  | 'REMOTE_PERMISSION_DENIED'
  | 'REMOTE_IO_ERROR'
  | 'REMOTE_TOO_LARGE'
  | 'REMOTE_NOT_TEXT'
  | 'REMOTE_AMBIGUOUS_EDIT'
  | 'REMOTE_ALREADY_EXISTS'
  | 'LOCAL_NOT_FOUND'
  | 'LOCAL_PERMISSION_DENIED'
  | 'LOCAL_ALREADY_EXISTS'

/** A typed failure from the remote-execution seam. */
export class RemoteError extends HarnessError {
  override readonly code: RemoteErrorCode

  constructor(message: string, code: RemoteErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
