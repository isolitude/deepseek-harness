/**
 * The workbench's view state: whether the full-frame panel is open, the
 * analyses the user may pick, the selected analysis, the load state of its
 * pipeline snapshot, the reference files the panel may preview, the active
 * preview tab, and the agent drawer's launch state.
 *
 * The panel is a single root-scoped surface (one SSS offset over the whole
 * frame), so the store is one instance shared by the two registrations that
 * draw it: the left-Sidebar action (which opens it) and the `shell.overlay`
 * body (which renders it).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Analysis, ReferenceFile, SnapshotError } from './load.ts'
import type { PipelineSnapshot } from './presenters.ts'

/** The active preview tab. */
export type WorkbenchView = 'dag' | 'docs'

/** Whether a snapshot load is idle, running, or settled. */
export type SnapshotPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly snapshot: PipelineSnapshot }
  | { readonly kind: 'failed'; readonly error: SnapshotError }

/** Whether a reference-file read is idle, running, or settled. */
export type ReferencePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly path: string }
  | { readonly kind: 'ready'; readonly path: string; readonly text: string }
  | { readonly kind: 'failed'; readonly path: string; readonly error: SnapshotError }

/** Whether the agent drawer's session launch is idle, running, or settled. */
export type AgentPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'ready'; readonly sessionId: SessionId }
  | { readonly kind: 'failed'; readonly error: SnapshotError }

/** The workbench view state. */
export interface WorkbenchState {
  /** Whether the full-frame panel is currently open. */
  open: boolean
  /** The analyses discovered under `LLMPWA/analyses`; empty until listed. */
  analyses: readonly Analysis[]
  /** The selected analysis directory; undefined before a selection. */
  selected: string | undefined
  /** Whether the analyses list is being fetched. */
  listing: boolean
  /** The selected analysis's snapshot load phase. */
  snapshot: SnapshotPhase
  /** The selected analysis's reference files; empty until listed. */
  references: readonly ReferenceFile[]
  /** Whether the reference files are being fetched. */
  referencesListing: boolean
  /** The reference-file read phase for the currently previewed file. */
  reference: ReferencePhase
  /** The active preview tab. */
  view: WorkbenchView
  /** The agent drawer's width in pixels, adjustable by dragging its handle. */
  drawerWidth: number
  /** Whether the agent drawer is open. */
  agentOpen: boolean
  /** Whether the expanded agent drawer is collapsed to a narrow title strip. */
  agentCollapsed: boolean
  /** The agent drawer's session launch phase. */
  agent: AgentPhase
  /** The agent session opened per analysis directory, so the list can flag its
   *  run status. A later open for the same analysis supersedes the earlier one. */
  agentSessions: Readonly<Record<string, SessionId>>
}

/** The workbench store's write set. */
type WorkbenchActions = {
  opened: (draft: WorkbenchState) => void
  closed: (draft: WorkbenchState) => void
  listing: (draft: WorkbenchState) => void
  listed: (draft: WorkbenchState, analyses: readonly Analysis[]) => void
  selected: (draft: WorkbenchState, analysis: string) => void
  setView: (draft: WorkbenchState, view: WorkbenchView) => void
  /** Set the agent drawer's width in pixels. */
  setDrawerWidth: (draft: WorkbenchState, width: number) => void
  snapshotLoading: (draft: WorkbenchState) => void
  snapshotReady: (draft: WorkbenchState, snapshot: PipelineSnapshot) => void
  snapshotFailed: (draft: WorkbenchState, error: SnapshotError) => void
  referencesLoading: (draft: WorkbenchState) => void
  referencesReady: (draft: WorkbenchState, references: readonly ReferenceFile[]) => void
  referenceLoading: (draft: WorkbenchState, path: string) => void
  referenceReady: (draft: WorkbenchState, path: string, text: string) => void
  referenceFailed: (draft: WorkbenchState, path: string, error: SnapshotError) => void
  agentOpened: (draft: WorkbenchState) => void
  agentClosed: (draft: WorkbenchState) => void
  agentCollapse: (draft: WorkbenchState) => void
  agentExpand: (draft: WorkbenchState) => void
  agentOpening: (draft: WorkbenchState) => void
  agentReady: (draft: WorkbenchState, sessionId: SessionId) => void
  agentFailed: (draft: WorkbenchState, error: SnapshotError) => void
  /** Record the agent session opened for one analysis directory. */
  agentSession: (draft: WorkbenchState, analysis: string, sessionId: SessionId) => void
  /** Restore the recorded agent-session mapping from the per-analysis settings files. */
  agentSessionsLoaded: (draft: WorkbenchState, sessions: Readonly<Record<string, SessionId>>) => void
}

/**
 * Declare the workbench's store.
 *
 * Constructed once in `apply` and declared on both registrations; the slot
 * runtime keeps one instance because both slots are `scope: 'root'`.
 * @returns the store handle to declare on both registrations.
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({
    init: (): WorkbenchState => ({
      open: false,
      analyses: [],
      selected: undefined,
      listing: false,
      snapshot: { kind: 'idle' },
      references: [],
      referencesListing: false,
      reference: { kind: 'idle' },
      view: 'dag',
      drawerWidth: 320,
      agentOpen: false,
      agentCollapsed: false,
      agent: { kind: 'idle' },
      agentSessions: {},
    }),
    actions: {
      /** Open the full-frame panel. */
      opened: (d) => { d.open = true },
      /** Close the full-frame panel. */
      closed: (d) => { d.open = false },
      /** Mark the analyses list read as in flight. */
      listing: (d) => { d.listing = true },
      /** Record the discovered analyses. */
      listed: (d, analyses) => {
        d.analyses = analyses
        d.listing = false
      },
      /**
       * Select an analysis; its previous snapshot, reference files, and agent
       * drawer are cleared, the preview tabs back to DAG, and the reference
       * list is marked in flight.
       */
      selected: (d, analysis) => {
        d.selected = analysis
        d.snapshot = { kind: 'idle' }
        d.references = []
        d.referencesListing = true
        d.reference = { kind: 'idle' }
        d.view = 'dag'
        d.agentOpen = false
        d.agentCollapsed = false
        d.agent = { kind: 'idle' }
      },
      /** Switch the active preview tab. */
      setView: (d, view) => { d.view = view },
      /** Set the agent drawer's width in pixels. */
      setDrawerWidth: (d, width) => { d.drawerWidth = width },
      /** Mark the selected analysis's snapshot read as in flight. */
      snapshotLoading: (d) => { d.snapshot = { kind: 'loading' } },
      /** Keep the loaded snapshot. */
      snapshotReady: (d, snapshot) => { d.snapshot = { kind: 'ready', snapshot } },
      /** Record why the snapshot could not be loaded. */
      snapshotFailed: (d, error) => { d.snapshot = { kind: 'failed', error } },
      /** Mark the reference list read as in flight. */
      referencesLoading: (d) => {
        d.references = []
        d.referencesListing = true
      },
      /** Record the discovered reference files. */
      referencesReady: (d, references) => {
        d.references = references
        d.referencesListing = false
      },
      /** Mark the selected reference file's read as in flight. */
      referenceLoading: (d, path) => { d.reference = { kind: 'loading', path } },
      /** Keep the loaded reference text. */
      referenceReady: (d, path, text) => { d.reference = { kind: 'ready', path, text } },
      /** Record why the reference file could not be read. */
      referenceFailed: (d, path, error) => { d.reference = { kind: 'failed', path, error } },
      /** Open the agent drawer for the selected analysis. */
      agentOpened: (d) => {
        d.agentOpen = true
        d.agentCollapsed = false
        d.agent = { kind: 'idle' }
      },
      /** Close the agent drawer. */
      agentClosed: (d) => {
        d.agentOpen = false
        d.agentCollapsed = false
        d.agent = { kind: 'idle' }
      },
      /** Collapse the expanded agent drawer to its narrow title strip. */
      agentCollapse: (d) => { d.agentCollapsed = true },
      /** Expand the collapsed agent drawer back to its full width. */
      agentExpand: (d) => { d.agentCollapsed = false },
      /** Mark the agent session launch as in flight. */
      agentOpening: (d) => { d.agent = { kind: 'opening' } },
      /** Record the opened agent session. */
      agentReady: (d, sessionId) => { d.agent = { kind: 'ready', sessionId } },
      /** Record why the agent session could not be opened. */
      agentFailed: (d, error) => { d.agent = { kind: 'failed', error } },
      /** Record the agent session opened for one analysis directory. */
      agentSession: (d, analysis, sessionId) => {
        d.agentSessions = { ...d.agentSessions, [analysis]: sessionId }
      },
      /** Restore the agent-session mapping from the per-analysis settings files. */
      agentSessionsLoaded: (d, sessions) => { d.agentSessions = sessions },
    },
  })
}

/** The store handle type both registrations declare. */
export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>
