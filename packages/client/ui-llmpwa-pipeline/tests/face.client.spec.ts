/**
 * The inject face: performs the Remote read and writes the outcome through the
 * store's own actions, suppressing settlements after the caller aborts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWorkbenchStore } from '../src/client/store.ts'
import { workbenchFace } from '../src/client/face.ts'
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

function makeSessions(
  createImpl?: () => Promise<unknown>,
  byId: Record<string, unknown> = {},
): ISessions {
  return {
    create: vi.fn(createImpl ?? (() => Promise.resolve('sess-1' as SessionId))),
    open: vi.fn(),
    list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) },
  } as unknown as ISessions
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, sessions)(instance.actions)
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
    const face = workbenchFace(r, sessions)(instance.actions)
    face.listAnalyses('/ws', SESSION, new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().agentSessions).toEqual({ kk_dis: 'fresh' })
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
    face.loadSnapshot(SESSION, 'kk_dis', new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().snapshot).toMatchObject({ kind: 'failed', error: { kind: 'missing' } })
  })

  it('does not start a list read when the signal is already aborted', () => {
    const r = remote(vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }), vi.fn())
    const instance = createWorkbenchStore().create()
    const face = workbenchFace(r, makeSessions())(instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.listAnalyses('/ws', SESSION, controller.signal)
    expect(instance.getSnapshot().listing).toBe(false)
    expect(r.workspaceFiles.list).not.toHaveBeenCalled()
  })

  it('does not start a snapshot read when the signal is already aborted', () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({ ok: true, value: {} }))
    const instance = createWorkbenchStore().create()
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
    face.listReferences(SESSION, 'kk_dis', new AbortController().signal)
    expect(instance.getSnapshot().referencesListing).toBe(true)
    await tick()
    expect(instance.getSnapshot().references).toEqual([
      { path: `${'LLMPWA/analyses'}/kk_dis/resonances_config.toml`, name: 'resonances_config.toml' },
    ])
    expect(instance.getSnapshot().referencesListing).toBe(false)
  })

  it('loads a reference file text into the store', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: true, value: { text: '# title', version: 'v1', offset: 1, eof: true, lines: 1 } }),
    )
    const instance = createWorkbenchStore().create()
    const face = workbenchFace(r, makeSessions())(instance.actions)
    face.loadReference(SESSION, 'p.toml', new AbortController().signal)
    expect(instance.getSnapshot().reference).toEqual({ kind: 'loading', path: 'p.toml' })
    await tick()
    expect(instance.getSnapshot().reference).toEqual({ kind: 'ready', path: 'p.toml', text: '# title' })
  })

  it('records a reference read failure', async () => {
    const r = remote(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }),
    )
    const instance = createWorkbenchStore().create()
    const face = workbenchFace(r, makeSessions())(instance.actions)
    face.loadReference(SESSION, 'p.toml', new AbortController().signal)
    await tick()
    expect(instance.getSnapshot().reference).toMatchObject({
      kind: 'failed', path: 'p.toml', error: { kind: 'missing' },
    })
  })

  it('does not start a reference list read when the signal is already aborted', () => {
    const r = remote(vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }), vi.fn())
    const instance = createWorkbenchStore().create()
    const face = workbenchFace(r, makeSessions())(instance.actions)
    const controller = new AbortController()
    controller.abort()
    face.listReferences(SESSION, 'kk_dis', controller.signal)
    expect(instance.getSnapshot().referencesListing).toBe(false)
    expect(r.workspaceFiles.list).not.toHaveBeenCalled()
  })

  it('does not start a reference read when the signal is already aborted', () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({ ok: true, value: {} }))
    const instance = createWorkbenchStore().create()
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, makeSessions())(instance.actions)
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
    const face = workbenchFace(r, sessions)(instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis')
    expect(instance.getSnapshot().agent).toEqual({ kind: 'opening' })
    expect(sessions.create).toHaveBeenCalledWith({ cwd: '/ws/LLMPWA/analyses/kk_dis' })
    await tick()
    expect(sessions.open).toHaveBeenCalledWith('sess-1' as SessionId)
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
    const face = workbenchFace(r, sessions)(instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis', 'sx' as SessionId)
    // No create; the existing session is opened as current and stays recorded.
    expect(sessions.create).not.toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('sx' as SessionId)
    await tick()
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'sx' as SessionId })
    expect(instance.getSnapshot().agentSessions.kk_dis).toBeUndefined()
  })

  it('launches a fresh session when the recorded one is not in the list', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions()
    const face = workbenchFace(r, sessions)(instance.actions)
    // A recorded id that no longer appears in the session list is stale, so the
    // face creates a new session for the analysis.
    face.openAgent('/ws', SESSION, 'kk_dis', 'stale' as SessionId)
    expect(sessions.create).toHaveBeenCalled()
    await tick()
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'sess-1' as SessionId })
  })

  it('always launches a fresh session from the new-agent action', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(undefined, { sx: {} })
    const face = workbenchFace(r, sessions)(instance.actions)
    face.newAgent('/ws', SESSION, 'kk_dis')
    expect(sessions.create).toHaveBeenCalledWith({ cwd: '/ws/LLMPWA/analyses/kk_dis' })
    await tick()
    expect(instance.getSnapshot().agent).toEqual({ kind: 'ready', sessionId: 'sess-1' as SessionId })
    expect(instance.getSnapshot().agentSessions.kk_dis).toBe('sess-1')
  })

  it('records an agent open failure for an Error rejection', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(() => Promise.reject(new Error('boom')))
    const face = workbenchFace(r, sessions)(instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis')
    await tick()
    expect(instance.getSnapshot().agent).toMatchObject({ kind: 'failed', error: { message: 'boom' } })
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('records an agent open failure for a non-Error rejection', async () => {
    const r = remote(vi.fn(), vi.fn())
    const instance = createWorkbenchStore().create()
    const sessions = makeSessions(() => Promise.reject('gone'))
    const face = workbenchFace(r, sessions)(instance.actions)
    face.openAgent('/ws', SESSION, 'kk_dis')
    await tick()
    expect(instance.getSnapshot().agent).toMatchObject({ kind: 'failed', error: { message: 'gone' } })
  })
})
