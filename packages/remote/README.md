---
description: "The remote-execution capability family for deployments and maintainers choosing and composing remote SSH command execution, file transfer, and the model-facing remote_* tools."
kind: "package-group"
---

# remote/ — remote execution capability family

English | [中文](README.zh.md)

## Summary

The ssh group gives agents remote command execution and file transfer over SSH while keeping the local execution world untouched: a seam defines the contract, one provider executes it over SSH2, and a tool package exposes it to the model as six `remote_*` tools. Each analysis configures its own remote server under `.dsh/config.yml`, so different analyses can execute on different hardware without changing tools or provider code. Credentials (key files, passwords) resolve inside the tool layer and never reach the model or the session log.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`remote`](remote/README.md) | Defines the remote-execution contract: per-call resolved connections, run/read/text/transfer primitives, typed errors | `ctx.remote` |
| [`remote-ssh2`](remote-ssh2/README.md) | Executes the seam over SSH2 with pooled connections, strict host-key verification, and SFTP transfers | registers `ctx.remote` |
| [`tool-remote`](tool-remote/README.md) | Exposes remote execution and transfer to the model as `remote_exec`/`remote_read`/`remote_write`/`remote_edit`/`remote_push`/`remote_pull` | registers on `ctx.tools` |

A composition mounts one provider (currently `dsh-remote-ssh2`) and the tool package; the tools then resolve each analysis's `.dsh/config.yml` at execution time.

-----

<a id="related-documentation"></a>
## Related documentation

- [Remote SSH tools plan](../../LLMPWA/documentation/ssh-remote-tools-plan.md) — the per-analysis composition design, decision points, and credential-storage guidance this family implements.
- [Filesystem subsystem](../../docs/subsystems/filesystem.md) — the local filesystem seam the remote file tools complement.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
