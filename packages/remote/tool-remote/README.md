---
description: "The model-facing remote SSH tools (remote_exec, remote_read, remote_write, remote_edit, remote_push, remote_pull) for agents that execute and transfer files on a per-analysis remote server."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-remote

English | [中文](README.zh.md)

## Summary

`dsh-tool-remote` gives the agent a set of remote SSH tools — `remote_exec`, `remote_read`, `remote_write`, `remote_edit`, `remote_push`, and `remote_pull` — that run commands and transfer files on a remote server configured per analysis. Each tool resolves the calling session's nearest `.dsh/config.yml` (walking up from the session working directory), builds a fully-explicit connection, and delegates to the mounted `ctx.remote` provider. `remote_push` uploads a local file to the server (to ship scripts), `remote_pull` downloads a remote file back (to collect experiment results), and the file tools operate atomically with bounded output. Choose this package together with `dsh-remote-ssh2` when an analysis's agent needs both local execution and a remote execution world.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Load the provider first, then this package: the tools register once both `ctx.remote` and the tool runtime are mounted.

```yaml
- name: '@deepseek-ai/dsh-remote-ssh2'
- name: '@deepseek-ai/dsh-tool-remote'
```

### Per-analysis configuration

Each analysis's agent finds its remote server in `<analysis>/.dsh/config.yml` under a `remote:` block:

```yaml
remote:
  host: compute-1
  port: 22
  user: phys
  remoteRoot: /home/phys/workspace
  hostKeyFingerprint: <SHA256 base64 of the server host key>
  timeoutMs: 60000          # optional
  maxTransferBytes: 268435456 # optional
  auth:
    kind: key               # key | password | agent
    keyPath: ./.dsh/secrets/id_ed25519
    # passwordRef: LLPWA_<analysis>_SSH_PASSWORD
  # proxyJump:              # optional: reach compute-1 through a bastion
  #   host: bastion
  #   port: 22
  #   user: deploy
  #   hostKeyFingerprint: <SHA256 base64 of the jump host key>
  #   auth:
  #     kind: key
  #     keyPath: ./.dsh/secrets/id_ed25519
```

The tool resolves `keyPath` relative to the analysis directory; `passwordRef` names a credential (environment variable or `dsh-credentials` store), whose value never enters a tool argument, a result, or the session log. With no `auth` block the default is the key file at `.dsh/secrets/id_ed25519`. An optional `proxyJump` block routes the connection through an SSH jump (bastion) host (`ssh -J` semantics): it authenticates independently (`key`/`password`/`agent`, defaulting to the analysis key file) and is pinned to its own `hostKeyFingerprint`, which is verified separately from the target's.

### The tools

| Tool | Arguments | Behavior |
|---|---|---|
| `remote_exec` | `command`, `workdir?`, `timeout_ms?` | Runs one remote shell command and waits for it; returns `{ exit_code, signal, stdout, stderr, timed_out }` |
| `remote_read` | `path`, `offset?`, `limit?` | Line-numbered remote text window with totals and truncation truth |
| `remote_write` | `path`, `content` | Atomic create/replace of a remote UTF-8 text file |
| `remote_edit` | `path`, `old_string`, `new_string`, `replace_all?` | One literal replacement, requiring a unique match unless `replace_all` |
| `remote_push` | `local_path`, `remote_path`, `overwrite?` | SFTP upload of one local file (push scripts); refuses overwrite by default |
| `remote_pull` | `remote_path`, `local_path`, `overwrite?` | SFTP download of one remote file (collect results); refuses overwrite by default |

Local paths resolve against the calling session's workspace; remote paths resolve against `remoteRoot`. `..` escape and remote-root escape are rejected.

### Plugin configuration

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `60000` | Default command deadline for `remote_exec` |
| `readLimit` | `2000` | Default and maximum lines returned by one `remote_read` |
| `maxTransferBytes` | `268435456` | Default transfer cap for `remote_push`/`remote_pull` |
| `workdir` | config `remoteRoot` | Default remote working directory for `remote_exec` |

### Backgrounding a long-running command

`remote_exec` runs a command to completion and returns only when the remote channel closes. To start a long job and not wait, background it on the remote shell, detach it from the tool's channel, and write output to a file:

```bash
nohup python3 train.py > run.log 2>&1 &
echo $!
```

The command returns the background PID immediately while the job keeps running detached. Poll the result later with another `remote_exec` call, for example `tail run.log`, or transfer the log file back with `remote_pull`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Resolve per call.** Every execution loads the connection from the calling session's nearest `.dsh/config.yml`, so rotated credentials and per-session configuration apply immediately; nothing is cached at registration.
- **Credentials stay internal.** The config loader materializes auth inside the tool boundary; the provider receives either a key-file path, a materialized password-credential value resolved through `dsh-credentials`, or the agent socket. Neither a tool argument nor a rendered result ever carries a secret.
- **Stable renderings.** Results render with familiar markers — `[exit code: N]`, `[killed by signal: X]`, `[timed out]`, line-numbered read windows, `Created file`/`Updated file` confirmations, `uploaded N bytes`/`downloaded N bytes`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, tool wiring, positive-number validation |
| [`src/config.ts`](src/config.ts) | Per-analysis `.dsh/config.yml` discovery, parsing, auth materialization |
| [`src/connection.ts`](src/connection.ts) | Shared connection loading and the loud missing-config error |
| [`src/exec.ts`](src/exec.ts) | `remote_exec` executor and rendering |
| [`src/files.ts`](src/files.ts) | `remote_read`/`remote_write`/`remote_edit` executors and rendering |
| [`src/transfer.ts`](src/transfer.ts) | `remote_push`/`remote_pull` executors and rendering |

### Failures

A missing configuration, a malformed config, an unknown auth kind, or a provider failure surfaces as a stable `Error: <message>` result; provider codes (`REMOTE_*`, `LOCAL_*`) remain available to callers.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-remote](../remote/README.md) — the `ctx.remote` seam the tools consume.
- [dsh-remote-ssh2](../remote-ssh2/README.md) — the SSH2 provider that executes the operations.
- [Remote SSH tools plan](../../../LLMPWA/documentation/ssh-remote-tools-plan.md) — the full per-analysis composition design, including credential storage.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope receives the remote-tools guidance below. Scoped tool restrictions can hide schemas without removing this section.

##### Remote tools guidance

```markdown
Use the remote_* tools to execute commands and transfer files on the analysis's remote server: remote_exec runs a shell command, remote_read/write/edit manage remote text files, remote_push uploads a local file (scripts), remote_pull downloads a remote file (results). Paths are relative to the remote workspace root unless absolute; overwrites require explicit overwrite: true.
```

#### Token effect

Small fixed cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the registration scope and guidance text are unchanged.

### Tool schemas

#### What the model sees

The model sees the generated `remote_exec`, `remote_read`, `remote_write`, `remote_edit`, `remote_push`, and `remote_pull` schemas with snake_case arguments; the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-remote) lists the exact schemas.

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while visible tool definitions and order are unchanged.

### Command results

#### What the model sees

`remote_exec` renders stdout, a `[stderr]` section when present, optional `[timed out]` / `[killed by signal: X]` markers, and a final `[exit code: N]` line; an unknown exit renders `[exit status unknown]`.

#### Token effect

Zero result tokens before a call; output is bounded per stream and retained until compaction.

#### KV Cache effect

Append-only; output follows the reusable request prefix.

### File and transfer results

#### What the model sees

`remote_read` renders numbered lines with a pagination footer; `remote_write` renders `Created file` or `Updated file`; `remote_edit` renders an occurrence count; transfers render `uploaded N bytes to <path>` / `downloaded N bytes from <path>`.

#### Token effect

Small retained acknowledgements; mutation arguments remain in history until compaction.

#### KV Cache effect

Append-only; results follow the reusable request prefix.

## Known Limitations and Deferred Work

- **Single-file transfers** — `remote_push`/`remote_pull` handle one file per call; directory transfer combines `remote_exec` with `tar`.
- **Configuration-driven hosts only** — the remote host comes from the analysis `.dsh/config.yml`; there is no per-call host override (a deliberate policy default).
- **No inventory tool** — listing remote directories is left to `remote_exec`; the seam and tools address individual files.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
