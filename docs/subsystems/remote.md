# Remote SSH execution

English | [中文](remote.zh.md)

The optional remote-execution capability has three parts: [dsh-remote](../../packages/remote/remote) owns `ctx.remote` and the fully-explicit per-call connection vocabulary, [dsh-remote-ssh2](../../packages/remote/remote-ssh2) implements it over SSH2 with pooled connections, strict host-key verification, and SFTP transfers, and [dsh-tool-remote](../../packages/remote/tool-remote) executes the model-facing `remote_exec`/`remote_read`/`remote_write`/`remote_edit`/`remote_push`/`remote_pull` calls and resolves each analysis's `.dsh/config.yml`. It sits beside the local execution world: local `bash`/`read`/`write`/`edit` tools remain the default, and the `remote_*` tools address the analysis's configured server.

Every operation takes a fully-resolved `RemoteConnection` built by the consumer, so the seam applies no connection defaults and never sees a credential name. Credentials (key files, password references through `dsh-credentials`, or the ssh-agent socket) materialize inside the tool layer and never enter a tool argument, a result, or the session log.

Provider source: [`packages/remote/remote/src/types.ts`](../../packages/remote/remote/src/types.ts) and [`packages/remote/remote/src/index.ts`](../../packages/remote/remote/src/index.ts). SSH2 provider source: [`packages/remote/remote-ssh2/src/index.ts`](../../packages/remote/remote-ssh2/src/index.ts). Tool source: [`packages/remote/tool-remote/src/index.ts`](../../packages/remote/tool-remote/src/index.ts).

## Connections and auth (the consumer contract)

The tool layer builds one `RemoteConnection` per call from the analysis configuration: host, port, user, remote root, caps, the expected host-key fingerprint, and one materialized auth form (`key` path, `password` value, or `agent`). Relative remote paths resolve against `remoteRoot` and reject `..` escape via `resolveRemotePath`. Host-key verification is strict: a connection without a pinned fingerprint is refused, never accepted by trust-on-first-use.

```ts type-equiv
/**
 * How this connection authenticates. Exactly one materialized form — the tool layer
 * resolves configuration references (key files, credential refs) into these values, so
 * the provider never sees a credential name and no secret enters a tool argument.
 */
type RemoteAuth =
  /** SSH private key on the local host; the provider reads the file. */
  | { readonly kind: 'key'; readonly keyPath: string; readonly passphrase?: string }
  /** Materialized password. */
  | { readonly kind: 'password'; readonly password: string }
  /** Forward the local ssh-agent (`SSH_AUTH_SOCK`) when a socket is present. */
  | { readonly kind: 'agent' }
```

```ts type-equiv
/**
 * One fully-resolved remote connection for a single call. Built by the tool layer from
 * the per-analysis `.dsh/config.yml`; identity fields are immutable per call.
 */
interface RemoteConnection {
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
  /**
   * Optional SSH jump (bastion) host the provider tunnels through before connecting to
   * the target; each hop verifies its own host key and authenticates independently.
   */
  readonly proxyJump?: RemoteJumpHost
}
```

## Operations and results

| Operation | Request | Result | Bound |
|---|---|---|---|
| `run` | command + cwd + deadline | exit code, signal, bounded stdout/stderr, timeout truth | per-stream output cap |
| `readText` | path + 1-based offset + line limit | line window, total lines, truncation truth | payload cap |
| `writeText` | path + complete content | path + created flag | payload cap |
| `editText` | path + old/new literal + replace-all | path + occurrence count | payload cap |
| `push` | local path + remote path + overwrite | both paths + bytes | transfer cap |
| `pull` | remote path + local path + overwrite | both paths + bytes | transfer cap |

A non-zero exit is a result, not a failure. Mutations and transfers publish atomically: the provider writes a temp sibling and replaces the target via the OpenSSH `posix-rename@openssh.com` extension when available, falling back to a guarded `unlink` + `rename` pair on servers without it. Transfers refuse to overwrite by default (`overwrite` opt-in). Cancellation rides each request's optional `AbortSignal` (the tools pass `exec.signal`).

Failures are typed `RemoteError`s with stable codes: `REMOTE_CONNECT_FAILED`, `REMOTE_AUTH_FAILED`, `REMOTE_HOST_KEY_MISMATCH`, `REMOTE_TIMEOUT`, `REMOTE_ABORTED`, `REMOTE_NOT_FOUND`, `REMOTE_PERMISSION_DENIED`, `REMOTE_IO_ERROR`, `REMOTE_TOO_LARGE`, `REMOTE_NOT_TEXT`, `REMOTE_AMBIGUOUS_EDIT`, `REMOTE_ALREADY_EXISTS`, `LOCAL_NOT_FOUND`, `LOCAL_PERMISSION_DENIED`, `LOCAL_ALREADY_EXISTS`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremote--remoteexecutor-abstract-seam"></a>

### `ctx.remote` — `RemoteExecutor` (abstract seam)

Abstract remote executor. One provider registers `ctx.remote` per composition; every operation takes the fully-explicit RemoteConnection produced by the consuming tool layer, so provider defaults never sneak into a call. Caller cancellation rides each request's `signal` (the tool passes `exec.signal`).

```ts cordis-catalog
/**
 * Run one remote shell command. A non-zero exit is a result, not a failure;
 * the method rejects only for infrastructure failures (connection, host key,
 * auth) or a transfer-limit violation. The returned output is bounded by the
 * provider's per-stream caps.
 * @param connection - resolved connection for this call.
 * @param request - explicit command, cwd, deadline, and environment.
 * @returns exit facts and bounded stdout/stderr.
 */
abstract run(connection: RemoteConnection, request: RemoteRunRequest): Promise<RemoteRunResult>

/**
 * Read a bounded line-numbered window of a remote UTF-8 text file.
 * @param connection - resolved connection for this call.
 * @param request - remote path, 1-based offset, and line limit.
 * @returns the window plus total lines and truncation truth.
 */
abstract readText(connection: RemoteConnection, request: RemoteReadRequest): Promise<RemoteReadResult>

/**
 * Atomically create or replace a remote UTF-8 text file.
 * @param connection - resolved connection for this call.
 * @param request - remote path and complete new content.
 * @returns the written path and whether it was created.
 */
abstract writeText(connection: RemoteConnection, request: RemoteWriteRequest): Promise<RemoteWriteResult>

/**
 * Apply one literal text replacement atomically on a remote file.
 * @param connection - resolved connection for this call.
 * @param request - remote path, old/new literal, and optional replace-all.
 * @returns the edited path and the number of replacements.
 */
abstract editText(connection: RemoteConnection, request: RemoteEditRequest): Promise<RemoteEditResult>

/**
 * Stream one local file to a remote destination (SFTP), failing when the
 * destination exists unless `overwrite` is set.
 * @param connection - resolved connection for this call.
 * @param request - local source, remote destination, and overwrite flag.
 * @returns both paths and the transferred byte count.
 */
abstract push(connection: RemoteConnection, request: RemotePushRequest): Promise<RemoteTransferResult>

/**
 * Stream one remote file to a local destination, failing when the destination
 * exists unless `overwrite` is set.
 * @param connection - resolved connection for this call.
 * @param request - remote source, local destination, and overwrite flag.
 * @returns both paths and the transferred byte count.
 */
abstract pull(connection: RemoteConnection, request: RemotePullRequest): Promise<RemoteTransferResult>
```

Source: [`packages/remote/remote/src/index.ts`](../../packages/remote/remote/src/index.ts)
<!-- END GENERATED cordis-surface -->
