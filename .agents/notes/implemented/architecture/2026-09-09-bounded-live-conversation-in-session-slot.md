# Agent Note: Bounded live conversation embedded in a session slot

Status: implemented

English | [中文](2026-09-09-bounded-live-conversation-in-session-slot.zh.md)

## Problem

The LLMPWA workbench opens an Agent session per analysis and needs to start a chat inside the drawer that opens there. The existing `ChatView` binds to the current Session and declares the `conversation.chat.node` keyed slot and the single `conversation.message.images` slot. Mounting it in a drawer would double-declare those slots and is not how a host consumes it, so a faithful full `ChatView` in the drawer would fork roughly ten packages.

## Decision

A new `single`, scope `session` slot, `conversation.embedded`, carries a bounded text conversation:

- `ui-conversation` declares `conversation.embedded` in its `SlotMap`.
- `ui-chat` registers a component into it and types the injected face so a declarer can read any node key from the Session's Chat source. The `inject(sessionId)` resolves the session binding and exposes `keyedHooks.chatNode(key)` so the transcript stays live.
- The component renders a plain scrolling user/assistant text transcript (no tool-call cards, markdown, or images) and a composer bound to the shared Input machine. Send is gated by the session `running` flag; Enter submits, Shift+Enter inserts a newline. The cwd of the bound session is shown when present.

Because the slot is `scope: 'session'` and the conversation binds to the current Session, an embedded conversation bound after the drawer opens an Agent is bound to that just-opened Agent session. The workbench (a `root` declarer) declares `conversation.embedded` as a child and renders it whenever the drawer's current Session is defined; it guards against rendering when no Session is current because the scope binding is strict.

The workbench also records each analysis's Agent session id and renders a running status flag per analysis, read from the Session list's `running` state. The agent drawer is horizontally resizable: a draggable separator between the main preview and the drawer adjusts the drawer width, bounded by a minimum and by the preview row width less a preview floor, and the width is held in the workbench store so it survives side by open/close.

The embedded transcript shows only the assistant's body text (`kind: 'text'` blocks), not its reasoning blocks, so the drawer reads as the answer rather than the thinking.

The agent panel is a floating right-edge overlay rather than a flex sibling, so it never reflows or rescales the DAG behind it. Clicking the page behind collapses the panel to a narrow title strip (docked to the right edge); clicking that strip, or the panel's own title bar, restores the full panel. Each analysis keeps one live Agent session: a replay of `openAgent` reuses the recorded session id when it is still present in the Session list, and the panel's title bar offers a "new session" action that always launches a fresh session for the analysis (clearing prior context).

The analysis → Agent-session mapping is durable. The workbench restores it two ways, both driven off the face's analyses list: it reads each analysis's on-disk settings file, and it scans the live Session list for a session whose `cwd` is that analysis's directory (sessions are created with `cwd` set to the analysis, and dsh sessions persist that `cwd`), preferring the most recently updated match. The Session-list scan is the source of truth and recovers the mapping on a page reload or a server restart even before any settings file write has run; the file is the long-term carrier. Each analysis carries `LLMPWA/analyses/<analysis>/.dsh/agent.json` holding `{ agentSessionId }`, which the workbench writes when it launches or reuses an agent session. The Host `workspaceFiles` service exposes a narrow, workspace-confined `write` method (the client remote was previously read-only): it resolves and contains the path under the workspace root, creates missing parent directories, fences the atomic write with the session's sandbox policy (default mode `workspace-write`), and surfaces a read-only session's refusal as the structured `workspace-file/write-denied` error. `dsh.llmpwa.agent-sessions` `localStorage` persistence was removed.

The reference-documents tab renders each file as a real document instead of a raw pre block. Markdown files render through the shared `MarkdownText` GFM renderer (inheriting its shiki-highlighted code fences, math, and footnotes); other file types render as a syntax-highlighted code block through the shared `CodeBlock` highlighter, with a plain pre as the safe fallback for an unknown language. Both come from the shared `ui-primitives` baseline external. The document area carries no filled background card and grows to the bottom of the pane, scrolling internally, so a long reference reads edge to edge rather than in a bounded box.

## Alternatives considered

**Reuse `ChatView` in the drawer.** It is the full product conversation. It is not designed to be double-mounted and declares exclusive child slots, so a faithful reuse would fork many packages.

**Realtime multi-agent overview in the drawer.** Rejected for this change; only a per-analysis running/idle flag is needed.

**Declare the embedded slot at `root` scope.** A `root` declarer can declare a `session` child, so the workbench keeps its own child declaration; the slot resolves through the standard Session scope provider.

## Consequences

The drawer gets a bounded, live text chat against the opened Agent session without forking `ChatView`. Tool-call detail, images, and markdown remain in the full product conversation, not the drawer. The running flag replaces a realtime overview, keeping the workbench surface small. Tests pin the bounded lines, the composer gating, and the per-node live source.

## Verification

Per-file 100% coverage on the slot contract, the embedded component, and the workbench wiring. The workbench spec asserts the slot is requested only when a Session is current, and that an analysis shows its running flag only while its Agent session is running.
