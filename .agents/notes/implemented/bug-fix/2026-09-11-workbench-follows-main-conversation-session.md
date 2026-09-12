# Agent Note: Workbench follows the main conversation session

Status: implemented

English | [中文](2026-09-11-workbench-follows-main-conversation-session.zh.md)

## Problem

Selecting a session in the main chat area, then opening the LLMPWA workbench, left the workbench showing its previous analysis selection instead of the analysis that session belongs to. The workbench keeps one selection across open/close and did not look at the current conversation session, so a user who opened an analysis's agent session and then opened the workbench saw a different analysis's DAG.

## Decision

When the workbench opens (or the current conversation session changes while it is open), it auto-selects the analysis whose agent session is the current session. The mapping is resolved by `analysisForSession` in the workbench's load layer, building on the [restored analysis → agent-session mapping](../architecture/2026-09-09-bounded-live-conversation-in-session-slot.md):

- First from the restored `agentSessions` table (analysis dir → session id), which the face rebuilds from each analysis's on-disk settings file and the live session list on every analyses list.
- Otherwise from the live session list by matching the session's `cwd` to the analysis directory as a path suffix (`<workspaceRoot>/LLMPWA/analyses/<analysis>`). The suffix match — not only a join against `workspacePath` — is used because an analysis agent session may sit in the ungrouped bucket rather than be accounted to the workspace that holds the analyses.

A session whose `cwd` is not an analysis directory resolves to no analysis, so the workbench keeps its own selection.

A manual list pick within one open wins: the workbench records the session id it last auto-selected (`autoSyncedFor`) and, while that session is unchanged, does not override a selection the user made by hand. Closing the panel clears the marker, so a reopen re-derives from the (possibly different) conversation session.

## Alternatives considered

**Match sessions by the workspace that holds the analyses.** The workbench already prefers a session owned by the analyses workspace for file reads. It does not resolve an analysis, because an analysis agent session's `cwd` is nested under the workspace root and the workspace grouping does not account nested sessions to the parent workspace (they land in the ungrouped bucket). Relying on workspace membership therefore leaves the mapping unresolved for exactly the sessions the user reported.

**Auto-select only on fresh open, not on session change.** A user who switches to an analysis agent session while the workbench is already open would still see the stale analysis. Following the current session on change keeps the workbench and conversation consistent.

## Consequences

Opening the workbench after selecting an analysis's agent session in the main chat area now lands on that analysis, so the DAG and reference documents match the conversation. A manual pick during the same open is honored and not reverted. Per-file 100% coverage holds on the workbench component and the load layer, with component tests asserting the auto-select, the cwd-only match, and the manual-pick/reopen behavior.

## Verification

The workbench spec (`tests/workbench.client.spec.tsx`) pins the follow behavior — switch on the current session's mapped analysis, switch on the cwd-only match, keep a manual pick, and re-derive on reopen. The load spec (`tests/load.client.spec.ts`) pins `analysisForSession` for the mapping path, the cwd fallback, the ungrouped cwd suffix, and the no-match cases.
