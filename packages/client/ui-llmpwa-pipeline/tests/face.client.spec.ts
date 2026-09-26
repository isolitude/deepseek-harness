/**
 * The inject face: performs the Remote read and writes the outcome through the
 * store's own actions, suppressing settlements after the caller aborts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWorkbenchStore } from '../src/client/store.ts'
import { workbenchFace, type WorkbenchInjected } from '../src/client/face.ts'
import type { WorkbenchStore } from '../src/client/store.ts'
import type { WorkspaceFilesLoadRemote } from '../src/client/load.ts'

const SESSION = 's1' as SessionId

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function remote(listImpl: unknown, readImpl: unknown, writeImpl?: unknown): WorkspaceFilesLoadRemote {
  const write = writeImpl ?? vi.fn().mockResolvedValue({ ok: true, value: { version: 'v1', operation: 'create' } })
  return {
    workspaceFiles: {
      list: listImpl as WorkspaceFilesLoadRemote['workspaceFiles']['list'],
      read: readImpl as WorkspaceFilesLoadRemote['workspaceFiles']['read'],
      write: write as WorkspaceFilesLoadRemote['workspaceFiles']['write'],
    },
  }
}

/** A scripted `ISessions` mocks the tests assert calls on, via the class idiom that keeps the mock out of method-shorthand land. */
class FakeSessions {
  readonly create: ReturnType<typeof vi.fn<ISessions['create']>>
  readonly open: ReturnType<typeof vi.fn<(target: SessionId) => void>>
  readonly list = {
    getSnapshot: (): { readonly ids: readonly string[]; readonly byId: Record<string, unknown> } => ({
      ids: Object.keys(this.byId),
      byId: this.byId,
    }),
  }

  private readonly byId: Record<string, unknown>

  constructor(createImpl?: () => Promise<SessionId>, byId: Record<string, unknown> = {}) {
    this.create = vi.fn<ISessions['create']>(createImpl ?? (() => Promise.resolve('sess-1' as SessionId)))
    this.open = vi.fn<(target: SessionId) => void>(() => {})
    this.byId = byId
  }
}

function makeSessions(
  createImpl?: () => Promise<SessionId>,
  byId: Record<string, unknown> = {},
): FakeSessions {
  return new FakeSessions(createImpl, byId)
}

/**
 * Feed the scripted fixture to the face at the typed boundary. The class keeps
 * arrow members so test derefs stay lint-clean; the face consumes the full
 * `ISessions` contract.
 */
function toSessions(sessions: FakeSessions): ISessions {
  return sessions as unknown as ISessions
}

/** A recorder standing in for the owning UiWorkspace service the face navigates through. */
interface NavigationStub {
  openSession: ReturnType<typeof vi.fn<(target: SessionId) => void>>
}

/** Create one navigation recorder and bind the face over the given fixtures and store actions. */
function makeFace(
  r: WorkspaceFilesLoadRemote,
  sessions: FakeSessions,
  workspaces: FakeWorkspaces,
  actions: BoundActions<WorkbenchStore>,
): { face: WorkbenchInjected; openSession: NavigationStub['openSession'] } {
  const openSession = vi.fn<(target: SessionId) => void>(() => {})
  const face = workbenchFace(r, toSessions(sessions), toWorkspaces(workspaces), { openSession })(actions)
  return { face, openSession }
}

/** A scripted `IWorkspaces` that records create/attach calls and owns the list snapshot. */
class FakeWorkspaces {
  readonly create: ReturnType<typeof vi.fn<IWorkspaces['create']>>
  readonly attachSession: ReturnType<typeof vi.fn<IWorkspaces['attachSession']>>
  readonly list = {
    getSnapshot: (): { items: Array<{ workspaceId: string; path: string; sessionIds: SessionId[]; title: string }> } => ({
      items: this.items,
    }),
  }

  private items: Array<{ workspaceId: WorkspaceId; path: string; sessionIds: SessionId[]; title: string }> = []

  constructor(initial: Array<{ workspaceId: string; path: string; sessionIds?: string[] }> = []) {
    this.items = initial.map(item => ({
      workspaceId: item.workspaceId as WorkspaceId,
      path: item.path,
      sessionIds: (item.sessionIds ?? []) as SessionId[],
      title: item.path,
    }))
    this.create = vi.fn<IWorkspaces['create']>(async (input) => {
      const existing = this.items.find(item => item.path === input.path)
      if (existing !== undefined) return toView(existing)
      const created = {
        workspaceId: `ws-${this.items.length + 1}` as WorkspaceId,
        path: input.path,
        sessionIds: [] as SessionId[],
        title: input.path,
      }
      this.items = [...this.items, created]
      return toView(created)
    })
    this.attachSession = vi.fn<IWorkspaces['attachSession']>(async (_workspaceId, sessionId) => {
      const item = this.items.find(candidate => candidate.workspaceId === _workspaceId)
      if (item === undefined) throw new Error('unknown workspace')
      if (!item.sessionIds.includes(sessionId)) item.sessionIds = [...item.sessionIds, sessionId]
      return toView(item)
    })
  }
}

/** Project a scripted workspace row into the production `WorkspaceView` shape. */
function toView(item: { workspaceId: WorkspaceId; path: string; title: string; sessionIds: SessionId[] }): WorkspaceView {
  return {
    workspaceId: item.workspaceId,
    path: item.path,
    title: item.title,
    sessionIds: item.sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeWorkspaces(initial: Array<{ workspaceId: string; path: string; sessionIds?: string[] }> = []): FakeWorkspaces {
  return new FakeWorkspaces(initial)
}

function toWorkspaces(workspaces: FakeWorkspaces): IWorkspaces {
  return workspaces as unknown as IWorkspaces
}

describe('workbenchFace', () => {
  it('lists analyses into the store', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'workspace-file/not-found', message: 'gone', details: { path: 'LLMPWA/analyses/kk_dis/.dsh/agent.json' } },
      }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    expect(instance.getSnapshot().listing).toBe(true)
    await tick()
    expect(instance.getSnapshot().analyses).toEqual([{ dir: 'kk_dis' }])
    expect(instance.getSnapshot().listing).toBe(false)
    // No settings file: the analysis has no recorded agent session.
    expect(instance.getSnapshot().agentSessions).toEqual({})
  })

  it('restores each analysis agent session from its settings file on list', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { text: '{"agentSessionId":"sx"}', version: 'v1', offset: 1, eof: true, lines: 1 },
      }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    // The mapping is seeded from the analysis's persisted settings file.
    expect(instance.getSnapshot().agentSessions).toEqual({ kk_dis: 'sx' })
  })

  it('does not restore the mapping when the list is aborted mid-restore', async () => {
    // A deferred settings read keeps the restore in flight so the test can
    // abort between the analyses settle and the mapping write.
    let resolveRead: (value: unknown) => void = () => {}
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRead = resolve })),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.listAnalyses('/ws', SESSION, controller.signal)
    await tick()
    controller.abort()
    resolveRead({ ok: true, value: { text: '{"agentSessionId":"sx"}', version: 'v1', offset: 1, eof: true, lines: 1 } })
    await tick()
    expect(instance.getSnapshot().agentSessions).toEqual({})
  })

  it('restores an analysis agent session from a matching live session cwd', async () => {
    // The settings file is absent, but a live session with the analysis's cwd
    // exists in the durable Session list — the restore recovers it from there.
    // A session with an unrelated cwd (and one with no update time) is ignored.
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'workspace-file/not-found', message: 'gone' },
      }),
    )
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(undefined, {
      sx: { cwd: '/ws/LLMPWA/analyses/kk_dis' },
      other: { cwd: '/elsewhere', updatedAt: 99 },
    })
    const { face } = makeFace(r, sessions, makeWorkspaces(), instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().agentSessions).toEqual({ kk_dis: 'sx' })
  })

  it('restores the most recently updated of several matching sessions', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'workspace-file/not-found', message: 'gone' },
      }),
    )
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(undefined, {
      old: { cwd: '/ws/LLMPWA/analyses/kk_dis', updatedAt: 10 },
      fresh: { cwd: '/ws/LLMPWA/analyses/kk_dis', updatedAt: 30 },
      untimed: { cwd: '/ws/LLMPWA/analyses/kk_dis' },
    })
    const { face } = makeFace(r, sessions, makeWorkspaces(), instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().agentSessions).toEqual({ kk_dis: 'fresh' })
  })

  it('creates one workspace record per analysis on list', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }, { name: 'kk_new', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'workspace-file/not-found', message: 'gone' },
      }),
    )
    const instance = createWorkbenchStore().create()
    const workspaces = makeWorkspaces()
    const { face } = makeFace(r, makeSessions(), workspaces, instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    // Each analysis directory gets a workspace record so agent sessions group
    // under it instead of the Ungrouped bucket.
    expect(workspaces.create).toHaveBeenCalledWith({ path: '/ws/LLMPWA/analyses/kk_dis' })
    expect(workspaces.create).toHaveBeenCalledWith({ path: '/ws/LLMPWA/analyses/kk_new' })
  })

  it('does not recreate an already-registered analysis workspace', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'workspace-file/not-found', message: 'gone' },
      }),
    )
    const instance = createWorkbenchStore().create()
    const workspaces = makeWorkspaces([{ workspaceId: 'ws-existing', path: '/ws/LLMPWA/analyses/kk_dis' }])
    const { face } = makeFace(r, makeSessions(), workspaces, instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    // The path is already registered, so the verb resolves the existing record
    // and does not issue a second create.
    expect(workspaces.create).not.toHaveBeenCalled()
  })

  it('migrates a previously ungrouped analysis session into its workspace on list', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'workspace-file/not-found', message: 'gone' },
      }),
    )
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(undefined, {
      sx: { cwd: '/ws/LLMPWA/analyses/kk_dis' },
      unrelated: { cwd: '/elsewhere', updatedAt: 99 },
    })
    const workspaces = makeWorkspaces([{ workspaceId: 'ws-kk', path: '/ws/LLMPWA/analyses/kk_dis' }])
    const { face } = makeFace(r, sessions, workspaces, instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    // The session whose cwd is the analysis directory is accounted to its workspace.
    expect(workspaces.attachSession).toHaveBeenCalledWith('ws-kk', 'sx')
    // An unrelated session is not migrated.
    expect(workspaces.attachSession).not.toHaveBeenCalledWith('ws-kk', 'unrelated')
  })

  it('does not migrate a session already accounted to the analysis workspace', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'workspace-file/not-found', message: 'gone' },
      }),
    )
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(undefined, {
      sx: { cwd: '/ws/LLMPWA/analyses/kk_dis' },
    })
    const workspaces = makeWorkspaces([
      { workspaceId: 'ws-kk', path: '/ws/LLMPWA/analyses/kk_dis', sessionIds: ['sx'] },
    ])
    const { face } = makeFace(r, sessions, workspaces, instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    expect(workspaces.attachSession).not.toHaveBeenCalled()
  })

  it('loads a snapshot into the store', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { text: '{"schema_version":1,"stages":[]}', version: 'v1', offset: 1, eof: true, lines: 1 },
      }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadSnapshot(SESSION, 'kk_dis', new AbortController().signal)
    expect(instance.getSnapshot().snapshot).toEqual({ kind: 'loading' })
    await tick()
    expect(instance.getSnapshot().snapshot).toMatchObject({ kind: 'ready' })
  })

  it('records a failure when the read fails', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadSnapshot(SESSION, 'kk_dis', new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().snapshot).toMatchObject({ kind: 'failed', error: { kind: 'missing' } })
  })

  it('does not start a list read when the signal is already aborted', () => {
    const r = remote(vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }), vi.fn())
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.listAnalyses('/ws', SESSION, controller.signal)
    expect(instance.getSnapshot().listing).toBe(false)
    expect(r.workspaceFiles.list).not.toHaveBeenCalled()
  })

  it('does not start a snapshot read when the signal is already aborted', () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({ ok: true, value: {} }))
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.loadSnapshot(SESSION, 'kk_dis', controller.signal)
    expect(instance.getSnapshot().snapshot).toEqual({ kind: 'idle' })
    expect(r.workspaceFiles.read).not.toHaveBeenCalled()
  })

  it('records a failure for a snapshot that parses to null', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({
      ok: true,
      value: { text: 'null', version: 'v1', offset: 1, eof: true, lines: 1 },
    }))
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadSnapshot(SESSION, 'kk_dis', new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().snapshot).toMatchObject({ kind: 'failed', error: { kind: 'unexpected' } })
  })

  it('suppresses a snapshot settlement after the caller aborted', async () => {
    let resolveRead: (value: unknown) => void = () => {}
    const r = remote(
      vi.fn(),
      vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRead = resolve })),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.loadSnapshot(SESSION, 'kk_dis', controller.signal)
    controller.abort()
    resolveRead({ ok: true, value: { text: '{"schema_version":1}', version: 'v1', offset: 1, eof: true, lines: 1 } })
    await tick()
    // The settlement writes nothing: the snapshot stays in-flight.
    expect(instance.getSnapshot().snapshot).toEqual({ kind: 'loading' })
  })

  it('suppresses a settlement after the caller aborted', async () => {
    let resolveRead: (value: unknown) => void = () => {}
    const r = remote(
      vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRead = resolve })),
      vi.fn(),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.listAnalyses('/ws', SESSION, controller.signal)
    controller.abort()
    resolveRead({ ok: true, value: { entries: [{ name: 'kk_dis', type: 'directory' }] } })
    await tick()
    // The settlement writes nothing: the analyses list stays empty.
    expect(instance.getSnapshot().analyses).toEqual([])
  })

  it('lists reference files into the store', async () => {
    const r = remote(
      vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { entries: [{ name: 'resonances_config.toml', type: 'file' }] } })
        .mockResolvedValueOnce({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }),
      vi.fn(),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.listReferences(SESSION, 'kk_dis', new AbortController().signal)
    expect(instance.getSnapshot().referencesListing).toBe(true)
    await tick()
    expect(instance.getSnapshot().references).toEqual([
      { path: 'LLMPWA/analyses/kk_dis/resonances_config.toml', name: 'resonances_config.toml' },
    ])
    expect(instance.getSnapshot().referencesListing).toBe(false)
  })

  it('loads a reference file text into the store', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: true, value: { text: '# title', version: 'v1', offset: 1, eof: true, lines: 1 } }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadReference(SESSION, 'p.toml', new AbortController().signal)
    expect(instance.getSnapshot().reference).toEqual({ kind: 'loading', path: 'p.toml' })
    await tick()
    expect(instance.getSnapshot().reference).toEqual({ kind: 'ready', path: 'p.toml', text: '# title' })
  })

  it('renders a reference image without reading its text', async () => {
    const read = vi.fn()
    const r = remote(vi.fn(), read)
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadReference(SESSION, '4_图片/pictures/fig.png', new AbortController().signal)
    // An image is settled as ready-image immediately and never read as text.
    expect(instance.getSnapshot().reference).toEqual({ kind: 'ready-image', path: '4_图片/pictures/fig.png' })
    expect(read).not.toHaveBeenCalled()
  })

  it('records a reference read failure', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadReference(SESSION, 'p.toml', new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().reference).toMatchObject({
      kind: 'failed', path: 'p.toml', error: { kind: 'missing' },
    })
  })

  it('does not start a reference list read when the signal is already aborted', () => {
    const r = remote(vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }), vi.fn())
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.listReferences(SESSION, 'kk_dis', controller.signal)
    expect(instance.getSnapshot().referencesListing).toBe(false)
    expect(r.workspaceFiles.list).not.toHaveBeenCalled()
  })

  it('does not start a reference read when the signal is already aborted', () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({ ok: true, value: {} }))
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.loadReference(SESSION, 'p.toml', controller.signal)
    expect(instance.getSnapshot().reference).toEqual({ kind: 'idle' })
    expect(r.workspaceFiles.read).not.toHaveBeenCalled()
  })

  it('suppresses a reference list settlement after the caller aborted', async () => {
    let resolveList: (value: unknown) => void = () => {}
    const listPromise = new Promise((resolve) => { resolveList = resolve })
    const r = remote(
      vi.fn().mockImplementation(() => listPromise),
      vi.fn(),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.listReferences(SESSION, 'kk_dis', controller.signal)
    controller.abort()
    resolveList({ ok: true, value: { entries: [{ name: 'resonances_config.toml', type: 'file' }] } })
    await tick()
    expect(instance.getSnapshot().references).toEqual([])
  })

  it('suppresses a reference read settlement after the caller aborted', async () => {
    let resolveRead: (value: unknown) => void = () => {}
    const r = remote(
      vi.fn(),
      vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRead = resolve })),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.loadReference(SESSION, 'p.toml', controller.signal)
    controller.abort()
    resolveRead({ ok: true, value: { text: 'hi', version: 'v1', offset: 1, eof: true, lines: 1 } })
    await tick()
    expect(instance.getSnapshot().reference).toEqual({ kind: 'loading', path: 'p.toml' })
  })

  it('opens an agent session scoped to the analysis and persists its id', async () => {
    const write = vi.fn().mockResolvedValue({ ok: true, value: { version: 'v1', operation: 'create' } })
    const r = remote(vi.fn(), vi.fn(), write)
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions()
    const workspaces = makeWorkspaces([{ workspaceId: 'ws-kk', path: '/ws/LLMPWA/analyses/kk_dis' }])
    const { face, openSession } = makeFace(r, sessions, workspaces, instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis')
    expect(instance.getSnapshot().agent).toEqual({ kind: 'opening' })
    await tick()
    expect(sessions.create).toHaveBeenCalledWith({ workspaceId: 'ws-kk' })
    await tick()
    expect(openSession).toHaveBeenCalledWith('sess-1' as SessionId)
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'sess-1' as SessionId })
    expect(instance.getSnapshot().agentSessions.kk_dis).toBe('sess-1')
    // The opened session id is persisted to the analysis's settings file.
    expect(write).toHaveBeenCalledWith(SESSION, {
      path: 'LLMPWA/analyses/kk_dis/.dsh/agent.json',
      content: '{"agentSessionId":"sess-1"}',
    }, expect.any(AbortSignal))
  })

  it('reuses a live recorded agent session instead of creating a new one', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(undefined, { sx: {} })
    const { face, openSession } = makeFace(r, sessions, makeWorkspaces(), instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis', 'sx' as SessionId)
    // No create; the existing session is opened as current and stays recorded.
    expect(sessions.create).not.toHaveBeenCalled()
    expect(openSession).toHaveBeenCalledWith('sx' as SessionId)
    await tick()
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'sx' as SessionId })
    expect(instance.getSnapshot().agentSessions.kk_dis).toBeUndefined()
  })

  it('launches a fresh session when the recorded one is not in the list', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions()
    const workspaces = makeWorkspaces([{ workspaceId: 'ws-kk', path: '/ws/LLMPWA/analyses/kk_dis' }])
    const { face, openSession } = makeFace(r, sessions, workspaces, instance.actions)
    // A recorded id that no longer appears in the session list is stale, so the
    // face creates a new session for the analysis.
    face.openAgent('/ws', SESSION, 'kk_dis', 'stale' as SessionId)
    await tick()
    expect(sessions.create).toHaveBeenCalledWith({ workspaceId: 'ws-kk' })
    await tick()
    expect(openSession).toHaveBeenCalledWith('sess-1' as SessionId)
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'sess-1' as SessionId })
  })

  it('always launches a fresh session from the new-agent action', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(undefined, { sx: {} })
    const workspaces = makeWorkspaces([{ workspaceId: 'ws-kk', path: '/ws/LLMPWA/analyses/kk_dis' }])
    const { face, openSession } = makeFace(r, sessions, workspaces, instance.actions)
    face.newAgent('/ws', SESSION, 'kk_dis')
    await tick()
    expect(sessions.create).toHaveBeenCalledWith({ workspaceId: 'ws-kk' })
    await tick()
    expect(openSession).toHaveBeenCalledWith('sess-1' as SessionId)
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'sess-1' as SessionId })
    expect(instance.getSnapshot().agentSessions.kk_dis).toBe('sess-1')
  })

  it('records an agent open failure for an Error rejection', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(() => Promise.reject(new Error('boom')))
    const { face, openSession } = makeFace(r, sessions, makeWorkspaces(), instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis')
    await tick()
    expect(instance.getSnapshot().agent).toMatchObject({ kind: 'failed', error: { message: 'boom' } })
    expect(openSession).not.toHaveBeenCalled()
  })

  it('records an agent open failure for a non-Error rejection', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(() => Promise.reject(new Error('gone')))
    const { face } = makeFace(r, sessions, makeWorkspaces(), instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis')
    await tick()
    expect(instance.getSnapshot().agent).toMatchObject({ kind: 'failed', error: { message: 'gone' } })
  })

  it('lists fit tasks and loads each status into the store', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: { text: '{"task_id":"t1","status":"completed"}', version: 'v1', offset: 1, eof: true, lines: 1 },
    })
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 't1', type: 'directory' }] } }),
      read,
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.listTasks(SESSION, 'kk_dis', new AbortController().signal)
    expect(instance.getSnapshot().tasksListing).toBe(true)
    await tick()
    expect(instance.getSnapshot().tasks).toEqual([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    expect(instance.getSnapshot().tasksListing).toBe(false)
    expect(instance.getSnapshot().taskStatuses).toEqual({
      t1: { task_id: 't1', status: 'completed' },
    })
  })

  it('leaves a card status absent when its read fails', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 't1', type: 'directory' }] } }),
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.listTasks(SESSION, 'kk_dis', new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().taskStatuses).toEqual({})
    expect(instance.getSnapshot().tasks).toEqual([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
  })

  it('suppresses a card-status settlement after the caller aborted', async () => {
    let resolveStatus: (value: unknown) => void = () => {}
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 't1', type: 'directory' }] } }),
      vi.fn().mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve })),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.listTasks(SESSION, 'kk_dis', controller.signal)
    await tick()
    expect(instance.getSnapshot().tasks).toEqual([{ id: 't1', dir: 'LLMPWA/analyses/kk_dis/task/t1' }])
    controller.abort()
    resolveStatus({ ok: true, value: { text: '{"task_id":"t1"}', version: 'v1', offset: 1, eof: true, lines: 1 } })
    await tick()
    expect(instance.getSnapshot().taskStatuses).toEqual({})
  })

  it('lists a task directory into the store', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [{ name: 'status.json', type: 'file' }, { name: '1_运行代码', type: 'directory' }] } }),
      vi.fn(),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.listTaskDir(SESSION, 'LLMPWA/analyses/kk_dis/task/t1', new AbortController().signal)
    expect(instance.getSnapshot().taskTreeListing).toEqual({ 'LLMPWA/analyses/kk_dis/task/t1': true })
    await tick()
    expect(instance.getSnapshot().taskTree).toEqual({
      'LLMPWA/analyses/kk_dis/task/t1': [
        { path: 'LLMPWA/analyses/kk_dis/task/t1/status.json', name: 'status.json', kind: 'file' },
        { path: 'LLMPWA/analyses/kk_dis/task/t1/1_运行代码', name: '1_运行代码', kind: 'directory' },
      ],
    })
    expect(instance.getSnapshot().taskTreeListing).toEqual({ 'LLMPWA/analyses/kk_dis/task/t1': false })
  })

  it('loads a task file text into the store', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: true, value: { text: '# title', version: 'v1', offset: 1, eof: true, lines: 1 } }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadTaskFile(SESSION, 'p.md', new AbortController().signal)
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'loading', path: 'p.md' })
    await tick()
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'ready', path: 'p.md', text: '# title' })
  })

  it('renders a task image without reading its text', async () => {
    const read = vi.fn()
    const r = remote(vi.fn(), read)
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadTaskFile(SESSION, '4_图片/pictures/fig.png', new AbortController().signal)
    // An image is settled as ready-image immediately and never read as text.
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'ready-image', path: '4_图片/pictures/fig.png' })
    expect(read).not.toHaveBeenCalled()
  })

  it('records a task file read failure', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    face.loadTaskFile(SESSION, 'p.md', new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().taskFile).toMatchObject({
      kind: 'failed', path: 'p.md', error: { kind: 'missing' },
    })
  })

  it('does not start a task list read when the signal is already aborted', () => {
    const r = remote(vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }), vi.fn())
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.listTasks(SESSION, 'kk_dis', controller.signal)
    expect(instance.getSnapshot().tasksListing).toBe(false)
    expect(r.workspaceFiles.list).not.toHaveBeenCalled()
  })

  it('does not start a task-directory list read when the signal is already aborted', () => {
    const r = remote(vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }), vi.fn())
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.listTaskDir(SESSION, 'LLMPWA/analyses/kk_dis/task/t1', controller.signal)
    expect(instance.getSnapshot().taskTreeListing).toEqual({})
    expect(r.workspaceFiles.list).not.toHaveBeenCalled()
  })

  it('does not start a task file read when the signal is already aborted', () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({ ok: true, value: {} }))
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.loadTaskFile(SESSION, 'p.md', controller.signal)
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'idle' })
    expect(r.workspaceFiles.read).not.toHaveBeenCalled()
  })

  it('suppresses a task-directory list settlement after the caller aborted', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }),
      vi.fn(),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.listTaskDir(SESSION, 'LLMPWA/analyses/kk_dis/task/t1', controller.signal)
    controller.abort()
    await tick()
    expect(instance.getSnapshot().taskTree).toEqual({})
  })

  it('suppresses a task file read settlement after the caller aborted', async () => {
    let resolveRead: (value: unknown) => void = () => {}
    const r = remote(
      vi.fn(),
      vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRead = resolve })),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.loadTaskFile(SESSION, 'p.md', controller.signal)
    controller.abort()
    resolveRead({ ok: true, value: { text: 'hi', version: 'v1', offset: 1, eof: true, lines: 1 } })
    await tick()
    expect(instance.getSnapshot().taskFile).toEqual({ kind: 'loading', path: 'p.md' })
  })

  it('suppresses a task list settlement after the caller aborted', async () => {
    let resolveList: (value: unknown) => void = () => {}
    const r = remote(
      vi.fn().mockImplementation(() => new Promise((resolve) => { resolveList = resolve })),
      vi.fn(),
    )
    const instance = createWorkbenchStore().create()
    const { face } = makeFace(r, makeSessions(), makeWorkspaces(), instance.actions)
    const controller = new AbortController()
    face.listTasks(SESSION, 'kk_dis', controller.signal)
    controller.abort()
    resolveList({ ok: true, value: { entries: [{ name: 't1', type: 'directory' }] } })
    await tick()
    expect(instance.getSnapshot().tasks).toEqual([])
  })

  it('records an agent launch failure for a non-Error rejection', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    // A non-Error rejection still surfaces the launch failure; the string arm
    // makes the face's `cause instanceof Error` branch observable.
    // oxlint-disable-next-line prefer-promise-reject-errors -- a non-Error rejection is the case under test.
    const sessions = makeSessions(() => Promise.reject('boom'))
    const { face } = makeFace(r, sessions, makeWorkspaces(), instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis')
    await tick()
    expect(instance.getSnapshot().agent).toMatchObject({ kind: 'failed', error: { message: 'boom' } })
  })
})
