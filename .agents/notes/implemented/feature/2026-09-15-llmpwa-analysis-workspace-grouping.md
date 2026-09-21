# Agent Note: LLMPWA analysis agent sessions group into per-analysis workspaces

Status: implemented

English | [中文](2026-09-15-llmpwa-analysis-workspace-grouping.zh.md)

## Problem

The LLMPWA workbench (`ui-llmpwa-pipeline`) launches an agent session for a selected analysis with `sessions.create({ cwd })`, where `cwd` is the analysis directory (`<workspaceRoot>/LLMPWA/analyses/<analysis>`). `dsh-workspace` accounts a Session to a Workspace only when the Session's `cwd` equals the Workspace's recorded `path` exactly. Only the repository root is registered as a Workspace, so an analysis agent Session never matches it: it is not attached to any Workspace and the Workspace browser shows it under `未分组` (Ungrouped). The mismatch also makes the browser grouping noisy: each analysis directory becomes its own `未分组` cluster rather than a named group.

## Decision

The workbench now groups its agent sessions under a per-analysis Workspace, and migrates sessions that already ran in an analysis directory into that Workspace.

1. On `listAnalyses`, the face calls `ensureAnalysisWorkspaces`: for each discovered analysis it resolves (creating on first sight) a Workspace record over the analysis directory, then accounts any live Session whose `cwd` equals that directory to it. The Host `create` verb is idempotent (a registered directory resolves to its existing record) and `attachSession` is a no-op when the Session is already accounted, so the pass is safe on every listing and self-heals after a removal.
2. Agent launch (`launchAgent`) resolves the analysis's Workspace and creates the Session with `{ workspaceId }` instead of `{ cwd }`, so a new agent Session attaches to the analysis Workspace at birth.

A new Host `attachSession` Remote verb (`workspace/attachSession`) was added so the Client can account an existing Session to a Workspace. It returns the changed Workspace projection and maps a cwd/accounting mismatch to a stable `workspace/attach-failed` RemoteError; an unexpected registry failure propagates as itself.

## Alternatives considered

**Create the Workspace only on agent launch, not on listing.** Rejected: a user must open the workbench and click an action before the group appears, but the grouping should reflect the analysis the moment the list is shown; discovery-time creation also lets the migration of already-existing ungrouped sessions run once per listing.

**Group by path prefix instead of exact match.** Rejected: that would require changing the `dsh-workspace` accounting invariant (exact `cwd === path`), broadening ownership beyond one Workspace and risking a Session joining an unintended project. Creating a real Workspace per analysis keeps the established exact-match invariant and the standard grouping surface.

**Migrate only new sessions and leave existing ungrouped ones in place.** Rejected: the user asked for both — existing analysis sessions should move into their group too, and `attachSession` is the minimal host action that does it without touching files or logs.

## Consequences

- Analysis agent Sessions now appear under a named group (the analysis directory) instead of `未分组`, for both newly launched and previously existing sessions.
- Each analysis directory gains a durable Workspace record the first time the workbench lists it. Removing that record (via the workspace deletion flow) leaves files and Sessions intact; the next listing recreates the group and re-accounts live matching Sessions.
- The workbench's read-session selection picks the project workspace that owns the analyses — the workspace whose path is a strict ancestor of the current session's cwd (falling back to an exact cwd match, then to the workspace holding the most sessions) — rather than the workspace that merely contains the current session. Once analysis agent Sessions are grouped into their own workspaces, the current session can itself live in one, so keying off "the current session's workspace" would resolve `LLMPWA/analyses` against the analysis directory and list nothing. The per-session `cwd`-match fallback for recovering an analysis mapping remains, so the panel works whether or not the current conversation session is itself an analysis agent Session.
