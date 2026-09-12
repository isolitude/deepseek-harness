---
description: "The ctx.remote remote-execution service contract for deployments choosing or mounting a remote backend and developers implementing one."
kind: "package-reference"
---

# @deepseek-ai/dsh-remote

English | [中文](README.zh.md)

## Summary

`dsh-remote` defines the `ctx.remote` remote-execution service: a compact, backend-neutral contract that runs shell commands and bounded file operations on a per-call resolved remote connection (SSH). Every call carries a fully-explicit `RemoteConnection` built by the consuming tool layer, so the seam applies no hidden defaults and never sees a secret. The shipped provider is `dsh-remote-ssh2`; the model-facing tools live in `dsh-tool-remote`. Choose it when an agent needs remote command execution and file transfer beside a local execution world.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

You rarely load `dsh-remote` directly: you mount a provider that registers `ctx.remote`, then either call the service from your own plugin or let the `dsh-tool-remote` tools call it for you. This page serves the two audiences that do touch it — deployments choosing a backend and developers implementing or consuming the contract.

### Choosing and mounting a backend

Pick `dsh-remote-ssh2` for SSH execution. Mounting a backend populates `ctx.remote`; the tool schemas stay identical across backends. A composition that mounts no backend has no `ctx.remote`, and the tools fail at registration.

### What the service lets you do

Through `ctx.remote` you can run one remote shell command with bounded output (`run`), read a bounded line-numbered window of a remote UTF-8 text file (`readText`), atomically create or replace a file (`writeText`), apply one literal edit (`editText`), and stream one file in either direction over SFTP (`push` / `pull`). Every operation takes the resolved connection; failures are typed `RemoteError`s carrying a stable code such as `REMOTE_AUTH_FAILED`, `REMOTE_HOST_KEY_MISMATCH`, `REMOTE_NOT_FOUND`, or `REMOTE_TOO_LARGE`, so callers branch on the code, never on message text. A connection may also carry a `proxyJump` hop (an SSH jump/bastion host) that the provider tunnels through before reaching the target; the hop is a `RemoteJumpHost` with its own `RemoteAuth` and host-key pin.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Explicit per-call connection.** The seam applies no connection defaults: the tool layer resolves per-analysis configuration (host, auth, remote root, caps) into a fully-materialized `RemoteConnection` before every operation, so deployment policy stays at the config boundary.
- **Typed errors, opaque identity.** Failures carry stable codes; remote paths resolve against the connection's `remoteRoot` and reject parent escape.
- **Cancellation rides the request.** Each request optionally carries a caller-owned `AbortSignal` (the tools pass `exec.signal`); providers observe it at channel and transfer boundaries.
- **Optional jump hop on the connection.** A connection may carry a `proxyJump` (SSH bastion) hop the provider tunnels through; it authenticates independently and pins its own host key, so each hop is verified on its own.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service definition: the abstract `RemoteExecutor`, `resolveRemotePath`, the `ctx.remote` declaration |
| [`src/types.ts`](src/types.ts) | Vocabulary: `RemoteConnection`, `RemoteAuth`, request/result shapes, `RemoteError` and its codes |

### How a call flows

The consumer builds a resolved connection, then calls one abstract method. Every file operation resolves the requested path against `remoteRoot` (`resolveRemotePath`) before the provider touches the remote end, so a `..` escape or a sibling root fails fast with `REMOTE_PERMISSION_DENIED`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the seam surface to the provider and the tools built on it.

- [dsh-remote-ssh2](../remote-ssh2/README.md) — the SSH2 provider implementing this contract.
- [dsh-tool-remote](../tool-remote/README.md) — the model-facing `remote_*` tools that consume `ctx.remote`.
- [Remote SSH tools plan](../../../LLMPWA/documentation/ssh-remote-tools-plan.md) — the per-analysis `.dsh` composition design this seam was built for.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-remote`, which renders remote command output, line windows, mutation acknowledgements, and transfer confirmations to the model.

#### KV Cache effect

No direct invalidation; the tool package owns request-prefix changes.

## Known Limitations and Deferred Work

- **Single-file transfers** — `push`/`pull` stream exactly one file; recursive directory transfer is out of scope (combine `remote_exec` with `tar` for now).
- **No remote listing primitive** — `readText`/`writeText`/`editText` address individual files; directory discovery on the remote world is left to the consumer.
- **No interactive vocabulary** — the seam runs a command to completion; interactive terminal sessions are out of scope.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
