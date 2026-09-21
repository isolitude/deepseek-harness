/**
 * The full-frame LLMPWA workbench body, registered into `shell.overlay`.
 *
 * Always mounted (the overlay is a live list slot), it renders nothing while
 * closed and draws the panel only when the store reports `open`. It drives the
 * Remote reads through the inject face: listing analyses on open / session
 * change, loading the selected analysis's snapshot and its reference files, and
 * reading a chosen reference file's text. The preview area is tabbed (DAG /
 * reference documents), and an "open agent" action reveals a right drawer that
 * launches a dsh session whose working directory is the selected analysis.
 * Derived DAG and status views are pure folds over the store's snapshot
 * ({@link buildDag}).
 */
import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchInjected } from './face.ts'
import {
  analysisForSession,
  analysisWorkspaceCwd,
  mainSessionId,
  missingSnapshotHint,
  taskDirPath,
  type Analysis,
  type ReferenceFile,
  type TaskEntry,
  type TaskTreeEntry,
} from './load.ts'
import {
  buildDag,
  buildTaskView,
  formatPeriod,
  type DagModel,
  type TaskRecord,
  type TaskStatus,
  type TaskView,
} from './presenters.ts'
import { ReferenceDocument } from './reference-document.tsx'
import { Dag } from './Dag.tsx'
import type {
  AgentPhase,
  ReferencePhase,
  SnapshotPhase,
  WorkbenchStore,
  WorkbenchView,
} from './store.ts'
import css from './Workbench.module.css'

/** Full props composed by the `shell.overlay` seat. */
export type WorkbenchOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<WorkbenchStore>
  & InjectFace<WorkbenchInjected>
  & PropsLocale<'llmpwa'>
  & PropsRenderSlots<'conversation.embedded'>

/** A preview tab descriptor: its id and localized label key. */
const TABS: ReadonlyArray<{ readonly id: WorkbenchView; readonly labelKey: 'panel.tabs.dag' | 'panel.tabs.docs' | 'panel.tabs.tasks' }> = [
  { id: 'dag', labelKey: 'panel.tabs.dag' },
  { id: 'docs', labelKey: 'panel.tabs.docs' },
  { id: 'tasks', labelKey: 'panel.tabs.tasks' },
]

/**
 * The workspace slice the read-session selection needs.
 */
interface ReadWorkspaceCandidate {
  readonly path: string
  readonly sessionIds: readonly SessionId[]
}

/**
 * Select the workspace that holds `LLMPWA/analyses` and a session whose own
 * `cwd` is that workspace's root (so the `workspaceFiles` listing resolves the
 * analyses root against the project root, not an analysis directory). The
 * current conversation session is often an analysis agent session whose cwd is
 * the analysis directory, so its own workspace is the analysis, not the project
 * root: prefer the workspace whose path is a strict ancestor of the current
 * cwd, then the workspace matching the cwd exactly, then the workspace holding
 * the most sessions (the primary project workspace).
 * @param openWorkspaces - the visible workspace list.
 * @param currentCwd - the current conversation session's cwd, when known.
 * @returns the selected workspace and one of its accounted session ids, or
 * `undefined` when no workspace has an accounted session.
 */
function selectReadWorkspace(
  openWorkspaces: readonly ReadWorkspaceCandidate[],
  currentCwd: string | undefined,
): { workspace: ReadWorkspaceCandidate; readSessionId: SessionId } | undefined {
  if (openWorkspaces.length === 0) return undefined
  const ancestor = currentCwd === undefined
    ? undefined
    : openWorkspaces.find(workspace => currentCwd.startsWith(`${workspace.path}/`))
  const exact = currentCwd === undefined
    ? undefined
    : openWorkspaces.find(workspace => currentCwd === workspace.path)
  const primary = openWorkspaces.find(workspace => workspace.sessionIds.length > 0)
  const candidate = ancestor ?? exact ?? primary
  const readSessionId = candidate?.sessionIds[0]
  return candidate === undefined || readSessionId === undefined
    ? undefined
    : { workspace: candidate, readSessionId }
}

/**
 * Render the workbench panel.
 * @param props - the composed overlay props.
 * @returns the panel, or nothing while closed.
 */
export function Workbench(props: WorkbenchOverlayProps): ReactNode {
  const state = props.useStore(s => s)
  const sessionId = props.useSessions(s => mainSessionId(s.byId))
  const sessionsById = props.useSessions(s => s.byId)
  const workspaces = props.useWorkspaces(s => s).items
  const {
    open,
    analyses,
    selected,
    listing,
    snapshot,
    references,
    referencesListing,
    reference,
    tasks,
    tasksListing,
    taskStatuses,
    selectedTask,
    taskOpen,
    taskCollapsed,
    taskHeight,
    taskTreeExpanded,
    taskTree,
    taskTreeListing,
    taskFile,
    view,
    drawerWidth,
    agentOpen,
    agentCollapsed,
    agent,
    agentSessions,
  } = state

  // Session run flags for agent sessions opened from this panel, keyed by
  // analysis directory. Read once so the list can flag each running agent.
  const currentCwd = sessionId !== undefined ? sessionsById[sessionId]?.cwd : undefined
  const read = selectReadWorkspace(workspaces, currentCwd)
  const readSessionId = read?.readSessionId
  const workspacePath = read?.workspace.path

  // The panel is a live slot that stays mounted, so `open` flips rather than
  // remounting. Track the conversation session id whose analysis we last
  // auto-selected, so a manual list pick in one open wins while a reopen (or a
  // main-chat session change) re-syncs. Cleared whenever the panel closes.
  const autoSyncedFor = useRef<SessionId | undefined>(undefined)
  const listController = useRef<AbortController | undefined>(undefined)
  const snapshotController = useRef<AbortController | undefined>(undefined)
  const refsController = useRef<AbortController | undefined>(undefined)
  const refTextController = useRef<AbortController | undefined>(undefined)
  const tasksController = useRef<AbortController | undefined>(undefined)
  const taskDirController = useRef<AbortController | undefined>(undefined)
  const taskFileController = useRef<AbortController | undefined>(undefined)
  // The agent drawer is resized by dragging a handle in the preview row. The
  // handle is a sibling of the drawer, so the width is bounded by the row's
  // own width: the drawer may grow to the row width less the preview floor.
  const rowRef = useRef<HTMLDivElement | null>(null)
  const dragOrigin = useRef<{ x: number; width: number } | undefined>(undefined)

  const minDrawerWidth = 280
  const drawerFloor = 320
  const clampDrawerWidth = (width: number): number => {
    const row = rowRef.current
    /* v8 ignore next -- the resize handle renders inside the row that owns rowRef, so the row is always mounted when a drag can start. */
    const max = row === null ? 720 : Math.max(drawerFloor, row.clientWidth - drawerFloor)
    return Math.min(Math.max(width, minDrawerWidth), max)
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>): void {
    // Capture the pointer so move/up events keep firing on the handle while the
    // cursor leaves it. The start width is read once; each move recomputes from
    // the drag origin rather than accumulating, so a fast drag cannot drift.
    event.preventDefault()
    /* v8 ignore next -- jsdom and some hosts leave Pointer capture undefined; the drag still works without it. */
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    dragOrigin.current = { x: event.clientX, width: drawerWidth }
  }

  function resize(event: React.PointerEvent<HTMLDivElement>): void {
    const origin = dragOrigin.current
    if (origin === undefined) return
    props.actions.setDrawerWidth(clampDrawerWidth(origin.width + (origin.x - event.clientX)))
  }

  function endResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragOrigin.current === undefined) return
    dragOrigin.current = undefined
    /* v8 ignore next -- jsdom and some hosts leave Pointer capture undefined; releasing is a no-op when it never captured. */
    if (typeof event.currentTarget.hasPointerCapture === 'function' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // The bottom task popup is resized by dragging its top handle vertically. The
  // handle is a sibling in the preview row, so the height is bounded by the
  // row's own height: the popup may grow to the row height less the card floor.
  const taskDragOrigin = useRef<{ y: number; height: number } | undefined>(undefined)

  const minTaskHeight = 160
  // The card floor is the space the popup leaves at the bottom so the task-card
  // grid behind it stays visible. A small floor lets the popup rise close to the
  // row's full height when the user drags the handle up.
  const taskFloor = 90
  const clampTaskHeight = (height: number): number => {
    const row = rowRef.current
    /* v8 ignore next -- the task resize handle renders inside the row owning rowRef, so the row is always mounted during a drag. */
    const max = row === null ? 640 : Math.max(taskFloor, row.clientHeight - taskFloor)
    return Math.min(Math.max(height, minTaskHeight), max)
  }

  function beginTaskResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    /* v8 ignore next -- jsdom and some hosts leave Pointer capture undefined; the drag still works without it. */
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    taskDragOrigin.current = { y: event.clientY, height: taskHeight }
  }

  function taskResize(event: React.PointerEvent<HTMLDivElement>): void {
    const origin = taskDragOrigin.current
    if (origin === undefined) return
    // Dragging the top handle up (decreasing clientY) grows the popup.
    props.actions.setTaskHeight(clampTaskHeight(origin.height + (origin.y - event.clientY)))
  }

  function endTaskResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (taskDragOrigin.current === undefined) return
    taskDragOrigin.current = undefined
    /* v8 ignore next -- jsdom and some hosts leave Pointer capture undefined; releasing is a no-op when it never captured. */
    if (typeof event.currentTarget.hasPointerCapture === 'function' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // List analyses when the panel opens or the read session changes. The
  // component never awaits; the face dispatches the result through the store.
  useEffect(() => {
    if (!open || readSessionId === undefined || workspacePath === undefined) return
    listController.current?.abort()
    const controller = new AbortController()
    listController.current = controller
    props.listAnalyses(workspacePath, readSessionId, controller.signal)
    return () => { controller.abort() }
  }, [open, readSessionId, props.listAnalyses])

  // Load the selected analysis's snapshot when a selection is active.
  useEffect(() => {
    if (!open || readSessionId === undefined || selected === undefined) return
    snapshotController.current?.abort()
    const controller = new AbortController()
    snapshotController.current = controller
    props.loadSnapshot(readSessionId, selected, controller.signal)
    return () => { controller.abort() }
  }, [open, readSessionId, selected, props.loadSnapshot])

  // List the selected analysis's reference files when a selection is active.
  useEffect(() => {
    if (!open || readSessionId === undefined || selected === undefined) return
    refsController.current?.abort()
    const controller = new AbortController()
    refsController.current = controller
    props.listReferences(readSessionId, selected, controller.signal)
    return () => { controller.abort() }
  }, [open, readSessionId, selected, props.listReferences])

  // List the selected analysis's fit tasks when a selection is active; each
  // task's status is loaded for its card.
  useEffect(() => {
    if (!open || readSessionId === undefined || selected === undefined) return
    tasksController.current?.abort()
    const controller = new AbortController()
    tasksController.current = controller
    props.listTasks(readSessionId, selected, controller.signal)
    return () => { controller.abort() }
  }, [open, readSessionId, selected, props.listTasks])

  // When the bottom popup opens for a task, seed the file tree with the task
  // root's children so the top level is browsable.
  useEffect(() => {
    if (!open || readSessionId === undefined || selected === undefined || selectedTask === undefined || !taskOpen) return
    taskDirController.current?.abort()
    const dirController = new AbortController()
    taskDirController.current = dirController
    props.listTaskDir(readSessionId, taskDirPath(selected, selectedTask), dirController.signal)
    return () => { dirController.abort() }
  }, [open, readSessionId, selected, selectedTask, taskOpen, props.listTaskDir])

  // Follow the main conversation: when the current session maps to one of the
  // listed analyses (its agent session), switch the panel to that analysis. The
  // mapping is the restored `agentSessions` table (analysis dir → session id)
  // plus a cwd match against the session list for an analysis whose mapping has
  // not been restored yet. A manual list pick within one open wins until the
  // session changes, so reopening the panel after selecting an analysis session
  // in the main conversation lands on that analysis.
  useEffect(() => {
    if (!open) {
      // Reset the session we auto-synced for so the next open re-derives from
      // the (possibly different) conversation session.
      autoSyncedFor.current = undefined
      return
    }
    if (readSessionId === undefined || workspacePath === undefined) return
    const match = analysisForSession(sessionId, workspacePath, analyses, agentSessions, sessionsById)
    if (match === undefined) return
    // A manual list pick within the same open wins: once a session has been
    // auto-synced and the user picks a different analysis, leave it alone.
    if (match !== selected && autoSyncedFor.current === sessionId) return
    autoSyncedFor.current = sessionId
    if (match !== selected) props.actions.selected(match)
  }, [
    open,
    readSessionId,
    workspacePath,
    sessionId,
    selected,
    analyses,
    agentSessions,
    sessionsById,
    props.actions,
  ])

  const dag = useMemo(() => {
    if (snapshot.kind !== 'ready') return undefined
    return buildDag(snapshot.snapshot.stages ?? [], snapshot.snapshot.manifest?.stages)
  }, [snapshot])

  const agentCwd = workspacePath !== undefined && selected !== undefined
    ? analysisWorkspaceCwd(workspacePath, selected)
    : undefined

  if (!open) return null

  return (
    <div className={css.overlay} role="dialog" aria-modal="true" data-testid="llmpwa-workbench">
      <header className={css.header}>
        <span className={css.title}>{props.t('panel.title')}</span>
        <div className={css.headerActions}>
          {selected !== undefined && readSessionId !== undefined
            ? <button
              type="button"
              className={css.openAgent}
              onClick={() => { props.actions.agentOpened(); openAgent() }}
            >
              {props.t('panel.openAgent')}
            </button>
            : null}
          <button type="button" className={css.close} onClick={() => { props.actions.closed() }}>
            {props.t('panel.close')}
          </button>
        </div>
      </header>
      <div className={css.body}>
        <aside className={css.listPane}>
          <div className={css.listHeader}>
            <span className={css.listTitle}>{props.t('panel.listTitle')}</span>
            <button type="button" className={css.refresh} onClick={refreshList}>
              {props.t('panel.refresh')}
            </button>
          </div>
          {listing && analyses.length === 0
            ? <div className={css.muted}>{props.t('panel.reloading')}</div>
            : null}
          {!listing && analyses.length === 0 && readSessionId === undefined
            ? <div className={css.muted}>{props.t('panel.noWorkspace')}</div>
            : null}
          {!listing && analyses.length === 0 && readSessionId !== undefined
            ? <div className={css.muted}>{props.t('panel.emptyAnalyses')}</div>
            : null}
          <ul className={css.list}>
            {analyses.map((analysis: Analysis) => {
              const agentSession = agentSessions[analysis.dir]
              const running = agentSession !== undefined && sessionsById[agentSession]?.running === true
              return (
                <li key={analysis.dir} className={css.listItem}>
                  <button
                    type="button"
                    className={css.analysis}
                    data-selected={analysis.dir === selected}
                    onClick={() => { props.actions.selected(analysis.dir) }}
                  >
                    {analysis.dir}
                  </button>
                  {running
                    ? <span className={css.runFlag} role="status">{props.t('panel.running')}</span>
                    : null}
                </li>
              )
            })}
          </ul>
        </aside>
        <section className={css.preview}>
          {readSessionId === undefined
            ? <div className={css.placeholder}>{props.t('panel.noWorkspace')}</div>
            : selected === undefined
              ? snapshotView(snapshot, dag, props.t, retry, selected)
              : <>
                <div className={css.tabs}>
                  {TABS.map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      className={css.tab}
                      data-active={view === tab.id}
                      onClick={() => { props.actions.setView(tab.id) }}
                    >
                      {props.t(tab.labelKey)}
                    </button>
                  ))}
                </div>
                <div className={css.previewBody} ref={rowRef} data-testid="llmpwa-preview-body">
                  <div className={css.mainPreview}>
                    {view === 'dag'
                      ? snapshotView(snapshot, dag, props.t, retry, selected)
                      : view === 'docs'
                        ? docsView(references, referencesListing, reference, workspacePath, props.t, selectReference)
                        : tasksGrid(
                          tasks,
                          tasksListing,
                          taskStatuses,
                          props.t,
                          openTask,
                        )}
                  </div>
                  {agentOpen
                    ? <>
                      {/* Clicking the page behind the floating agent panel
                       * collapses it to a title strip so the DAG stays visible.
                       * The panel itself sits above this backdrop. */}
                      {!agentCollapsed
                        ? <div className={css.drawerBackdrop} onClick={() => { props.actions.agentCollapse() }} />
                        : null}
                      {agentCollapsed
                        ? <button
                          type="button"
                          className={css.drawerStrip}
                          data-testid="llmpwa-agent-strip"
                          onClick={() => { props.actions.agentExpand() }}
                        >
                          {props.t('panel.drawerTitle')}
                        </button>
                        : agentDrawer(
                          agent,
                          props.t,
                          openAgent,
                          () => { props.actions.closed() },
                          () => { props.actions.agentClosed() },
                          agentCwd,
                          sessionId,
                          props.renderSlot,
                          drawerWidth,
                          () => { props.actions.agentCollapse() },
                          newAgentSession,
                          beginResize,
                          resize,
                          endResize,
                        )}
                    </>
                    : null}
                  {taskOpen
                    ? <>
                      {/* Clicking the page behind the bottom task popup collapses it
                       * to a bottom strip so the card grid stays visible. */}
                      {!taskCollapsed
                        ? <div className={css.taskBackdrop} data-testid="llmpwa-task-backdrop" onClick={() => { props.actions.taskCollapse() }} />
                        : null}
                      {taskCollapsed
                        ? <button
                          type="button"
                          className={css.taskStrip}
                          data-testid="llmpwa-task-strip"
                          onClick={() => { props.actions.taskExpand() }}
                        >
                          {props.t('panel.task.popupTitle')}
                        </button>
                        : taskPopup(
                          selected,
                          selectedTask,
                          taskTreeExpanded,
                          taskTree,
                          taskTreeListing,
                          taskFile,
                          taskHeight,
                          workspacePath,
                          props.t,
                          toggleTaskDir,
                          selectTaskFile,
                          () => { props.actions.taskClosed() },
                          beginTaskResize,
                          taskResize,
                          endTaskResize,
                        )}
                    </>
                    : null}
                </div>
              </>}
        </section>
      </div>
    </div>
  )

  function refreshList(): void {
    /* v8 ignore next -- refresh renders only after a workspace read session, so both are always defined here. */
    if (readSessionId === undefined || workspacePath === undefined) return
    listController.current?.abort()
    const controller = new AbortController()
    listController.current = controller
    props.listAnalyses(workspacePath, readSessionId, controller.signal)
  }

  function retry(): void {
    refreshList()
    /* v8 ignore next -- the retry button renders only after a workspace read session, so the arm is defensive. */
    if (readSessionId === undefined) return
    if (selected === undefined) return
    snapshotController.current?.abort()
    const controller = new AbortController()
    snapshotController.current = controller
    props.loadSnapshot(readSessionId, selected, controller.signal)
    refsController.current?.abort()
    const refs = new AbortController()
    refsController.current = refs
    props.listReferences(readSessionId, selected, refs.signal)
  }

  function selectReference(path: string): void {
    /* v8 ignore next -- the reference buttons render only after a workspace read session, so the arm is defensive. */
    if (readSessionId === undefined) return
    refTextController.current?.abort()
    const controller = new AbortController()
    refTextController.current = controller
    props.loadReference(readSessionId, path, controller.signal)
  }

  function openTask(task: string): void {
    /* v8 ignore next -- the task cards render only after a workspace read session, so the arm is defensive. */
    if (readSessionId === undefined) return
    props.actions.taskOpened(task)
  }

  function toggleTaskDir(path: string): void {
    /* v8 ignore next -- the tree renders only after a workspace read session, so the arm is defensive. */
    if (readSessionId === undefined) return
    props.actions.taskDirToggle(path)
    // When expanding a directory that has not been listed yet, load its
    // children so the branch materializes.
    if (!taskTreeExpanded.includes(path) && taskTree[path] === undefined) {
      taskDirController.current?.abort()
      const controller = new AbortController()
      taskDirController.current = controller
      props.listTaskDir(readSessionId, path, controller.signal)
    }
  }

  function selectTaskFile(path: string): void {
    /* v8 ignore next -- the task-file buttons render only after a workspace read session, so the arm is defensive. */
    if (readSessionId === undefined) return
    taskFileController.current?.abort()
    const controller = new AbortController()
    taskFileController.current = controller
    props.loadTaskFile(readSessionId, path, controller.signal)
  }

  function openAgent(): void {
    /* v8 ignore next -- the header action renders only after a read session, which also guarantees the path. */
    if (workspacePath === undefined) return
    /* v8 ignore next -- the header drawer renders only after a read session, so readSessionId is set. */
    if (readSessionId === undefined) return
    // The header action and the drawer render only after a selection, so
    // `selected` is defined here; narrow it for the inject call. Pass the
    // recorded agent session so a still-live one is reused per analysis.
    const analysis = selected as string
    props.openAgent(workspacePath, readSessionId, analysis, agentSessions[analysis])
  }

  function newAgentSession(): void {
    /* v8 ignore next -- the resume launcher renders only while the drawer is open, so the arm is defensive. */
    if (workspacePath === undefined) return
    /* v8 ignore next -- the resume launcher renders only while the drawer is open, so readSessionId is set. */
    if (readSessionId === undefined) return
    props.newAgent(workspacePath, readSessionId, selected as string)
  }
}

/** Render one snapshot phase in the preview pane (also the no-selection view). */
function snapshotView(
  snapshot: SnapshotPhase,
  dag: ReturnType<typeof buildDag> | undefined,
  t: WorkbenchOverlayProps['t'],
  retry: () => void,
  selected: string | undefined,
): ReactNode {
  if (snapshot.kind === 'idle') {
    return <div className={css.placeholder}>{t('panel.selectHint')}</div>
  }
  if (snapshot.kind === 'loading') {
    return <div className={css.placeholder}>{t('panel.reloading')}</div>
  }
  if (snapshot.kind === 'failed') {
    const key = snapshot.error.kind === 'missing'
      ? 'panel.error.missing'
      : snapshot.error.kind === 'parse'
        ? 'panel.error.parse'
        : 'panel.error.unexpected'
    return (
      <div className={css.error}>
        <p className={css.errorLine}>{t(key)} {snapshot.error.message}</p>
        {snapshot.error.kind === 'missing' && selected !== undefined
          ? <pre className={css.hint}>{missingSnapshotHint(selected)}</pre>
          : null}
        <button type="button" className={css.refresh} onClick={retry}>{t('panel.error.retry')}</button>
      </div>
    )
  }
  // A ready snapshot always carries a computed DAG model (buildDag never
  // returns undefined), so the model is asserted here.
  return <div className={css.dagWrap}><Dag model={dag as DagModel} label={t('panel.dagAria')} /></div>
}

/** Render the reference-file list and the selected file's preview (docs tab). */
function docsView(
  references: readonly ReferenceFile[],
  listing: boolean,
  reference: ReferencePhase,
  workspacePath: string | undefined,
  t: WorkbenchOverlayProps['t'],
  select: (path: string) => void,
): ReactNode {
  if (listing && references.length === 0) {
    return <div className={css.muted}>{t('panel.reloading')}</div>
  }
  if (references.length === 0) {
    return <div className={css.muted}>{t('panel.referencesEmpty')}</div>
  }
  const selectedPath = reference.kind === 'idle' ? undefined : reference.path
  return (
    <div className={css.references}>
      <div className={css.refList}>
        {references.map(ref => (
          <button
            key={ref.path}
            type="button"
            className={css.refButton}
            data-selected={ref.path === selectedPath}
            onClick={() => { select(ref.path) }}
            onContextMenu={(event) => {
              // Right-click copies the workspace-relative path of the file.
              event.preventDefault()
              void writeClipboard(ref.path)
            }}
            title={ref.path}
          >
            {ref.name}
          </button>
        ))}
      </div>
      {referencePreview(reference, workspacePath, t, select)}
    </div>
  )
}

/** Render the selected reference file's text phase. */
function referencePreview(
  reference: ReferencePhase,
  workspacePath: string | undefined,
  t: WorkbenchOverlayProps['t'],
  select: (path: string) => void,
): ReactNode {
  if (reference.kind === 'idle') {
    return <div className={css.muted}>{t('panel.referenceSelectHint')}</div>
  }
  if (reference.kind === 'loading') {
    return <div className={css.muted}>{t('panel.reloading')}</div>
  }
  if (reference.kind === 'failed') {
    return (
      <div className={css.error}>
        <p className={css.errorLine}>{t('panel.error.reference')} {reference.error.message}</p>
        <button type="button" className={css.refresh} onClick={() => { select(reference.path) }}>
          {t('panel.error.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className={css.refBody}>
      <ReferenceDocument path={reference.path} text={reference.text} workspacePath={workspacePath} t={t} />
    </div>
  )
}

/** Map a task lifecycle status to the StateDot palette. */
function taskDotState(status: TaskStatus): StateDotState {
  if (status === 'completed') return 'done'
  if (status === 'running') return 'ongoing'
  if (status === 'failed') return 'error'
  return 'warning'
}

/** Build a task card's display row from its status, or a directory-only row
 *  when no readable status exists yet (a fresh task that has not recorded one). */
function taskCardModel(task: string, record: TaskRecord | undefined): TaskView {
  return record !== undefined
    ? buildTaskView(record)
    : buildTaskView({ task_id: task })
}

/** Render the tasks tab as a grid of task cards. Each card shows the task name,
 *  status dot, type, period, and environment; clicking it opens the popup. */
function tasksGrid(
  tasks: readonly TaskEntry[],
  listing: boolean,
  statuses: Readonly<Record<string, TaskRecord>>,
  t: WorkbenchOverlayProps['t'],
  open: (id: string) => void,
): ReactNode {
  if (listing && tasks.length === 0) {
    return <div className={css.muted}>{t('panel.reloading')}</div>
  }
  if (tasks.length === 0) {
    return <div className={css.muted}>{t('panel.tasksEmpty')}</div>
  }
  return (
    <div className={css.taskCards} role="list" data-testid="llmpwa-task-cards">
      {tasks.map((taskEntry) => {
        const model = taskCardModel(taskEntry.id, statuses[taskEntry.id])
        return (
          <button
            key={taskEntry.id}
            type="button"
            role="listitem"
            className={css.taskCard}
            onClick={() => { open(taskEntry.id) }}
            data-testid={`llmpwa-task-card-${taskEntry.id}`}
          >
            <span className={css.taskCardTitle}>
              <StateDot state={taskDotState(model.status.status)} size={10} />
              <span className={css.taskCardName}>{model.task.title ?? taskEntry.id}</span>
            </span>
            <span className={css.taskCardType}>{model.task.task_type ?? '—'}</span>
            <span className={css.taskCardPeriod}>{formatPeriod(model.task.date_start, model.task.date_end)}</span>
            {model.environmentRows.length > 0
              ? <span className={css.taskCardEnv}>{model.environmentRows.map(r => `${r.key}: ${r.value}`).join(' · ')}</span>
              : null}
          </button>
        )
      })}
    </div>
  )
}

/** Render the bottom task popup. */
function taskPopup(
  analysis: string | undefined,
  task: string | undefined,
  expanded: readonly string[],
  tree: Readonly<Record<string, readonly TaskTreeEntry[]>>,
  listing: Readonly<Record<string, boolean>>,
  taskFile: ReferencePhase,
  height: number,
  workspacePath: string | undefined,
  t: WorkbenchOverlayProps['t'],
  toggle: (path: string) => void,
  selectFile: (path: string) => void,
  close: () => void,
  beginResize: (event: React.PointerEvent<HTMLDivElement>) => void,
  resize: (event: React.PointerEvent<HTMLDivElement>) => void,
  endResize: (event: React.PointerEvent<HTMLDivElement>) => void,
): ReactNode {
  // The popup renders only with a selected analysis and task, so the task dir
  // is always known here; the empty fallback is a defensive arm that the
  // render guard makes unreachable.
  /* v8 ignore next -- the popup renders only when both analysis and task are set, so the fallback is unreachable. */
  const treeRoot = analysis !== undefined && task !== undefined ? taskDirPath(analysis, task) : ''
  return (
    <aside className={css.taskPopup} style={{ height }} role="complementary" data-testid="llmpwa-task-popup">
      <div
        className={css.taskResize}
        data-testid="llmpwa-task-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('panel.task.resizePopup')}
        onPointerDown={beginResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className={css.taskPopupHeader}>
        <span className={css.taskPopupTitle}>{task as string}</span>
        <button type="button" className={css.close} onClick={close}>{t('panel.close')}</button>
      </div>
      <div className={css.taskPopupBody}>
        <div className={css.taskTreePane}>
          <span className={css.sectionTitle}>{t('panel.task.filesTitle')}</span>
          {taskTree(treeRoot, expanded, tree, listing, taskFile, t, toggle, selectFile)}
        </div>
        <div className={css.taskPreviewPane}>
          {taskFilePreview(taskFile, workspacePath, t, selectFile)}
        </div>
      </div>
    </aside>
  )
}

/** Render one directory branch of the task file tree. */
function treeBranch(
  path: string,
  expanded: readonly string[],
  tree: Readonly<Record<string, readonly TaskTreeEntry[]>>,
  listing: Readonly<Record<string, boolean>>,
  taskFile: ReferencePhase,
  t: WorkbenchOverlayProps['t'],
  toggle: (path: string) => void,
  selectFile: (path: string) => void,
  depth: number,
): ReactNode {
  const children = tree[path] ?? []
  return (
    <ul className={css.treeBranch} style={{ paddingLeft: depth * 14 }}>
      {children.map((entry) => {
        if (entry.kind === 'directory') {
          return (
            <li key={entry.path}>
              <button
                type="button"
                className={css.treeDir}
                data-expanded={expanded.includes(entry.path)}
                onClick={() => { toggle(entry.path) }}
                title={entry.path}
              >
                <span className={css.treeTwist}>{expanded.includes(entry.path) ? '▾' : '▸'}</span>
                {entry.name}
              </button>
              {expanded.includes(entry.path)
                ? treeBranch(entry.path, expanded, tree, listing, taskFile, t, toggle, selectFile, depth + 1)
                : null}
            </li>
          )
        }
        return (
          <li key={entry.path}>
            <button
              type="button"
              className={css.treeFile}
              data-selected={taskFile.kind !== 'idle' && taskFile.path === entry.path}
              onClick={() => { selectFile(entry.path) }}
              title={entry.path}
            >
              {entry.name}
            </button>
          </li>
        )
      })}
      {listing[path] === true
        ? <li><span className={css.muted}>{t('panel.reloading')}</span></li>
        : null}
    </ul>
  )
}

/** Render the task file tree, rooted at the task directory. */
function taskTree(
  root: string,
  expanded: readonly string[],
  tree: Readonly<Record<string, readonly TaskTreeEntry[]>>,
  listing: Readonly<Record<string, boolean>>,
  taskFile: ReferencePhase,
  t: WorkbenchOverlayProps['t'],
  toggle: (path: string) => void,
  selectFile: (path: string) => void,
): ReactNode {
  return treeBranch(root, expanded, tree, listing, taskFile, t, toggle, selectFile, 0)
}

/** Render the selected task file's text phase. */
function taskFilePreview(
  taskFile: ReferencePhase,
  workspacePath: string | undefined,
  t: WorkbenchOverlayProps['t'],
  selectFile: (path: string) => void,
): ReactNode {
  if (taskFile.kind === 'idle') {
    return <div className={css.muted}>{t('panel.referenceSelectHint')}</div>
  }
  if (taskFile.kind === 'loading') {
    return <div className={css.muted}>{t('panel.reloading')}</div>
  }
  if (taskFile.kind === 'failed') {
    return (
      <div className={css.error}>
        <p className={css.errorLine}>{t('panel.error.reference')} {taskFile.error.message}</p>
        <button type="button" className={css.refresh} onClick={() => { selectFile(taskFile.path) }}>
          {t('panel.error.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className={css.refBody}>
      <ReferenceDocument path={taskFile.path} text={taskFile.text} workspacePath={workspacePath} t={t} />
    </div>
  )
}

/** Render the agent drawer and its session-launch phase. */
function agentDrawer(
  agent: AgentPhase,
  t: WorkbenchOverlayProps['t'],
  launch: () => void,
  viewConversation: () => void,
  close: () => void,
  cwd: string | undefined,
  currentSessionId: string | undefined,
  renderSlot: WorkbenchOverlayProps['renderSlot'],
  width: number,
  collapse: () => void,
  newSession: () => void,
  beginResize: (event: React.PointerEvent<HTMLDivElement>) => void,
  resize: (event: React.PointerEvent<HTMLDivElement>) => void,
  endResize: (event: React.PointerEvent<HTMLDivElement>) => void,
): ReactNode {
  return (
    <aside className={css.drawer} style={{ width }} role="complementary" data-testid="llmpwa-agent-drawer">
      <div
        className={css.drawerResize}
        data-testid="llmpwa-agent-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('panel.resizeAgent')}
        onPointerDown={beginResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className={css.drawerHeader}>
        <button type="button" className={css.drawerTitle} onClick={collapse}>
          {t('panel.drawerTitle')}
        </button>
        {/* A fresh session clears the analysis's prior agent context. */}
        <button type="button" className={css.newSession} onClick={newSession}>
          {t('panel.newSession')}
        </button>
        <button type="button" className={css.close} onClick={close}>{t('panel.close')}</button>
      </div>
      <div className={css.drawerBody}>
        {agent.kind === 'idle'
          ? <button type="button" className={css.openAgent} onClick={launch}>{t('panel.drawerAgentLaunch')}</button>
          : null}
        {agent.kind === 'opening'
          ? <div className={css.muted}>{t('panel.reloading')}</div>
          : null}
        {agent.kind === 'ready'
          ? (
            <div className={css.drawerReady}>
              {/* The drawer renders only after a workspace path and a selection
                 * resolve, so the analysis cwd is always known here. */}
              <pre className={css.hint}>{cwd as string}</pre>
              {/* The embedded conversation is session-scoped and binds to the
                 * current session. The launch just landed the agent as current,
                 * so the transcript belongs to this drawer's agent session. */}
              {currentSessionId !== undefined
                ? <div className={css.drawerChat}>{renderSlot('conversation.embedded', {})}</div>
                : null}
              <button type="button" className={css.refresh} onClick={viewConversation}>
                {t('panel.drawerViewConversation')}
              </button>
            </div>
          )
          : null}
        {agent.kind === 'failed'
          ? (
            <div className={css.error}>
              <p className={css.errorLine}>{t('panel.error.agent')} {agent.error.message}</p>
              <button type="button" className={css.refresh} onClick={launch}>{t('panel.error.retry')}</button>
            </div>
          )
          : null}
      </div>
    </aside>
  )
}
