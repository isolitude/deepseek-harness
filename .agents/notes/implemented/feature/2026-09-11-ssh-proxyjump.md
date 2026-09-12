# Agent Note: SSH remote tools tunnel through a ProxyJump host

Status: implemented

English | [中文](2026-09-11-ssh-proxyjump.zh.md)

## Problem

The SSH remote-execution family (`dsh-remote` seam, `dsh-remote-ssh2` provider, `dsh-tool-remote` tools) connects to a target host directly. In many deployments the target is reachable only through a bastion or jump host: the target may sit behind NAT, on a private subnet, or behind a firewall that permits ingress only to one jump box, exactly the scenario OpenSSH's `ProxyJump` (`-J`) solves.

Without support, an analysis whose compute server is only reachable through a jump had no way to configure the `remote:` block — the tools were unusable in that topology. The seam (`RemoteConnection`) already made connection input fully explicit but had no concept of an intermediate hop, so the feature had to thread through the type, the config loader, and the provider.

## Decision

An analysis `.dsh/config.yml` can declare an optional `proxyJump:` block inside `remote:`. The block names a single SSH jump (bastion) host and owns its own authentication and host-key pin, mirroring `ssh -J`:

```yaml
remote:
  host: compute-1
  user: phys
  remoteRoot: /home/phys/workspace
  hostKeyFingerprint: <target host key fingerprint>
  proxyJump:
    host: bastion
    port: 22
    user: deploy
    hostKeyFingerprint: <jump host key fingerprint>
    auth:
      kind: key
      keyPath: ./.dsh/secrets/id_ed25519
```

The provider tunnels the target connection through the jump: it connects and authenticates to the jump, requests a `direct-tcpip` forward to the target via `client.forwardOut(...)`, then connects the target client with `{ sock: <forward stream> }` (the ssh2 connection-hopping path). Each hop is pinned to its own `hostKeyFingerprint` and verified independently — an unpinned jump is refused just like an unpinned target, with no trust-on-first-use anywhere.

The connection pool key and teardown include the hop. Two connections that differ only in their jump never share a pooled client; when a pooled pair is released, idle-swept, or disposed, the tunnel is closed first (the forward stream is destroyed) and then the jump client is ended.

## Verification

- The tool-remote config loader unit tests materialize a `proxyJump` block, default its `port` to 22 and its auth to the analysis key file, and reject a block missing `host`/`user` or a non-object `proxyJump`.
- The tool-remote tool tests assert a config with `proxyJump` surfaces the hop on every delegated connection.
- The provider unit tests (programmable fake ssh2 Client) assert `forwardOut` was called for the target, the target connected over the jump stream, both hops ran their own host-key verifier, the pool keys include the jump identity, and a jump forward or target-through-jump failure surfaces as `REMOTE_CONNECT_FAILED`; disposal releases the jump stream and client.
- The modified source files hold per-file 100% statements/branches/functions/lines under `pnpm run test:coverage`.
- No recorded-session snapshot changes because `proxyJump` is configuration-only: the tool names, arguments, schema, and system-prompt text are unchanged, and no credential or hop value reaches a tool argument, a result, or the session log.

## Alternatives considered

| Rejected | Reason |
|---|---|
| Compact `user@host[:port]` jump string | Loses per-hop auth and host-key pinning; a target behind a jump usually needs a different key and its own host-key verification |
| Reuse the target's auth for the jump | A jump report commonly authenticates with a separate key; folding the two would hide a real credential boundary |
| Apply `hostKeyFingerprint` only at the target | Leaves the jump hop unpinned, the strongest security hole a ProxyJump can introduce |
| Only document the feature | The topology is unusable without code support; documentation alone would not make the tools work behind a bastion |

## Consequences

- The seam exports a `RemoteJumpHost` type and `RemoteConnection.proxyJump` is optional, so existing direct connections are unchanged and backward compatible.
- The provider opens a second SSH session per pooled jump-routed connection; a jump adds connection latency and holds both clients for the pooled lifetime.
- The jump authenticates through the same `dsh-credentials` path as the target, so a `passwordRef`/`passphraseRef` against a jump is resolved without entering a tool argument or result.
- A hop is pinned strictly (absent `hostKeyFingerprint` refuses), consistent with the family's no-TOFU host-key policy.
