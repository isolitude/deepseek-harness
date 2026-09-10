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
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchInjected } from './face.ts'
import {
  analysisWorkspaceCwd,
  missingSnapshotHint,
  type Analysis,
  type ReferenceFile,
} from './load.ts'
import { buildDag, type DagModel } from './presenters.ts'
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
const TABS: ReadonlyArray<{ readonly id: WorkbenchView; readonly labelKey: 'panel.tabs.dag' | 'panel.tabs.docs' }> = [
  { id: 'dag', labelKey: 'panel.tabs.dag' },
  { id: 'docs', labelKey: 'panel.tabs.docs' },
]

/**
 * Render the workbench panel.
 * @param props - the composed overlay props.
 * @returns the panel, or nothing while closed.
 */
export function Workbench(props: WorkbenchOverlayProps): ReactNode {
  const state = props.useStore(s => s)
  const sessionId = props.useSessions(s => s).current
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
    view,
    drawerWidth,
    agentOpen,
    agentCollapsed,
    agent,
    agentSessions,
  } = state

  // Session run flags for agent sessions opened from this panel, keyed by
  // analysis directory. Read once so the list can flag each running agent.
  const sessionsById = props.useSessions(s => s.byId)

  // File reads resolve against a session whose working directory is the LLMPWA
  // workspace root. The active conversation session may be an unrelated nested
  // agent session (e.g. one opened from this panel, whose cwd is the analysis
  // directory), so prefer a session owned by the workspace holding the analyses
  // over the raw "current" session.
  const readWorkspace = sessionId !== undefined
    ? workspaces.find(w => w.sessionIds.includes(sessionId)) ?? workspaces.find(w => w.sessionIds.length > 0)
    : workspaces.find(w => w.sessionIds.length > 0)
  const readSessionId = readWorkspace?.sessionIds[0]
  const workspacePath = readWorkspace?.path

  const listController = useRef<AbortController | undefined>(undefined)
  const snapshotController = useRef<AbortController | undefined>(undefined)
  const refsController = useRef<AbortController | undefined>(undefined)
  const refTextController = useRef<AbortController | undefined>(undefined)
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

  // List analyses when the panel opens or the read session changes. The
  // component never awaits; the face dispatches the result through the store.
  useEffect(() => {
    if (!open || readSessionId === undefined || workspacePath === undefined) return
    listController.current?.abort()
    const controller = new AbortController()
    listController.current = controller
    props.listAnalyses(workspacePath, readSessionId, controller.signal)
    return () => controller.abort()
  }, [open, readSessionId, props.listAnalyses])

  // Load the selected analysis's snapshot when a selection is active.
  useEffect(() => {
    if (!open || readSessionId === undefined || selected === undefined) return
    snapshotController.current?.abort()
    const controller = new AbortController()
    snapshotController.current = controller
    props.loadSnapshot(readSessionId, selected, controller.signal)
    return () => controller.abort()
  }, [open, readSessionId, selected, props.loadSnapshot])

  // List the selected analysis's reference files when a selection is active.
  useEffect(() => {
    if (!open || readSessionId === undefined || selected === undefined) return
    refsController.current?.abort()
    const controller = new AbortController()
    refsController.current = controller
    props.listReferences(readSessionId, selected, controller.signal)
    return () => controller.abort()
  }, [open, readSessionId, selected, props.listReferences])

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
          <button type="button" className={css.close} onClick={() => props.actions.closed()}>
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
                    onClick={() => props.actions.selected(analysis.dir)}
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
                      onClick={() => props.actions.setView(tab.id)}
                    >
                      {props.t(tab.labelKey)}
                    </button>
                  ))}
                </div>
                <div className={css.previewBody} ref={rowRef} data-testid="llmpwa-preview-body">
                  <div className={css.mainPreview}>
                    {view === 'dag'
                      ? snapshotView(snapshot, dag, props.t, retry, selected)
                      : docsView(references, referencesListing, reference, props.t, selectReference)}
                  </div>
                  {agentOpen
                    ? <>
                      {/* Clicking the page behind the floating agent panel
                       * collapses it to a title strip so the DAG stays visible.
                       * The panel itself sits above this backdrop. */}
                      {!agentCollapsed
                        ? <div className={css.drawerBackdrop} onClick={() => props.actions.agentCollapse()} />
                        : null}
                      {agentCollapsed
                        ? <button
                          type="button"
                          className={css.drawerStrip}
                          data-testid="llmpwa-agent-strip"
                          onClick={() => props.actions.agentExpand()}
                        >
                          {props.t('panel.drawerTitle')}
                        </button>
                        : agentDrawer(
                          agent,
                          props.t,
                          openAgent,
                          () => props.actions.closed(),
                          () => props.actions.agentClosed(),
                          agentCwd,
                          sessionId,
                          props.renderSlot,
                          drawerWidth,
                          () => props.actions.agentCollapse(),
                          newAgentSession,
                          beginResize,
                          resize,
                          endResize,
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
            onClick={() => select(ref.path)}
          >
            {ref.name}
          </button>
        ))}
      </div>
      {referencePreview(reference, t, select)}
    </div>
  )
}

/** Render the selected reference file's text phase. */
function referencePreview(
  reference: ReferencePhase,
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
        <button type="button" className={css.refresh} onClick={() => select(reference.path)}>
          {t('panel.error.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className={css.refBody}>
      <ReferenceDocument path={reference.path} text={reference.text} t={t} />
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
              <p className={css.errorLine}>{t('panel.drawerAgentReady')}</p>
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
