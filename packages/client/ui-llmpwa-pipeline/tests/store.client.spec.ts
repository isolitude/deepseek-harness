/**
 * The workbench store's write set: opening/closing, the analyses list, the
 * selection, and the snapshot load phase transition.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { PipelineSnapshot } from '../src/client/presenters.ts'

const snapshot: PipelineSnapshot = { schema_version: 1, stages: [] }

describe('workbench store', () => {
  it('starts closed with no analyses, an idle snapshot, and no references', () => {
    const state = createWorkbenchStore().create().getSnapshot()
    expect(state).toEqual({
      open: false,
      analyses: [],
      selected: undefined,
      listing: false,
      snapshot: { kind: 'idle' },
      references: [],
      referencesListing: false,
      reference: { kind: 'idle' },
      tasks: [],
      tasksListing: false,
      taskStatuses: {},
      selectedTask: undefined,
      taskOpen: false,
      taskCollapsed: false,
      taskHeight: 400,
      taskTreeExpanded: [],
      taskTree: {},
      taskTreeListing: {},
      taskFile: { kind: 'idle' },
      view: 'dag',
      drawerWidth: 320,
      agentOpen: false,
      agentCollapsed: false,
      agent: { kind: 'idle' },
      agentSessions: {},
    })
  })

  it('toggles open and closed', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.opened()
    expect(instance.getSnapshot().open).toBe(true)
    instance.actions.closed()
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('marks listing and records the discovered analyses', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.listing()
    expect(instance.getSnapshot().listing).toBe(true)
    instance.actions.listed([{ dir: 'kk_dis' }])
    expect(instance.getSnapshot()).toMatchObject({ analyses: [{ dir: 'kk_dis' }], listing: false })
  })

  it('selecting an analysis clears a previous snapshot and references', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.snapshotReady(snapshot)
    instance.actions.referencesReady([{ path: 'LLMPWA/analyses/kk_dis/resonances_config.toml', name: 'resonances_config.toml' }])
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [{ path: 'a', name: 'a.md', kind: 'file' }])
    instance.actions.selected('kk_dis')
    const state = instance.getSnapshot()
    expect(state.selected).toBe('kk_dis')
    expect(state.snapshot).toEqual({ kind: 'idle' })
    expect(state.references).toEqual([])
    expect(state.referencesListing).toBe(true)
    expect(state.reference).toEqual({ kind: 'idle' })
    expect(state.tasks).toEqual([])
    expect(state.tasksListing).toBe(true)
    expect(state.taskStatuses).toEqual({})
    expect(state.selectedTask).toBeUndefined()
    expect(state.taskOpen).toBe(false)
    expect(state.taskCollapsed).toBe(false)
    expect(state.taskTree).toEqual({})
    expect(state.taskTreeExpanded).toEqual([])
  })

  it('walks the snapshot phase from loading to ready or failed', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.snapshotLoading()
    expect(instance.getSnapshot().snapshot).toEqual({ kind: 'loading' })
    instance.actions.snapshotReady(snapshot)
    expect(instance.getSnapshot().snapshot).toEqual({ kind: 'ready', snapshot })
    instance.actions.snapshotLoading()
    instance.actions.snapshotFailed({ kind: 'parse', message: 'bad' })
    expect(instance.getSnapshot().snapshot).toEqual({ kind: 'failed', error: { kind: 'parse', message: 'bad' } })
  })

  it('marks the reference list in flight and records the files', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.referencesLoading()
    expect(instance.getSnapshot()).toMatchObject({ references: [], referencesListing: true })
    instance.actions.referencesReady([{ path: 'LLMPWA/analyses/kk_dis/document/x.md', name: 'document/x.md' }])
    expect(instance.getSnapshot()).toMatchObject({
      references: [{ path: 'LLMPWA/analyses/kk_dis/document/x.md', name: 'document/x.md' }],
      referencesListing: false,
    })
  })

  it('walks the reference read phase from loading to ready or failed', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.referenceLoading('a.toml')
    expect(instance.getSnapshot().reference).toEqual({ kind: 'loading', path: 'a.toml' })
    instance.actions.referenceReady('a.toml', '# text')
    expect(instance.getSnapshot().reference).toEqual({ kind: 'ready', path: 'a.toml', text: '# text' })
    instance.actions.referenceLoading('b.toml')
    instance.actions.referenceFailed('b.toml', { kind: 'unexpected', message: 'no' })
    expect(instance.getSnapshot().reference).toEqual({
      kind: 'failed', path: 'b.toml', error: { kind: 'unexpected', message: 'no' },
    })
  })

  it('walks the reference read phase to a ready image', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.referenceLoading('4_图片/pictures/fig.png')
    expect(instance.getSnapshot().reference).toEqual({ kind: 'loading', path: '4_图片/pictures/fig.png' })
    instance.actions.referenceImageReady('4_图片/pictures/fig.png')
    expect(instance.getSnapshot().reference).toEqual({ kind: 'ready-image', path: '4_图片/pictures/fig.png' })
  })

  it('switches the preview tab', () => {
    const instance = createWorkbenchStore().create()
    expect(instance.getSnapshot().view).toBe('dag')
    instance.actions.setView('docs')
    expect(instance.getSnapshot().view).toBe('docs')
    instance.actions.setView('dag')
    expect(instance.getSnapshot().view).toBe('dag')
  })

  it('updates the agent drawer width', () => {
    const instance = createWorkbenchStore().create()
    expect(instance.getSnapshot().drawerWidth).toBe(320)
    instance.actions.setDrawerWidth(480)
    expect(instance.getSnapshot().drawerWidth).toBe(480)
    instance.actions.setDrawerWidth(280)
    expect(instance.getSnapshot().drawerWidth).toBe(280)
  })

  it('opens and closes the agent drawer', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.agentOpened()
    expect(instance.getSnapshot()).toMatchObject({ agentOpen: true, agent: { kind: 'idle' } })
    instance.actions.agentClosed()
    expect(instance.getSnapshot()).toMatchObject({ agentOpen: false, agent: { kind: 'idle' } })
  })

  it('collapses and expands the agent drawer', () => {
    const instance = createWorkbenchStore().create()
    expect(instance.getSnapshot().agentCollapsed).toBe(false)
    instance.actions.agentCollapse()
    expect(instance.getSnapshot().agentCollapsed).toBe(true)
    instance.actions.agentExpand()
    expect(instance.getSnapshot().agentCollapsed).toBe(false)
    // Opening the drawer always starts expanded.
    instance.actions.agentCollapse()
    instance.actions.agentOpened()
    expect(instance.getSnapshot().agentCollapsed).toBe(false)
  })

  it('walks the agent launch phase from opening to ready or failed', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.agentOpening()
    expect(instance.getSnapshot().agent).toEqual({ kind: 'opening' })
    instance.actions.agentReady('ss' as SessionId)
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'ss' })
    instance.actions.agentOpening()
    instance.actions.agentFailed({ kind: 'unexpected', message: 'boom' })
    expect(instance.getSnapshot().agent).toEqual({ kind: 'failed', error: { kind: 'unexpected', message: 'boom' } })
  })

  it('records the agent session per analysis and supersedes a repeat open', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.agentSession('kk_dis', 's1' as SessionId)
    expect(instance.getSnapshot().agentSessions.kk_dis).toBe('s1')
    instance.actions.agentSession('kk_dis', 's2' as SessionId)
    expect(instance.getSnapshot().agentSessions.kk_dis).toBe('s2')
    instance.actions.agentSession('eta', 's3' as SessionId)
    expect(instance.getSnapshot().agentSessions.eta).toBe('s3')
    expect(instance.getSnapshot().agentSessions.kk_dis).toBe('s2')
  })

  it('restores the whole agent-session mapping from a loaded settings record', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.agentSessionsLoaded({ kk_dis: 'sx' as SessionId, eta: 'sy' as SessionId })
    expect(instance.getSnapshot().agentSessions).toEqual({ kk_dis: 'sx', eta: 'sy' })
  })

  it('selecting an analysis resets the view and the agent drawer', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.setView('docs')
    instance.actions.agentOpened()
    instance.actions.agentReady('ss' as SessionId)
    instance.actions.selected('kk_dis')
    const state = instance.getSnapshot()
    expect(state.view).toBe('dag')
    expect(state.agentOpen).toBe(false)
    expect(state.agent).toEqual({ kind: 'idle' })
  })

  it('marks the task list in flight and records the task directories', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.tasksLoading()
    expect(instance.getSnapshot().tasksListing).toBe(true)
    instance.actions.tasksReady([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    expect(instance.getSnapshot()).toMatchObject({
      tasks: [{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }],
      tasksListing: false,
    })
  })

  it('records a task status and leaves unloaded ones absent', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.tasksReady([
      { id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' },
      { id: 't2', dir: 'LLMPWA/analyses/kk_dis/task/t2' },
    ])
    instance.actions.taskStatusReady('t1', { task_id: 't1', status: 'completed' })
    expect(instance.getSnapshot().taskStatuses).toEqual({
      t1: { task_id: 't1', status: 'completed' },
    })
  })

  it('opening a task resets its tree and marks nothing in flight', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t2', [{ path: 'a', name: 'a.md', kind: 'file' }])
    instance.actions.taskOpened('t2')
    const state = instance.getSnapshot()
    expect(state.selectedTask).toBe('t2')
    expect(state.taskOpen).toBe(true)
    expect(state.taskCollapsed).toBe(false)
    expect(state.taskTreeExpanded).toEqual([])
    expect(state.taskTree).toEqual({})
    expect(state.taskTreeListing).toEqual({})
    expect(state.taskFile).toEqual({ kind: 'idle' })
  })

  it('closing a task clears the selection and its tree', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.taskOpened('t1')
    instance.actions.taskDirReady('LLMPWA/analyses/kk_dis/task/t1', [{ path: 'a', name: 'a.md', kind: 'file' }])
    instance.actions.taskClosed()
    const state = instance.getSnapshot()
    expect(state.taskOpen).toBe(false)
    expect(state.selectedTask).toBeUndefined()
    expect(state.taskCollapsed).toBe(false)
    expect(state.taskTree).toEqual({})
    expect(state.taskTreeExpanded).toEqual([])
  })

  it('collapses and expands and resizes the task popup', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.taskOpened('t1')
    instance.actions.taskCollapse()
    expect(instance.getSnapshot().taskCollapsed).toBe(true)
    instance.actions.taskExpand()
    expect(instance.getSnapshot().taskCollapsed).toBe(false)
    instance.actions.setTaskHeight(480)
    expect(instance.getSnapshot().taskHeight).toBe(480)
  })

  it('marks a directory listing in flight and records its children', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.taskDirLoading('d')
    expect(instance.getSnapshot().taskTreeListing).toEqual({ d: true })
    instance.actions.taskDirReady('d', [{ path: 'd/a.md', name: 'a.md', kind: 'file' }])
    expect(instance.getSnapshot()).toMatchObject({
      taskTree: { d: [{ path: 'd/a.md', name: 'a.md', kind: 'file' }] },
      taskTreeListing: { d: false },
    })
  })

  it('toggles a directory expansion in the task tree', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.taskDirToggle('d')
    expect(instance.getSnapshot().taskTreeExpanded).toEqual(['d'])
    instance.actions.taskDirToggle('d')
    expect(instance.getSnapshot().taskTreeExpanded).toEqual([])
    instance.actions.taskDirToggle('d')
    instance.actions.taskDirToggle('e')
    expect(instance.getSnapshot().taskTreeExpanded).toEqual(['d', 'e'])
  })

  it('walks the task file read phase from loading to ready or failed', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.taskFileLoading('a.md')
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'loading', path: 'a.md' })
    instance.actions.taskFileReady('a.md', '# text')
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'ready', path: 'a.md', text: '# text' })
    instance.actions.taskFileLoading('b.md')
    instance.actions.taskFileFailed('b.md', { kind: 'unexpected', message: 'no' })
    expect(instance.getSnapshot().taskFile).toEqual({
      kind: 'failed', path: 'b.md', error: { kind: 'unexpected', message: 'no' },
    })
  })

  it('walks the task file read phase to a ready image', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.taskFileLoading('4_图片/pictures/fig.png')
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'loading', path: '4_图片/pictures/fig.png' })
    instance.actions.taskFileImageReady('4_图片/pictures/fig.png')
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'ready-image', path: '4_图片/pictures/fig.png' })
  })

  it('switches the preview tab to tasks and back', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.setView('tasks')
    expect(instance.getSnapshot().view).toBe('tasks')
    instance.actions.setView('dag')
    expect(instance.getSnapshot().view).toBe('dag')
  })
})
