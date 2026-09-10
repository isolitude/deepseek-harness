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
    instance.actions.selected('kk_dis')
    const state = instance.getSnapshot()
    expect(state.selected).toBe('kk_dis')
    expect(state.snapshot).toEqual({ kind: 'idle' })
    expect(state.references).toEqual([])
    expect(state.referencesListing).toBe(true)
    expect(state.reference).toEqual({ kind: 'idle' })
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
})
