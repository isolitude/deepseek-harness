/**
 * The workbench's asynchronous half: listing analyses, loading a snapshot,
 * listing / reading reference files, and launching an agent session for the
 * selected analysis into the store.
 *
 * The component never awaits anything. It asks for a list, a snapshot, a
 * reference file, or an agent launch and this face performs the work and writes
 * the outcome through the store's own actions — the Slot-standard inject form,
 * so the write set stays the store's. The session the read runs under travels
 * with the call because the endpoint resolves the workspace root from it.
 *
 * A fresh request for the same surface retires the previous read still in
 * flight: the caller aborts the old signal before starting a new one, and a
 * settlement arriving after the abort writes nothing. Agent launch is a
 * one-shot button action (dispatched through a disarmed button) so it carries
 * no signal; a failure writes through the store and the caller can retry.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  listAnalyses as fetchAnalyses,
  loadSnapshot as fetchSnapshot,
  listReferenceFiles as fetchReferences,
  loadReferenceText as fetchReference,
  readAnalysisAgentSession as fetchAgentSession,
  writeAnalysisAgentSession as saveAgentSession,
  analysisWorkspaceCwd,
  type WorkspaceFilesLoadRemote,
} from './load.ts'
import type { WorkbenchStore } from './store.ts'

/** A Session list row the mapping scan reads: its id, working directory, and update time. */
type SessionRow = { readonly cwd?: string; readonly updatedAt?: number }

/**
 * Find the live agent session for one analysis by matching its working
 * directory. Each analysis's agent session is created with `cwd` set to the
 * analysis directory (`analysisWorkspaceCwd`), and dsh sessions persist that
 * `cwd`, so this recovers the mapping across reloads and restarts without
 * depending on an on-disk settings write. The most recently updated matching
 * session wins, so a "new session" replaces an older one sharing the `cwd`.
 * @param rows - the current Session list rows, keyed by session id.
 * @param workspacePath - the workspace root's canonical host path.
 * @param analysis - the selected analysis directory.
 * @returns the matching session id, or `undefined` when none is live.
 */
function sessionForAnalysis(
  rows: Readonly<Record<SessionId, SessionRow>>,
  workspacePath: string,
  analysis: string,
): SessionId | undefined {
  const cwd = analysisWorkspaceCwd(workspacePath, analysis)
  let matching: SessionId | undefined
  let newest = -1
  for (const id of Object.keys(rows) as SessionId[]) {
    const row = rows[id]
    if (row?.cwd !== cwd) continue
    /* v8 ignore next -- updatedAt is optional on the typed row (test stubs may omit it); a present one always drives the newest match. */
    if ((row.updatedAt ?? 0) <= newest) continue
    newest = row.updatedAt ?? 0
    matching = id
  }
  return matching
}

/** The workbench's injected business face, as both registrants receive it. */
export interface WorkbenchInjected {
  /**
   * List the analyses under `LLMPWA/analyses` and write the result through the
   * store. It also restores each analysis's recorded agent session: first from
   * the analysis's on-disk settings file, then by scanning the live Session
   * list for a session whose `cwd` is that analysis — so the mapping survives a
   * server restart and a page reload even when the settings file write has not
   * run yet. A load that settles after the caller aborted writes nothing.
   * @param workspacePath - the workspace root's canonical host path (to match session `cwd`s).
   * @param sessionId - the session whose workspace resolves the path.
   * @param signal - cancels the call and suppresses its settlement.
   */
  readonly listAnalyses: (workspacePath: string, sessionId: SessionId, signal: AbortSignal) => void
  /**
   * Load and parse one analysis's `gen/pipeline_state.json` and write the
   * result through the store. A load that settles after the caller aborted
   * writes nothing.
   * @param sessionId - the session whose workspace resolves the path.
   * @param analysis - the selected analysis directory.
   * @param signal - cancels the call and suppresses its settlement.
   */
  readonly loadSnapshot: (sessionId: SessionId, analysis: string, signal: AbortSignal) => void
  /**
   * List the selected analysis's reference files and write the result through
   * the store. A load that settles after the caller aborted writes nothing.
   * @param sessionId - the session whose workspace resolves the paths.
   * @param analysis - the selected analysis directory.
   * @param signal - cancels the call and suppresses its settlement.
   */
  readonly listReferences: (sessionId: SessionId, analysis: string, signal: AbortSignal) => void
  /**
   * Read one reference file's text and write it through the store. A load that
   * settles after the caller aborted writes nothing.
   * @param sessionId - the session whose workspace resolves the path.
   * @param path - the reference file's workspace-relative path.
   * @param signal - cancels the call and suppresses its settlement.
   */
  readonly loadReference: (sessionId: SessionId, path: string, signal: AbortSignal) => void
  /**
   * Open the analysis's agent session, reusing the recorded session when it is
   * still live, and write the outcome through the store. On success the session
   * is selected as current and its id recorded; on failure the error is recorded
   * so the drawer can retry.
   * @param workspacePath - the workspace root's canonical host path.
   * @param readSessionId - the workspace session used to persist settings.
   * @param analysis - the selected analysis directory.
   * @param existingSessionId - the analysis's recorded agent session, when any.
   */
  readonly openAgent: (workspacePath: string, readSessionId: SessionId, analysis: string, existingSessionId?: SessionId) => void
  /**
   * Always launch a fresh agent session for the analysis (clearing its prior
   * context) and record it, replacing the previous session id.
   * @param workspacePath - the workspace root's canonical host path.
   * @param readSessionId - the workspace session used to persist settings.
   * @param analysis - the selected analysis directory.
   */
  readonly newAgent: (workspacePath: string, readSessionId: SessionId, analysis: string) => void
}

/**
 * Bind the workbench's face to one Remote carrier and the session controller.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @param sessions - the Client Session controller used to launch the agent.
 * @returns the Slot `inject` factory: baked actions in, face out. Both slots
 * are root-scoped, so the factory receives the store's actions from a
 * root-scoped registration (no session id parameter).
 */
export function workbenchFace(
  remote: WorkspaceFilesLoadRemote,
  sessions: ISessions,
): (actions: BoundActions<WorkbenchStore>) => WorkbenchInjected {
  return (actions: BoundActions<WorkbenchStore>): WorkbenchInjected => {
    const listAnalyses = (workspacePath: string, sessionId: SessionId, signal: AbortSignal): void => {
      if (signal.aborted) return
      actions.listing()
      void fetchAnalyses(remote, sessionId, signal).then(async (analyses) => {
        if (signal.aborted) return
        actions.listed(analyses)
        // Restore each analysis's recorded agent session. The durable Session
        // list is the source of truth: a session whose `cwd` is the analysis
        // directory is that analysis's agent session, and dsh sessions persist
        // across restarts, so this recovers the mapping even if the on-disk
        // settings file has not been written yet (the write needs the Host
        // `write` endpoint, which may load after the process starts). The
        // on-disk file supplements this for a session the list has pruned.
        const byId = sessions.list.getSnapshot().byId
        const restored: Record<string, SessionId> = {}
        for (const analysis of analyses) {
          const id = await fetchAgentSession(remote, sessionId, analysis.dir, signal)
            ?? sessionForAnalysis(byId, workspacePath, analysis.dir)
          if (id !== undefined) restored[analysis.dir] = id
        }
        if (signal.aborted) return
        actions.agentSessionsLoaded(restored)
      })
    }
    const loadSnapshot = (sessionId: SessionId, analysis: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      actions.snapshotLoading()
      void fetchSnapshot(remote, sessionId, analysis, signal).then((load) => {
        if (signal.aborted) return
        if (load.ok && load.snapshot != null) {
          actions.snapshotReady(load.snapshot)
        } else {
          actions.snapshotFailed(load.error ?? { kind: 'unexpected', message: 'The snapshot load produced no result.' })
        }
      })
    }
    const listReferences = (sessionId: SessionId, analysis: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      actions.referencesLoading()
      void fetchReferences(remote, sessionId, analysis, signal).then((references) => {
        if (signal.aborted) return
        actions.referencesReady(references)
      })
    }
    const loadReference = (sessionId: SessionId, path: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      actions.referenceLoading(path)
      void fetchReference(remote, sessionId, path, signal).then((load) => {
        if (signal.aborted) return
        if (load.ok) {
          actions.referenceReady(path, load.text)
        } else {
          actions.referenceFailed(path, load.error)
        }
      })
    }
    const openAgent = (workspacePath: string, readSessionId: SessionId, analysis: string, existingSessionId?: SessionId): void => {
      // Reuse the analysis's live agent session when one is recorded and still in
      // the session list, so each analysis keeps one context across opens.
      if (existingSessionId !== undefined && sessions.list.getSnapshot().byId[existingSessionId] !== undefined) {
        sessions.open(existingSessionId)
        actions.agentReady(existingSessionId)
        return
      }
      launchAgent(workspacePath, readSessionId, analysis)
    }
    const newAgent = (workspacePath: string, readSessionId: SessionId, analysis: string): void => {
      launchAgent(workspacePath, readSessionId, analysis)
    }
    const launchAgent = (workspacePath: string, readSessionId: SessionId, analysis: string): void => {
      const cwd = analysisWorkspaceCwd(workspacePath, analysis)
      actions.agentOpening()
      void sessions.create({ cwd })
        .then((sessionId) => {
          sessions.open(sessionId)
          actions.agentReady(sessionId)
          actions.agentSession(analysis, sessionId)
          // Persist the mapping to the analysis's settings file so a later page
          // load or server restart restores this session. A failed write does
          // not fail the launch; the in-memory mapping still holds for this
          // session, and the next open rewrites it.
          void saveAgentSession(remote, readSessionId, analysis, sessionId, new AbortController().signal)
        })
        .catch((cause: unknown) => {
          actions.agentFailed({
            kind: 'unexpected',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        })
    }
    return { listAnalyses, loadSnapshot, listReferences, loadReference, openAgent, newAgent }
  }
}
