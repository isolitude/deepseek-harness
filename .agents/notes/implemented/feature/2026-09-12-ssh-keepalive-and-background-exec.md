# Agent Note: SSH keepalive default and remote_exec backgrounding

Status: implemented

English | [中文](2026-09-12-ssh-keepalive-and-background-exec.zh.md)

## Problem

Long-lived SSH sessions drop silently when an idle connection sits behind a firewall, NAT, or an idle-sweeping server: the transport closes with no signal, and the next `remote_exec` call fails with `REMOTE_CONNECT_FAILED`. The `ssh2` provider opened every pooled connection without keepalive, and did not read `~/.ssh/config` either, so the familiar `Host * / ServerAliveInterval 60 / ServerAliveCountMax 3` workaround had no effect on the harness's own connections. Users had to re-establish the build-up of a long-running remote job after the connection died.

Separately, `remote_exec` runs a command to completion and returns only when the remote channel closes. Users who wanted to start a long training job and not wait had no tool-level flag; either the command exceeded the `timeoutMs` deadline, or the agent sat blocked on a completion that could take hours.

## Decision

`dsh-remote-ssh2` keeps every connection alive by default: each `client.connect(...)` passes `keepaliveInterval: 60000` and `keepaliveCountMax: 3`, matching OpenSSH's `ServerAliveInterval 60` / `ServerAliveCountMax 3`. The values are configurable through the provider's `keepaliveIntervalMs` and `keepaliveCountMax` Config fields (defaults 60000 and 3), and `keepaliveIntervalMs: 0` disables keepalive for every connection. Jump-hop connections apply the same keepalive to the hop and the target, so a tunneled connection stays alive on both hops.

This is global: no per-host setup and no `~/.ssh/config` dependency, because the values ride the programmatic connect config that ssh2 already sends. The provider still does not read `~/.ssh/config`; the keepalive default replaces the common reason users reached for it.

`remote_exec` now has a `run_in_background` argument for jobs that must outlive one call. When a job registry (`ctx.jobs`) is composed, setting `run_in_background: true` returns a job id immediately; the tool starts the command detached inside the registry's starter, and the caller reads incremental output with `job_output` and stops it with `job_kill`. Without a registry the argument is unavailable and the tool stays foreground-only. A background job owns its own lifetime — no tool `timeoutMs` applies — and `ctx.jobs` cancellation routes to the remote run's `kill`. For a long job that should run independent of the session, the remote-shell detach pattern (`nohup <cmd> > run.log 2>&1 & echo $!`, then poll with later `remote_exec`/`remote_pull` calls) remains available; keepalive keeps the pooled connection alive across those later calls.

## Verification

- Provider unit tests assert the default `connect` options carry `keepaliveInterval: 60000` and `keepaliveCountMax: 3`, that a jump hop also carries both, and that explicit config values override the defaults.
- The full `ssh` group unit suite (ssh, remote-ssh2, tool-remote) passes; no snapshot changed because keepalive is not model-visible or user-visible transcript content.

## Alternatives considered

**Read `~/.ssh/config` in the provider.** Rejected: it would add a user-configurable file dependency and platform-specific parsing for behavior the programmatic config already expresses without setup.

**Let the tool buffer everything and return only on completion.** Rejected: it leaves an agent blocked on a job that could run hours, with no intermediate output. Backgrounding behind a job registry keeps the foreground contract (`run` settles once) while giving a long-running command a first-class handle the agent can poll and kill — instead of forcing a remote-shell `nohup` detach that leaves the output unmanageable.

**Enable keepalive only when configured.** Rejected: it would not fix the default (no-setup) case and would reintroduce the silent-drop failure for the majority of deployments.

## Consequences

- Every pooled connection and jump hop now sends SSH keepalive and drops after 3 unanswered packets, so idle-swept or NAT'd connections stay up across the default 60 s idle reuse window without per-host config.
- Connections behind a server that drops keepalive, or on a high-latency link, can now be terminated by the keepalive counter instead of by the server's own idle sweep; operators can tune `keepaliveIntervalMs`/`keepaliveCountMax` or set `keepaliveIntervalMs: 0` to restore the previous behavior.
- `remote_exec` waits for completion by default; with a job registry composed it also offers `run_in_background`, so a long job can be started detached, read incrementally, and killed. The remote-shell `nohup` detach pattern stays available for jobs that must outlive the session.
