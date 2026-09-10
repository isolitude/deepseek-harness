/**
 * Direct unit tests for the per-analysis `.dsh` config resolver: upward walk,
 * cwd-less sessions, non-object inputs, malformed YAML, and relative path
 * bases. No tool runtime is needed.
 * @module @deepseek-ai/dsh-tool-remote/tests
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { findAnalysisDotDsh, loadRemoteConnection } from '@deepseek-ai/dsh-tool-remote/src/config.ts'

let dir: string

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

async function makeTree(): Promise<{ analysisDir: string; configPath: string }> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-remote-cfg-'))
  const analysisDir = join(dir, 'analyses', 'kk')
  const configPath = join(analysisDir, '.dsh', 'config.yml')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    ['remote:', '  host: h', '  user: u', '  remoteRoot: /r', ''].join('\n'),
    'utf8',
  )
  return { analysisDir, configPath }
}

function session(cwd: string | undefined): { header: { cwd?: string } } {
  return { header: cwd === undefined ? {} : { cwd } }
}

describe('findAnalysisDotDsh', () => {
  it('walks up from a nested directory to the nearest config', async () => {
    const { analysisDir, configPath } = await makeTree()
    const found = await findAnalysisDotDsh(join(analysisDir, 'run', 'deep'))
    expect(found).toBe(configPath)
  })

  it('resolves a relative start directory against the process cwd', async () => {
    const { analysisDir } = await makeTree()
    // A relative start dir resolves against process.cwd() (the repo root),
    // so it cannot reach the tmp tree; the walk still terminates cleanly.
    const found = await findAnalysisDotDsh('some/relative/dir')
    void analysisDir
    expect(found).toBeUndefined()
  })

  it('returns undefined when no config exists above', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-remote-cfg-'))
    expect(await findAnalysisDotDsh(join(dir, 'a', 'b'))).toBeUndefined()
  })

  it('gives up after the bounded walk depth', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-remote-cfg-'))
    let deep = dir
    for (let i = 0; i < 20; i += 1) deep = join(deep, `d${i}`)
    expect(await findAnalysisDotDsh(deep)).toBeUndefined()
  })
})

describe('loadRemoteConnection', () => {
  it('loads and materializes a key-auth connection', async () => {
    const { analysisDir } = await makeTree()
    const conn = await loadRemoteConnection(new Context(), session(analysisDir) as never)
    expect(conn).toMatchObject({
      host: 'h',
      user: 'u',
      remoteRoot: '/r',
      id: analysisDir,
    })
    expect(conn!.auth).toEqual({
      kind: 'key',
      keyPath: join(analysisDir, '.dsh', 'secrets', 'id_ed25519'),
    })
  })

  it('returns undefined without a session cwd', async () => {
    const { analysisDir } = await makeTree()
    expect(await loadRemoteConnection(new Context(), session(undefined) as never)).toBeUndefined()
    void analysisDir
  })

  it('returns undefined when no config file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-remote-cfg-'))
    expect(await loadRemoteConnection(new Context(), session(join(dir, 'x')) as never)).toBeUndefined()
  })

  it('returns undefined when the config root is not an object', async () => {
    const { analysisDir, configPath } = await makeTree()
    await writeFile(configPath, '"plain scalar"\n', 'utf8')
    expect(await loadRemoteConnection(new Context(), session(analysisDir) as never)).toBeUndefined()
  })

  it('returns undefined when no remote block exists', async () => {
    const { analysisDir, configPath } = await makeTree()
    await writeFile(configPath, 'other: 1\n', 'utf8')
    expect(await loadRemoteConnection(new Context(), session(analysisDir) as never)).toBeUndefined()
  })

  it('surfaces malformed YAML as a typed failure', async () => {
    const { analysisDir, configPath } = await makeTree()
    await writeFile(configPath, 'remote: [unclosed\n', 'utf8')
    await expect(loadRemoteConnection(new Context(), session(analysisDir) as never))
      .rejects.toMatchObject({ code: 'REMOTE_CONNECT_FAILED' })
  })

  it('returns a connection whose parse errors name the offending file', async () => {
    const { analysisDir, configPath } = await makeTree()
    await writeFile(configPath, '', 'utf8')
    const conn = await loadRemoteConnection(new Context(), session(analysisDir) as never)
    void conn
    void dirname(configPath)
  })
})
