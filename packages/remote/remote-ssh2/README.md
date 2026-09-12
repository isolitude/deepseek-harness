---
description: "The SSH2 remote-execution provider for deployments choosing SSH-backed remote commands and file transfer, and maintainers of the remote seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-ssh2

English | [中文](README.zh.md)

## Summary

`dsh-remote-ssh2` implements `ctx.remote` over SSH: one live SSH client per connection identity, reused across calls while the configuration is unchanged, running remote `bash` commands with bounded collected output and streaming single-file transfers through SFTP. Host keys are verified against an expected SHA256 fingerprint — a connection without a pinned fingerprint is refused rather than accepted by trust-on-first-use. Mount it beside `dsh-tool-remote`; together they give an agent remote execution and file transfer configured per analysis.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when remote command execution and file transfer should run on a server reachable over SSH. It is the provider half of the remote seam: mounting it registers `ctx.remote`; the `remote_*` tools then configure themselves from each analysis's `.dsh/config.yml`.

### Mounting it

```yaml
- name: '@deepseek-ai/dsh-remote-ssh2'
- name: '@deepseek-ai/dsh-tool-remote'
```

### Provider configuration

All keys are optional; the defaults are sensible for interactive use.

| Key | Default | Meaning |
|---|---|---|
| `idleTimeoutMs` | `60000` | Close a pooled connection after this idle time |
| `connectTimeoutMs` | `15000` | Connection-establishment deadline |
| `keepaliveIntervalMs` | `60000` | Send an SSH keepalive packet every this many milliseconds; `0` disables |
| `keepaliveCountMax` | `3` | Drop the connection after this many consecutive unanswered keepalives |
| `maxOutputBytes` | `262144` | Per-stream cap for one command's collected output |
| `maxReadBytes` | `16777216` | Cap for one text read/write/edit payload |

Keepalive is on by default: every connection sends an SSH-level keepalive packet every `keepaliveIntervalMs` and drops the connection after `keepaliveCountMax` consecutive unanswered packets. This is global, so long-running sessions stay stable without per-host setup, mirroring OpenSSH's `ServerAliveInterval` / `ServerAliveCountMax`. Set `keepaliveIntervalMs: 0` to disable keepalive for every connection.

Per-connection values (host, port, user, auth, remote root, transfer cap, fingerprint) come from the per-analysis configuration that `dsh-tool-remote` resolves; none of them belong here.

### Authentication

The tool layer materializes one of three forms on the connection: a private key file (`key`), a password (`password`), or the local ssh-agent (`agent`, via `SSH_AUTH_SOCK`). The provider never sees a credential name and never places a secret in a tool argument or result.

### Host-key policy

Strict by default: a connection must carry the expected SHA256 fingerprint of the remote host key (`hostKeyFingerprint` in the analysis configuration). Collect it once out-of-band (`ssh-keyscan` or a first manual `ssh` session) and pin it; a mismatch fails with `REMOTE_HOST_KEY_MISMATCH` and no traffic is exchanged. When the analysis config names a `proxyJump` hop, that hop carries its own `hostKeyFingerprint` and is verified independently of the target before any tunnel is opened.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **One pooled client per identity.** Connections are keyed by a serialized identity (analysis id, host, port, user, auth kind/key path, and the jump host when present); reused while live and closed on idle timeout, on explicit `dispose()`, and on context teardown. A socket that closes underneath the pool is detected and rebuilt on the next call. A connection routed through a `proxyJump` hop holds both clients and tears the jump down (destroy the forward stream, end the hop) together with the target.
- **Atomic remote writes.** Text writes and pushed files land in a temp sibling first and publish through an SFTP `rename`, so a failed transfer never leaves a partial file.
- **Bounded everywhere.** Command output, text payloads, and transfers respect caps; overflow fails with `REMOTE_TOO_LARGE` rather than silently truncating.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Ssh2RemoteExecutor`, `Config`, connection pool, command runs, SFTP text operations, push/pull |

### Command runs

`run` spawns `bash -s` over the channel, streams bounded stdout/stderr, and reports the remote exit code, killing signal, and timeout truth. A non-zero exit is a result, not a failure.

### Transfers

`push`/`pull` stream one file through SFTP with a byte cap, refuse overwriting by default (`overwrite` opt-in), and publish atomically via temp + rename on the target side.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-remote](../remote/README.md) — the `ctx.remote` seam this provider implements.
- [dsh-tool-remote](../tool-remote/README.md) — the model-facing tools that resolve per-analysis configuration.
- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — the sibling local-execution seam.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-remote`, which renders remote command output, line windows, mutation acknowledgements, and transfer confirmations to the model.

#### KV Cache effect

No direct invalidation; the tool package owns request-prefix changes.

## Known Limitations and Deferred Work

- **No recursive transfers** — `push`/`pull` handle exactly one file; combine `remote_exec` with `tar` for directories.
- **SFTP-level atomicity** — a remote publish depends on the server honoring same-directory `rename` atomically; cross-filesystem renames are up to the server.
- **No interactive PTY** — commands run to completion; interactive prompts require a terminal backend, out of scope here.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
