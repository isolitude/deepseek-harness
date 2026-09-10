/**
 * The Remote read layer: listing analyses and loading/parsing a snapshot over
 * a scripted `workspaceFiles` namespace, plus the missing-snapshot hint.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ANALYSES_ROOT,
  analysisSettingsPath,
  listAnalyses, loadSnapshot, missingSnapshotHint, PIPELINE_STATE_FILE,
  listReferenceFiles, loadReferenceText,
  readAnalysisAgentSession, writeAnalysisAgentSession,
  type WorkspaceFilesLoadRemote,
} from '../src/client/load.ts'

const SESSION = 's1' as SessionId

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

describe('listAnalyses', () => {
  it('lists only directory entries under the analyses root', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          entries: [
            { name: 'kk_dis', type: 'directory' },
            { name: 'notes.txt', type: 'file' },
            { name: 'other', type: 'other' },
          ],
        },
      }),
      vi.fn(),
    )
    const analyses = await listAnalyses(r, SESSION, new AbortController().signal)
    expect(r.workspaceFiles.list).toHaveBeenCalledWith(SESSION, ANALYSES_ROOT, expect.any(AbortSignal))
    expect(analyses).toEqual([{ dir: 'kk_dis' }])
  })

  it('returns an empty list when the read fails', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-file/denied', message: 'nope' } }),
      vi.fn(),
    )
    expect(await listAnalyses(r, SESSION, new AbortController().signal)).toEqual([])
  })
})

describe('loadSnapshot', () => {
  const page = (text: string): unknown => ({
    ok: true,
    value: { text, version: 'v1', offset: 1, eof: true, lines: 1 },
  })

  it('parses a JSON snapshot on one page', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue(page('{"schema_version":1,"stages":[]}')))
    const load = await loadSnapshot(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(r.workspaceFiles.read).toHaveBeenCalledWith(
      SESSION, `${ANALYSES_ROOT}/kk_dis/${PIPELINE_STATE_FILE}`, { offset: 1 }, expect.any(AbortSignal),
    )
    expect(load.ok).toBe(true)
    expect(load.snapshot?.schema_version).toBe(1)
  })

  it('reports a missing snapshot for a not-found read', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'workspace-file/not-found', message: 'gone' },
    }))
    const load = await loadSnapshot(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(load).toEqual({ ok: false, error: { kind: 'missing', message: 'gone' } })
  })

  it('reports an unexpected failure for a non-missing read error', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'workspace-file/denied', message: 'denied' },
    }))
    const load = await loadSnapshot(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(load.error?.kind).toBe('unexpected')
  })

  it('reports a parse failure for malformed JSON', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue(page('{ nope')))
    const load = await loadSnapshot(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(load.ok).toBe(false)
    expect(load.error?.kind).toBe('parse')
  })

  it('concatenates multiple capped pages until the file ends', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { text: '{"schema_version":1,', version: 'v1', offset: 1, eof: false, lines: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { text: '"stages":[]}', version: 'v1', offset: 2, eof: true, lines: 1 } })
    const r = remote(vi.fn(), read)
    const load = await loadSnapshot(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(read).toHaveBeenCalledTimes(2)
    expect(load.ok).toBe(true)
    expect(load.snapshot?.schema_version).toBe(1)
  })

  it('stops at a page past the last line (zero lines)', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: { text: '', version: 'v1', offset: 1, eof: false, lines: 0 },
    })
    const r = remote(vi.fn(), read)
    const load = await loadSnapshot(r, SESSION, 'kk_dis', new AbortController().signal)
    // No content was read; an empty document is not valid JSON.
    expect(load.ok).toBe(false)
    expect(load.error?.kind).toBe('parse')
  })
})

describe('missingSnapshotHint', () => {
  it('builds the export command for the analysis', () => {
    expect(missingSnapshotHint('kk_dis')).toContain('pipeline_state.py')
    expect(missingSnapshotHint('kk_dis')).toContain('LLMPWA/analyses/kk_dis')
  })
})

describe('listReferenceFiles', () => {
  const rootEntries = [
    { name: 'resonances_config.toml', type: 'file' },
    { name: 'resonances_config_ctrl.toml', type: 'file' },
    { name: 'llm_config_fit.toml', type: 'file' },
    { name: 'node_config.toml', type: 'file' },
    { name: 'README.md', type: 'file' },
    { name: 'gen', type: 'directory' },
  ]

  it('collects resonance configs and document files, ignoring the rest', async () => {
    const r = remote(
      vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { entries: rootEntries } })
        .mockResolvedValueOnce({ ok: true, value: { entries: [
          { name: 'combined_likelihood_math.md', type: 'file' },
          { name: 'sub', type: 'directory' },
        ] } }),
      vi.fn(),
    )
    const files = await listReferenceFiles(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(r.workspaceFiles.list).toHaveBeenNthCalledWith(
      1, SESSION, `${ANALYSES_ROOT}/kk_dis`, expect.any(AbortSignal),
    )
    expect(r.workspaceFiles.list).toHaveBeenNthCalledWith(
      2, SESSION, `${ANALYSES_ROOT}/kk_dis/document`, expect.any(AbortSignal),
    )
    expect(files).toEqual([
      { path: `${ANALYSES_ROOT}/kk_dis/document/combined_likelihood_math.md`, name: 'document/combined_likelihood_math.md' },
      { path: `${ANALYSES_ROOT}/kk_dis/resonances_config.toml`, name: 'resonances_config.toml' },
      { path: `${ANALYSES_ROOT}/kk_dis/resonances_config_ctrl.toml`, name: 'resonances_config_ctrl.toml' },
    ])
  })

  it('skips a missing document directory', async () => {
    const r = remote(
      vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { entries: rootEntries } })
        .mockResolvedValueOnce({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }),
      vi.fn(),
    )
    const files = await listReferenceFiles(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(files).toHaveLength(2)
    expect(files[0]?.name).toBe('resonances_config.toml')
  })

  it('skips a failed analysis-root listing', async () => {
    const r = remote(
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-file/denied', message: 'nope' } }),
      vi.fn(),
    )
    const files = await listReferenceFiles(r, SESSION, 'kk_dis', new AbortController().signal)
    expect(files).toEqual([])
  })
})

describe('loadReferenceText', () => {
  const page = (text: string, eof = true): unknown => ({
    ok: true,
    value: { text, version: 'v1', offset: 1, eof, lines: 1 },
  })

  it('reads one reference file on a single page', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue(page('# title')))
    const load = await loadReferenceText(r, SESSION, `${ANALYSES_ROOT}/kk_dis/resonances_config.toml`, new AbortController().signal)
    expect(r.workspaceFiles.read).toHaveBeenCalledWith(
      SESSION, `${ANALYSES_ROOT}/kk_dis/resonances_config.toml`, { offset: 1 }, expect.any(AbortSignal),
    )
    expect(load).toEqual({ ok: true, text: '# title' })
  })

  it('reports a missing reference file for a not-found read', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'workspace-file/not-found', message: 'gone' },
    }))
    const load = await loadReferenceText(r, SESSION, 'x.toml', new AbortController().signal)
    expect(load).toEqual({ ok: false, error: { kind: 'missing', message: 'gone' } })
  })

  it('reports an unexpected failure for a non-missing read error', async () => {
    const r = remote(vi.fn(), vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'workspace-file/denied', message: 'denied' },
    }))
    const load = await loadReferenceText(r, SESSION, 'x.toml', new AbortController().signal)
    expect(load).toEqual({ ok: false, error: { kind: 'unexpected', message: 'denied' } })
  })

  it('concatenates multiple capped pages until the file ends', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { text: 'abc', version: 'v1', offset: 1, eof: false, lines: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { text: 'def', version: 'v1', offset: 2, eof: true, lines: 1 } })
    const r = remote(vi.fn(), read)
    const load = await loadReferenceText(r, SESSION, 'x.md', new AbortController().signal)
    expect(read).toHaveBeenCalledTimes(2)
    expect(load).toEqual({ ok: true, text: 'abc\ndef' })
  })
})

describe('analysis agent-session settings', () => {
  it('builds the per-analysis settings path', () => {
    expect(analysisSettingsPath('kk_dis')).toBe('LLMPWA/analyses/kk_dis/.dsh/agent.json')
  })

  it('reads the recorded agent session id from a well-formed settings file', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: { text: '{"agentSessionId":"sx"}', version: 'v1', offset: 1, eof: true, lines: 1 },
    })
    const id = await readAnalysisAgentSession(remote(vi.fn(), read), SESSION, 'kk_dis', new AbortController().signal)
    expect(id).toBe('sx')
    // The settings path is the per-analysis agent settings file.
    expect(read).toHaveBeenCalledWith(SESSION, 'LLMPWA/analyses/kk_dis/.dsh/agent.json', { offset: 1 }, expect.any(AbortSignal))
  })

  it('yields no session when the settings file is absent', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'workspace-file/not-found', message: 'gone' },
    })
    const id = await readAnalysisAgentSession(remote(vi.fn(), read), SESSION, 'kk_dis', new AbortController().signal)
    expect(id).toBeUndefined()
  })

  it('yields no session for malformed or non-object settings', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: { text: '[1,2,3]', version: 'v1', offset: 1, eof: true, lines: 1 },
    })
    const id = await readAnalysisAgentSession(remote(vi.fn(), read), SESSION, 'kk_dis', new AbortController().signal)
    expect(id).toBeUndefined()
  })

  it('yields no session when the recorded id is not a string', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: { text: '{"agentSessionId":42}', version: 'v1', offset: 1, eof: true, lines: 1 },
    })
    const id = await readAnalysisAgentSession(remote(vi.fn(), read), SESSION, 'kk_dis', new AbortController().signal)
    expect(id).toBeUndefined()
  })

  it('yields no session for an unparseable settings file', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: { text: '{not-json', version: 'v1', offset: 1, eof: true, lines: 1 },
    })
    const id = await readAnalysisAgentSession(remote(vi.fn(), read), SESSION, 'kk_dis', new AbortController().signal)
    expect(id).toBeUndefined()
  })

  it('writes the agent session id to the settings file', async () => {
    const write = vi.fn().mockResolvedValue({ ok: true, value: { version: 'v1', operation: 'create' } })
    const ok = await writeAnalysisAgentSession(remote(vi.fn(), vi.fn(), write), SESSION, 'kk_dis', 'sx' as SessionId, new AbortController().signal)
    expect(ok).toBe(true)
    expect(write).toHaveBeenCalledWith(SESSION, {
      path: 'LLMPWA/analyses/kk_dis/.dsh/agent.json',
      content: '{"agentSessionId":"sx"}',
    }, expect.any(AbortSignal))
  })

  it('reports a failed settings write', async () => {
    const write = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'workspace-file/write-denied', message: 'denied' },
    })
    const ok = await writeAnalysisAgentSession(remote(vi.fn(), vi.fn(), write), SESSION, 'kk_dis', 'sx' as SessionId, new AbortController().signal)
    expect(ok).toBe(false)
  })
})
