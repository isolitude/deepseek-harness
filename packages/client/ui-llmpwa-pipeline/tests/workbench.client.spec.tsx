/**
 * The full-frame workbench body: draws nothing while closed, lists analyses on
 * open, loads the selected snapshot, renders each snapshot phase, switches the
 * preview tabs, and drives the reference preview and agent drawer.
 *
 * Props are fed directly: a real store instance with plain selector stubs, a
 * session list stub, a workspace stub, and the inject callbacks as spies. The
 * component's effects run under the real React renderer, so mount-time listing
 * and selection loading are exercised.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Workbench, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { PipelineSnapshot } from '../src/client/presenters.ts'

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn(async () => true) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return { ...actual, writeClipboard: clipboard.writeClipboard }
})

afterEach(() => {
  cleanup()
})

const snapshot: PipelineSnapshot = {
  schema_version: 1,
  stages: [{ name: 'a', kind: 'python', dependencies: [] }],
  manifest: { stages: { a: { present: true, status: 'ran' } } },
}

function makeProps(options: {
  session?: string | undefined
  sessionIds?: string[]
  running?: string[]
  byId?: Record<string, { running?: boolean; cwd?: string }>
  workspaces?: Array<{ path: string; sessionIds: string[] }>
} = {}): {
  props: WorkbenchOverlayProps
  instance: ReturnType<ReturnType<typeof createWorkbenchStore>['create']>
  listAnalyses: ReturnType<typeof vi.fn>
  loadSnapshot: ReturnType<typeof vi.fn>
  listReferences: ReturnType<typeof vi.fn>
  loadReference: ReturnType<typeof vi.fn>
  listTasks: ReturnType<typeof vi.fn>
  listTaskDir: ReturnType<typeof vi.fn>
  loadTaskFile: ReturnType<typeof vi.fn>
  openAgent: ReturnType<typeof vi.fn>
  newAgent: ReturnType<typeof vi.fn>
} {
  const instance = createWorkbenchStore().create()
  const listAnalyses = vi.fn()
  const loadSnapshot = vi.fn()
  const listReferences = vi.fn()
  const loadReference = vi.fn()
  const listTasks = vi.fn()
  const listTaskDir = vi.fn()
  const loadTaskFile = vi.fn()
  const openAgent = vi.fn()
  const newAgent = vi.fn()
  const session = 'session' in options ? options.session : 's1'
  const sessionIds = 'sessionIds' in options
    ? options.sessionIds
    : (session === undefined ? [] : [session])
  const running = 'running' in options ? options.running : []
  // The workbench follows the main conversation: the row the main view owns.
  // `retainedBy.mainView` marks it; `byId` keeps a row for any non-main session
  // so the cwd match can still select the project workspace.
  const byIdSource = options.byId ?? Object.fromEntries(
    sessionIds.map(id => [id, { running: running.includes(id) }]),
  )
  const mainRow = session === undefined
    ? undefined
    : { ...(byIdSource[session] ?? {}), running: running.includes(session), retainedBy: { mainView: 1 } }
  const rows: Record<string, { running?: boolean; cwd?: string; retainedBy?: { mainView: number } }> = {
    ...byIdSource,
    ...(session === undefined ? {} : { [session]: mainRow! }),
  }
  // The stub also serves the `useSessions(s => s.byId)` read, so `cwd` arrives
  // on the main row through the caller-provided byId.
  const props = {
    // A reactive store seat so store-mutating actions re-render the panel, as
    // the slot runtime's observableHook does.
    useStore: (sel: (s: ReturnType<typeof instance.getSnapshot>) => unknown) =>
      useSyncExternalStore(listener => instance.subscribe(listener), () => sel(instance.getSnapshot())),
    useSessions: (sel: (s: {
      byId: Record<string, { running?: boolean; cwd?: string; retainedBy?: { mainView: number } }>
    }) => unknown) => sel({ byId: rows }),
    useWorkspaces: (sel: (s: { items: Array<{ path: string; sessionIds: string[] }> }) => unknown) =>
      sel({ items: options.workspaces ?? [{ path: '/ws', sessionIds }] }),
    actions: instance.actions,
    t: (key: string) => key,
    listAnalyses,
    loadSnapshot,
    listReferences,
    loadReference,
    listTasks,
    listTaskDir,
    loadTaskFile,
    openAgent,
    newAgent,
    // The drawer renders a live conversation.visible conversation; the spec
    // stubs renderSlot to assert the slot is requested for the agent session.
    renderSlot: (_key: string) => <div data-testid="embedded-chat-stub" />,
  } as unknown as WorkbenchOverlayProps
  return {
    props, instance, listAnalyses, loadSnapshot, listReferences, loadReference,
    listTasks, listTaskDir, loadTaskFile, openAgent, newAgent,
  }
}

const openDocs = (): void => { fireEvent.click(screen.getByRole('button', { name: 'panel.tabs.docs' })) }
const openTasks = (): void => { fireEvent.click(screen.getByRole('button', { name: 'panel.tabs.tasks' })) }

describe('Workbench', () => {
  it('renders nothing while closed', () => {
    const { props } = makeProps()
    render(<Workbench {...props} />)
    expect(screen.queryByTestId('llmpwa-workbench')).toBeNull()
  })

  it('lists analyses on open and renders them', () => {
    const { props, instance, listAnalyses } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    render(<Workbench {...props} />)
    expect(listAnalyses).toHaveBeenCalledWith('/ws', 's1', expect.any(AbortSignal))
    expect(screen.getByRole('button', { name: 'kk_dis' })).toBeTruthy()
  })

  it('resolves the analyses against the project workspace, not the current analysis workspace', () => {
    // The current conversation session is an analysis agent session (its cwd is
    // the analysis directory), now grouped into the analysis workspace. The
    // workbench must still read `LLMPWA/analyses` from the project root, so it
    // uses a session whose cwd is the project workspace, not the analysis one.
    const { props, instance, listAnalyses } = makeProps({
      session: 'agent-session',
      byId: { 'agent-session': { cwd: '/ws/LLMPWA/analyses/kk_dis' }, 'root-session': { cwd: '/ws' } },
      workspaces: [
        { path: '/ws', sessionIds: ['root-session'] },
        { path: '/ws/LLMPWA/analyses/kk_dis', sessionIds: ['agent-session'] },
      ],
    })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    render(<Workbench {...props} />)
    expect(listAnalyses).toHaveBeenCalledWith('/ws', 'root-session', expect.any(AbortSignal))
  })

  it('falls back to a primary workspace session when the current cwd matches no workspace', () => {
    const { props, instance, listAnalyses } = makeProps({
      session: 'unrelated',
      byId: { unrelated: { cwd: '/elsewhere' }, 'root-session': { cwd: '/ws' } },
      workspaces: [
        { path: '/ws', sessionIds: ['root-session'] },
        { path: '/ws/LLMPWA/analyses/kk_dis', sessionIds: ['agent-session'] },
      ],
    })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    render(<Workbench {...props} />)
    expect(listAnalyses).toHaveBeenCalledWith('/ws', 'root-session', expect.any(AbortSignal))
  })

  it('renders the selected analysis DAG from a ready snapshot', () => {
    const { props, instance, listAnalyses, loadSnapshot } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.snapshotReady(snapshot)
    render(<Workbench {...props} />)
    expect(loadSnapshot).toHaveBeenCalledWith('s1', 'kk_dis', expect.any(AbortSignal))
    expect(screen.getByTestId('llmpwa-dag')).toBeTruthy()
    expect(listAnalyses).toHaveBeenCalled()
  })

  it('shows a select hint before any analysis snapshot loads', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    render(<Workbench {...props} />)
    expect(screen.getByText('panel.selectHint')).toBeTruthy()
  })

  it('shows the loading text while a snapshot read is in flight', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.snapshotLoading()
    render(<Workbench {...props} />)
    expect(screen.getByText('panel.reloading')).toBeTruthy()
  })

  it('shows a missing-snapshot hint and retries on demand', () => {
    const { props, instance, listAnalyses, loadSnapshot } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.snapshotFailed({ kind: 'missing', message: 'gone' })
    render(<Workbench {...props} />)
    expect(screen.getByText(/panel\.error\.missing/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'panel.error.retry' }))
    expect(listAnalyses).toHaveBeenCalled()
    expect(loadSnapshot).toHaveBeenCalledWith('s1', 'kk_dis', expect.any(AbortSignal))
  })

  it('renders an empty-analyses placeholder when none are found', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    render(<Workbench {...props} />)
    // Not listing and no analyses → the empty message.
    expect(screen.getByText('panel.emptyAnalyses')).toBeTruthy()
  })

  it('closes the panel through the header close button', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.close' }))
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('renders a DAG from a ready snapshot that omits stages and manifest', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.snapshotReady({ schema_version: 1 })
    render(<Workbench {...props} />)
    // buildDag falls back to empty stages/manifest and still draws the DAG.
    expect(screen.getByTestId('llmpwa-dag')).toBeTruthy()
  })

  it('shows the loading line in the list pane while it lists with no analyses', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listing()
    render(<Workbench {...props} />)
    expect(screen.getAllByText('panel.reloading').length).toBeGreaterThan(0)
  })

  it('selects an analysis from the list', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }, { dir: 'eta' }])
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'eta' }))
    expect(instance.getSnapshot().selected).toBe('eta')
  })

  it('returns early from refresh when no session is selected', () => {
    const { props, instance, listAnalyses } = makeProps({ session: undefined })
    instance.actions.opened()
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.refresh' }))
    // No session: refresh must not issue a list read.
    expect(listAnalyses).not.toHaveBeenCalled()
  })

  it('returns early from retry when no analysis is selected', () => {
    const { props, instance, loadSnapshot } = makeProps()
    instance.actions.opened()
    instance.actions.snapshotFailed({ kind: 'missing', message: 'gone' })
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.error.retry' }))
    expect(loadSnapshot).not.toHaveBeenCalled()
  })

  it('shows a no-workspace message when no read session resolves', () => {
    const { props, instance, listAnalyses } = makeProps({ session: undefined })
    instance.actions.opened()
    render(<Workbench {...props} />)
    // Without a workspace session the panel cannot read the analyses, and it
    // must not be misread as "no analyses found".
    expect(screen.getAllByText('panel.noWorkspace').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'panel.error.retry' })).toBeNull()
    expect(listAnalyses).not.toHaveBeenCalled()
  })

  it('renders parse and unexpected error lines', () => {
    const { props: p1, instance: i1 } = makeProps()
    i1.actions.opened()
    i1.actions.snapshotFailed({ kind: 'parse', message: 'x' })
    const { container: c1 } = render(<Workbench {...p1} />)
    expect(c1.textContent).toContain('panel.error.parse')

    const { props: p2, instance: i2 } = makeProps()
    i2.actions.opened()
    i2.actions.snapshotFailed({ kind: 'unexpected', message: 'x' })
    const { container: c2 } = render(<Workbench {...p2} />)
    expect(c2.textContent).toContain('panel.error.unexpected')
  })

  it('shows the tab bar and switches between DAG and documents', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    render(<Workbench {...props} />)
    expect(instance.getSnapshot().view).toBe('dag')
    expect(screen.getByRole('button', { name: 'panel.tabs.dag' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'panel.tabs.docs' }))
    expect(instance.getSnapshot().view).toBe('docs')
  })

  it('lists reference files when an analysis is selected', () => {
    const { props, instance, listReferences } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    render(<Workbench {...props} />)
    expect(listReferences).toHaveBeenCalledWith('s1', 'kk_dis', expect.any(AbortSignal))
  })

  it('shows the reference list and a select hint before a file is chosen', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'p/resonances_config.toml', name: 'resonances_config.toml' }])
    render(<Workbench {...props} />)
    openDocs()
    expect(screen.getByRole('button', { name: 'resonances_config.toml' })).toBeTruthy()
    expect(screen.getByText('panel.referenceSelectHint')).toBeTruthy()
  })

  it('renders the selected reference file text', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'p/resonances_config.toml', name: 'resonances_config.toml' }])
    instance.actions.referenceReady('p/resonances_config.toml', '[resonances]\n# config')
    render(<Workbench {...props} />)
    openDocs()
    // The code file is syntax-highlighted: the shared CodeBlock banner names the
    // grammar while the body stays selectable.
    expect(screen.getByText('toml')).toBeTruthy()
  })

  it('renders a markdown reference file as a document', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'p/guide.md', name: 'guide.md' }])
    instance.actions.referenceReady('p/guide.md', '# Guide\n\nBody text.')
    render(<Workbench {...props} />)
    openDocs()
    expect(screen.getByRole('heading', { level: 1, name: 'Guide' })).toBeTruthy()
  })

  it('loads a reference file when its button is clicked', () => {
    const { props, instance, loadReference } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'p/resonances_config.toml', name: 'resonances_config.toml' }])
    render(<Workbench {...props} />)
    openDocs()
    fireEvent.click(screen.getByRole('button', { name: 'resonances_config.toml' }))
    expect(loadReference).toHaveBeenCalledWith('s1', 'p/resonances_config.toml', expect.any(AbortSignal))
  })

  it('copies the reference file relative path on right-click', () => {
    clipboard.writeClipboard.mockClear()
    const { props, instance, loadReference } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'LLMPWA/analyses/kk_dis/resonances_config.toml', name: 'resonances_config.toml' }])
    render(<Workbench {...props} />)
    openDocs()
    const button = screen.getByRole('button', { name: 'resonances_config.toml' })
    fireEvent.contextMenu(button)
    expect(clipboard.writeClipboard).toHaveBeenCalledWith('LLMPWA/analyses/kk_dis/resonances_config.toml')
    // The context menu must not trigger a select (read).
    expect(loadReference).not.toHaveBeenCalled()
  })

  it('shows the reference read error and retries the same file', () => {
    const { props, instance, loadReference } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'p/resonances_config.toml', name: 'resonances_config.toml' }])
    instance.actions.referenceFailed('p/resonances_config.toml', { kind: 'unexpected', message: 'no' })
    render(<Workbench {...props} />)
    openDocs()
    expect(screen.getByText(/panel\.error\.reference/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'panel.error.retry' }))
    expect(loadReference).toHaveBeenCalledWith('s1', 'p/resonances_config.toml', expect.any(AbortSignal))
  })

  it('shows a loading line for a selected reference file', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'p/resonances_config.toml', name: 'resonances_config.toml' }])
    instance.actions.referenceLoading('p/resonances_config.toml')
    render(<Workbench {...props} />)
    openDocs()
    expect(screen.getAllByText('panel.reloading').length).toBeGreaterThan(0)
  })

  it('shows an empty-reference message when the analysis has none', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([])
    render(<Workbench {...props} />)
    openDocs()
    expect(screen.getByText('panel.referencesEmpty')).toBeTruthy()
  })

  it('shows the snapshot hint in DAG and the reference loading in documents', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    render(<Workbench {...props} />)
    // The snapshot pane is idle (select hint) in DAG; the reference list is in flight.
    expect(screen.getByText('panel.selectHint')).toBeTruthy()
    openDocs()
    expect(screen.getByText('panel.reloading')).toBeTruthy()
  })

  it('omits the tab bar before an analysis is selected', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    render(<Workbench {...props} />)
    expect(screen.getByText('panel.selectHint')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'panel.tabs.dag' })).toBeNull()
  })

  it('refreshes reference files on retry', () => {
    const { props, instance, listReferences } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.snapshotFailed({ kind: 'missing', message: 'gone' })
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.error.retry' }))
    expect(listReferences).toHaveBeenCalledWith('s1', 'kk_dis', expect.any(AbortSignal))
  })

  it('does not render the reference preview without a read session', () => {
    const { props, instance, loadReference } = makeProps({ session: undefined })
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.referencesReady([{ path: 'p/resonances_config.toml', name: 'resonances_config.toml' }])
    render(<Workbench {...props} />)
    // No workspace read session: the tab bar is replaced by the no-workspace
    // message, so no reference controls render and nothing can be read.
    expect(screen.queryByRole('button', { name: 'resonances_config.toml' })).toBeNull()
    expect(loadReference).not.toHaveBeenCalled()
  })

  it('opens the agent drawer from the header action and launches', () => {
    const { props, instance, openAgent } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.openAgent' }))
    expect(instance.getSnapshot().agentOpen).toBe(true)
    expect(openAgent).toHaveBeenCalledWith('/ws', 's1', 'kk_dis', undefined)
    // The store agent phase is idle because the inject call is a spy; the draw
    // shows the drawer's launch control.
    expect(screen.getByRole('button', { name: 'panel.drawerAgentLaunch' })).toBeTruthy()
  })

  it('starts the session from the drawer launch control', () => {
    const { props, instance, openAgent } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.drawerAgentLaunch' }))
    expect(openAgent).toHaveBeenCalledWith('/ws', 's1', 'kk_dis', undefined)
  })

  it('shows the agent ready state and hands off to the conversation', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    instance.actions.agentReady('sx' as SessionId)
    render(<Workbench {...props} />)
    // The worktree hint stays with no ready banner; the cwd is shown as the
    // analysis directory.
    expect(screen.getByText('/ws/LLMPWA/analyses/kk_dis')).toBeTruthy()
    // With the agent current, the drawer requests the embedded conversation slot.
    expect(screen.getByTestId('embedded-chat-stub')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'panel.drawerViewConversation' }))
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('renders the embedded conversation only when a session is current', () => {
    // The read session (workspace) stays available so the drawer renders, but no
    // session is current; the strict session slot must not be requested.
    const { props, instance } = makeProps({ session: undefined, sessionIds: ['s1'] })
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    instance.actions.agentReady('sx' as SessionId)
    render(<Workbench {...props} />)
    expect(screen.queryByTestId('embedded-chat-stub')).toBeNull()
  })

  it('flags an analysis whose agent session is running', () => {
    const { props, instance } = makeProps({ session: 'sx', sessionIds: ['sx'], running: ['sx'] })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.agentSession('kk_dis', 'sx' as SessionId)
    render(<Workbench {...props} />)
    expect(screen.getByText('panel.running')).toBeTruthy()
  })

  it('does not flag an analysis whose agent session has settled', () => {
    const { props, instance } = makeProps({ session: 'sx', sessionIds: ['sx'] })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.agentSession('kk_dis', 'sx' as SessionId)
    render(<Workbench {...props} />)
    expect(screen.queryByText('panel.running')).toBeNull()
  })

  it('shows the agent open failure and retries', () => {
    const { props, instance, openAgent } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    instance.actions.agentFailed({ kind: 'unexpected', message: 'boom' })
    render(<Workbench {...props} />)
    expect(screen.getByText(/panel\.error\.agent/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'panel.error.retry' }))
    expect(openAgent).toHaveBeenCalledWith('/ws', 's1', 'kk_dis', undefined)
  })

  it('omits the agent action without a read session', () => {
    const { props, instance, openAgent } = makeProps({ session: undefined })
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    render(<Workbench {...props} />)
    expect(screen.queryByRole('button', { name: 'panel.openAgent' })).toBeNull()
    expect(openAgent).not.toHaveBeenCalled()
    expect(instance.getSnapshot().agentOpen).toBe(false)
  })

  it('does not start a session from the drawer without a read session', () => {
    const { props, instance, openAgent } = makeProps({ session: undefined })
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    // No workspace read session: the drawer never renders, so no launch control.
    expect(screen.queryByTestId('llmpwa-agent-drawer')).toBeNull()
    expect(openAgent).not.toHaveBeenCalled()
  })

  it('closes the agent drawer', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    // Both the header and the drawer expose a close button; pick the drawer's.
    fireEvent.click(screen.getAllByRole('button', { name: 'panel.close' })[1] as HTMLButtonElement)
    expect(instance.getSnapshot().agentOpen).toBe(false)
  })

  it('shows the agent opening state', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    instance.actions.agentOpening()
    render(<Workbench {...props} />)
    expect(screen.getByText('panel.reloading')).toBeTruthy()
  })

  it('renders the drawer at its stored width with a resize handle', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    instance.actions.setDrawerWidth(480)
    render(<Workbench {...props} />)
    const drawer = screen.getByTestId('llmpwa-agent-drawer') as HTMLElement
    expect(drawer.style.width).toBe('480px')
    // The handle is exposed as an accessible separator.
    expect(screen.getByRole('separator', { name: 'panel.resizeAgent' })).toBeTruthy()
  })

  it('resizes the drawer by dragging its handle', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    const handle = screen.getByRole('separator', { name: 'panel.resizeAgent' }) as HTMLDivElement
    const row = screen.getByTestId('llmpwa-preview-body')
    // jsdom has no layout, so the preview row width resolves to the clamp floor.
    Object.defineProperty(row, 'clientWidth', { value: 1000, configurable: true })
    fireEvent.pointerDown(handle, { clientX: 200 })
    fireEvent.pointerMove(handle, { clientX: 100 })
    fireEvent.pointerUp(handle, { clientX: 100 })
    // Dragging the handle left by 100px widens the drawer by 100px.
    expect(instance.getSnapshot().drawerWidth).toBe(420)
  })

  it('clamps the drawer width to the row bounds', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    const handle = screen.getByRole('separator', { name: 'panel.resizeAgent' }) as HTMLDivElement
    const row = screen.getByTestId('llmpwa-preview-body')
    Object.defineProperty(row, 'clientWidth', { value: 800, configurable: true })
    fireEvent.pointerDown(handle, { clientX: 200 })
    // A huge leftward drag cannot exceed the row width less the preview floor.
    fireEvent.pointerMove(handle, { clientX: 0 })
    expect(instance.getSnapshot().drawerWidth).toBe(480)
    fireEvent.pointerMove(handle, { clientX: 2000 })
    // And a rightward drag holds the minimum width.
    expect(instance.getSnapshot().drawerWidth).toBe(280)
  })

  it('ignores stray pointer move and up without an active drag', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    const handle = screen.getByRole('separator', { name: 'panel.resizeAgent' }) as HTMLDivElement
    fireEvent.pointerMove(handle, { clientX: 100 })
    fireEvent.pointerUp(handle, { clientX: 100 })
    // No drag was started, so the width is untouched.
    expect(instance.getSnapshot().drawerWidth).toBe(320)
  })

  it('falls back to a workspace session when the current session is not listed', () => {
    const { props, instance, openAgent } = makeProps({ session: 'chat', sessionIds: ['s1'] })
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    render(<Workbench {...props} />)
    // The active conversation session is not a workspace session, so the panel
    // reads through the workspace's own session and still offers the agent.
    expect(screen.getByRole('button', { name: 'panel.openAgent' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'panel.openAgent' }))
    expect(openAgent).toHaveBeenCalledWith('/ws', 's1', 'kk_dis', undefined)
  })

  it('floats over the preview without reflowing the main preview', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    const { container } = render(<Workbench {...props} />)
    // The floating drawer and the main preview are siblings in the positioned
    // row; the drawer is absolutely positioned, so the main preview still spans
    // the full row rather than being squeezed by a flex sibling.
    expect(screen.getByTestId('llmpwa-agent-drawer')).toBeTruthy()
    const row = screen.getByTestId('llmpwa-preview-body')
    expect(row.querySelector('[class*=mainPreview]')).toBeTruthy()
    expect(container.querySelector('[class*=drawerResize]')).toBeTruthy()
  })

  it('collapses the agent panel when the page behind is clicked', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    expect(screen.getByTestId('llmpwa-agent-drawer')).toBeTruthy()
    // The backdrop is a click-catcher over the page behind the panel.
    const backdrop = document.querySelector('[class*=drawerBackdrop]') as HTMLDivElement
    fireEvent.click(backdrop)
    expect(instance.getSnapshot().agentCollapsed).toBe(true)
    // The expanded drawer is replaced by the narrow title strip.
    expect(screen.queryByTestId('llmpwa-agent-drawer')).toBeNull()
    expect(screen.getByTestId('llmpwa-agent-strip')).toBeTruthy()
  })

  it('restores the agent panel when its collapsed title strip is clicked', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    instance.actions.agentCollapse()
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByTestId('llmpwa-agent-strip'))
    expect(instance.getSnapshot().agentCollapsed).toBe(false)
    expect(screen.getByTestId('llmpwa-agent-drawer')).toBeTruthy()
  })

  it('collapses the agent panel from its title bar', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.drawerTitle' }))
    expect(instance.getSnapshot().agentCollapsed).toBe(true)
  })

  it('launches a fresh agent session from the title bar', () => {
    const { props, instance, newAgent } = makeProps()
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentOpened()
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.newSession' }))
    expect(newAgent).toHaveBeenCalledWith('/ws', 's1', 'kk_dis')
  })

  it('reuses the recorded agent session when it is still live', () => {
    const { props, instance, openAgent } = makeProps({ byId: { sx: { running: false } } })
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    instance.actions.agentSession('kk_dis', 'sx' as SessionId)
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.openAgent' }))
    // The recorded session still exists, so the face reuses it rather than
    // creating a new one.
    expect(openAgent).toHaveBeenCalledWith('/ws', 's1', 'kk_dis', 'sx')
  })

  it('reuses a restored agent session when opening the agent', () => {
    // The face restores the mapping from the analysis's on-disk settings file
    // (read after listing), so opening the agent for the analysis reuses the
    // still-live session rather than creating a new one.
    const { props, instance, openAgent } = makeProps({ byId: { sx: { running: false } } })
    instance.actions.agentSessionsLoaded({ kk_dis: 'sx' as SessionId })
    expect(instance.getSnapshot().agentSessions).toEqual({ kk_dis: 'sx' })
    instance.actions.opened()
    instance.actions.selected('kk_dis')
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'panel.openAgent' }))
    expect(openAgent).toHaveBeenCalledWith('/ws', 's1', 'kk_dis', 'sx')
  })

  it('switches to the analysis whose agent session is the current conversation', () => {
    // The main conversation holds an analysis agent session; opening the panel
    // must select that analysis so the DAG and docs match the conversation.
    const { props, instance } = makeProps({ session: 'sx', sessionIds: ['sx'] })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }, { dir: 'kk_pipi' }])
    instance.actions.agentSessionsLoaded({ kk_dis: 'sx' as SessionId })
    render(<Workbench {...props} />)
    expect(instance.getSnapshot().selected).toBe('kk_dis')
  })

  it('switches to the analysis matching the current session cwd without a mapping', () => {
    // No restored mapping, but the live session's cwd is the analysis dir; the
    // panel selects that analysis from the session row alone.
    const { props, instance } = makeProps({
      session: 'sx', sessionIds: ['sx'],
      byId: { sx: { cwd: '/ws/LLMPWA/analyses/kk_pipi' } },
    })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }, { dir: 'kk_pipi' }])
    instance.actions.agentSessionsLoaded({})
    render(<Workbench {...props} />)
    expect(instance.getSnapshot().selected).toBe('kk_pipi')
  })

  it('keeps a manual list pick over the auto-select for the same session', () => {
    // A manual pick after an auto-select within one open wins: selecting a
    // different analysis by hand must not be reverted by the follow effect.
    const { props, instance } = makeProps({
      session: 'sx', sessionIds: ['sx'],
      byId: { sx: { cwd: '/ws/LLMPWA/analyses/kk_dis' } },
    })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }, { dir: 'kk_pipi' }])
    instance.actions.agentSessionsLoaded({})
    render(<Workbench {...props} />)
    // Auto-select resolves to kk_dis through the session cwd.
    expect(instance.getSnapshot().selected).toBe('kk_dis')
    // A manual pick switches to another analysis and stays there.
    fireEvent.click(screen.getByRole('button', { name: 'kk_pipi' }))
    expect(instance.getSnapshot().selected).toBe('kk_pipi')
  })

  it('re-syncs to the conversation session analysis when reopened', () => {
    // Close and reopen while the conversation session still maps to an
    // analysis: the panel must re-derive the selection rather than keep a
    // stale one from the previous open.
    const { props, instance } = makeProps({
      session: 'sx', sessionIds: ['sx'],
      byId: { sx: { cwd: '/ws/LLMPWA/analyses/kk_dis' } },
    })
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }, { dir: 'kk_pipi' }])
    instance.actions.agentSessionsLoaded({})
    const { unmount } = render(<Workbench {...props} />)
    expect(instance.getSnapshot().selected).toBe('kk_dis')
    // Manual pick, then close: closing clears the auto-sync marker.
    fireEvent.click(screen.getByRole('button', { name: 'kk_pipi' }))
    expect(instance.getSnapshot().selected).toBe('kk_pipi')
    act(() => { instance.actions.closed() })
    // Reopen: the follow effect resets and re-derives from the session cwd.
    act(() => { instance.actions.opened() })
    expect(instance.getSnapshot().selected).toBe('kk_dis')
    unmount()
  })

  it('renders a task card grid when the tasks tab is opened', () => {
    const { props, instance, listTasks } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskStatusReady('t1', {
      task_id: 't1', title: 'Run 100', status: 'completed', task_type: 'fit_multistart',
      date_start: '2026-09-12', date_end: '2026-09-13',
      environment: { host: 'HEP1', gpu: '2xRTX', python_env: 'kk_fit' },
    })
    render(<Workbench {...props} />)
    openTasks()
    expect(instance.getSnapshot().view).toBe('tasks')
    expect(listTasks).toHaveBeenCalledWith('s1', 'kk_dis', expect.any(AbortSignal))
    const card = screen.getByTestId('llmpwa-task-card-t1')
    expect(screen.getByText('Run 100')).toBeTruthy()
    expect(screen.getByText('fit_multistart')).toBeTruthy()
    expect(screen.getByText(/2026-09-12 → 2026-09-13/)).toBeTruthy()
    expect(screen.getByText(/HEP1/)).toBeTruthy()
    expect(card).toBeTruthy()
  })

  it('shows an empty-tasks message when the analysis has no tasks', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([])
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByText('panel.tasksEmpty')).toBeTruthy()
  })

  it('shows the tasks loading line while the list is in flight with no tasks', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksLoading()
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByText('panel.reloading')).toBeTruthy()
  })

  it('renders a card for a task with no readable status, degrading to the directory name', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    render(<Workbench {...props} />)
    openTasks()
    // No status loaded yet: the card shows the directory name as its title.
    expect(screen.getByTestId('llmpwa-task-card-t1')).toBeTruthy()
    expect(screen.getByText('t1')).toBeTruthy()
  })

  it('renders every card status dot color across failed and paused tasks', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([
      { id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' },
      { id: 't2', dir: 'LLMPWA/analyses/kk_dis/task/t2' },
    ])
    instance.actions.taskStatusReady('t1', { task_id: 't1', status: 'failed' })
    instance.actions.taskStatusReady('t2', { task_id: 't2', status: 'paused' })
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByTestId('llmpwa-task-card-t1')).toBeTruthy()
    expect(screen.getByTestId('llmpwa-task-card-t2')).toBeTruthy()
  })

  it('opens the task popup from a card and seeds the file tree root', () => {
    const { props, instance, listTaskDir } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    render(<Workbench {...props} />)
    openTasks()
    fireEvent.click(screen.getByTestId('llmpwa-task-card-t1'))
    expect(instance.getSnapshot().selectedTask).toBe('t1')
    expect(instance.getSnapshot().taskOpen).toBe(true)
    expect(listTaskDir).toHaveBeenCalledWith('s1', 'LLMPWA/analyses/kk_dis/task/t1', expect.any(AbortSignal))
  })

  it('renders the task file tree root and loads a directory branch on toggle', () => {
    const { props, instance, listTaskDir } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/status.json', name: 'status.json', kind: 'file' },
      { path: 'LLMPWA/analyses/kk_dis/task/t1/3_报告', name: '3_报告', kind: 'directory' },
    ])
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByRole('button', { name: 'status.json' })).toBeTruthy()
    // The directory is not expanded yet; toggling it loads its children.
    fireEvent.click(screen.getByRole('button', { name: /3_报告/ }))
    expect(instance.getSnapshot().taskTreeExpanded).toEqual(['LLMPWA/analyses/kk_dis/task/t1/3_报告'])
    expect(listTaskDir).toHaveBeenCalledWith('s1', 'LLMPWA/analyses/kk_dis/task/t1/3_报告', expect.any(AbortSignal))
    act(() => {
      instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1/3_报告', [
        { path: 'LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', name: 'r.md', kind: 'file' },
      ])
    })
    expect(screen.getByRole('button', { name: 'r.md' })).toBeTruthy()
    // Collapsing an already-listed directory does not trigger another read.
    const callsAfterExpand = listTaskDir.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /3_报告/ }))
    expect(instance.getSnapshot().taskTreeExpanded).toEqual([])
    expect(listTaskDir.mock.calls.length).toBe(callsAfterExpand)
  })

  it('shows the tree loading line while a directory is being listed', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/3_报告', name: '3_报告', kind: 'directory' },
    ])
    instance.actions.taskDirLoading('LLMPWA/analyses/kk_dis/task/t1/3_报告')
    render(<Workbench {...props} />)
    openTasks()
    fireEvent.click(screen.getByRole('button', { name: /3_报告/ }))
    expect(screen.getAllByText('panel.reloading').length).toBeGreaterThan(0)
  })

  it('loads a task file text when its tree file is clicked', () => {
    const { props, instance, loadTaskFile } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', name: 'r.md', kind: 'file' },
    ])
    render(<Workbench {...props} />)
    openTasks()
    fireEvent.click(screen.getByRole('button', { name: 'r.md' }))
    expect(loadTaskFile).toHaveBeenCalledWith('s1', 'LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', expect.any(AbortSignal))
  })

  it('renders the selected task file text as a document', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', name: 'r.md', kind: 'file' },
    ])
    instance.actions.taskFileReady('LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', '# Report\n\nBody text.')
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByRole('heading', { level: 1, name: 'Report' })).toBeTruthy()
  })

  it('renders a task HTML report as a live sandboxed document', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/3_报告/report.html', name: 'report.html', kind: 'file' },
    ])
    instance.actions.taskFileReady(
      'LLMPWA/analyses/kk_dis/task/t1/3_报告/report.html',
      '<!doctype html><html><body><h1>Report</h1></body></html>',
    )
    const { container } = render(<Workbench {...props} />)
    openTasks()
    const frame = container.querySelector('iframe')
    expect(frame).toBeTruthy()
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('srcdoc')).toContain('<h1>Report</h1>')
    // No code-block banner is drawn for the HTML document.
    expect(screen.queryByRole('button', { name: 'panel.copy' })).toBeNull()
  })

  it('shows a task file read error and retries the same file', () => {
    const { props, instance, loadTaskFile } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', name: 'r.md', kind: 'file' },
    ])
    instance.actions.taskFileFailed('LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', { kind: 'unexpected', message: 'no' })
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByText(/panel\.error\.reference/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'panel.error.retry' }))
    expect(loadTaskFile).toHaveBeenCalledWith('s1', 'LLMPWA/analyses/kk_dis/task/t1/3_报告/r.md', expect.any(AbortSignal))
  })

  it('shows the task-file select hint before a file is chosen', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/a.md', name: 'a.md', kind: 'file' },
    ])
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByText('panel.referenceSelectHint')).toBeTruthy()
  })

  it('shows the task-file loading text while a file read is in flight', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [
      { path: 'LLMPWA/analyses/kk_dis/task/t1/a.md', name: 'a.md', kind: 'file' },
    ])
    instance.actions.taskFileLoading('LLMPWA/analyses/kk_dis/task/t1/a.md')
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getAllByText('panel.reloading').length).toBeGreaterThan(0)
  })

  it('collapses the task popup to a strip on backdrop click and expands back', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    render(<Workbench {...props} />)
    openTasks()
    expect(screen.getByTestId('llmpwa-task-popup')).toBeTruthy()
    // Clicking the page behind collapses the popup to the title strip.
    fireEvent.click(screen.getByTestId('llmpwa-task-backdrop'))
    expect(instance.getSnapshot().taskCollapsed).toBe(true)
    expect(screen.getByTestId('llmpwa-task-strip')).toBeTruthy()
    fireEvent.click(screen.getByTestId('llmpwa-task-strip'))
    expect(instance.getSnapshot().taskCollapsed).toBe(false)
  })

  it('adjusts the task popup height by dragging its resize handle', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.setTaskHeight(300)
    render(<Workbench {...props} />)
    openTasks()
    const handle = screen.getByTestId('llmpwa-task-resize')
    // Move/up before a down is a no-op (no drag origin captured yet).
    fireEvent.pointerMove(handle, { clientY: 400 })
    fireEvent.pointerUp(handle, { clientY: 400 })
    expect(instance.getSnapshot().taskHeight).toBe(300)
    // Dragging the handle downward shrinks the popup (origin.height + (y - clientY)).
    fireEvent.pointerDown(handle, { clientY: 400 })
    expect(instance.getSnapshot().taskHeight).toBe(300)
    fireEvent.pointerMove(handle, { clientY: 460 })
    expect(instance.getSnapshot().taskHeight).toBeLessThan(300)
    fireEvent.pointerUp(handle, { clientY: 460 })
    expect(instance.getSnapshot().taskHeight).toBeLessThan(300)
  })

  it('closes the task popup and clears the selection', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    instance.actions.listed([{ dir: 'kk_dis' }])
    instance.actions.selected('kk_dis')
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    render(<Workbench {...props} />)
    openTasks()
    fireEvent.click(within(screen.getByTestId('llmpwa-task-popup')).getByRole('button', { name: 'panel.close' }))
    expect(instance.getSnapshot().taskOpen).toBe(false)
    expect(instance.getSnapshot().selectedTask).toBeUndefined()
  })
})
