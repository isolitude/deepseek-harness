/** The `write` endpoint: workspace confinement, parent-directory creation, and the sandbox gate. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { WorkspaceFiles } from '../src/index.ts'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-write-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (): ReturnType<Harness['endpoint']> => harness.endpoint()
const write = (path: string, content: string) =>
  endpoint().write(harness.agent, { path, content }, signal())

describe('workspaceFiles.write — the happy path', () => {
  it('creates the file and its missing parent directories', async () => {
    const result = await write('a/nested/agent.json', '{"ready":true}')
    expect(result.operation).toBe('create')
    expect(result.absolutePath.endsWith('a/nested/agent.json')).toBe(true)
    expect(await readFile(join(workspace, 'a/nested/agent.json'), 'utf8')).toBe('{"ready":true}')
  })

  it('replaces an existing file and reports an update', async () => {
    await write('agent.json', '{"v":1}')
    const result = await write('agent.json', '{"v":2}')
    expect(result.operation).toBe('update')
    expect(await readFile(join(workspace, 'agent.json'), 'utf8')).toBe('{"v":2}')
  })
})

describe('workspaceFiles.write — the gates', () => {
  it('refuses a path outside the workspace root', async () => {
    await mkdir(outside, { recursive: true })
    const failure = await failureOf(write('../outside/agent.json', 'x'))
    expect(failure.code).toBe('workspace-file/outside-workspace')
  })

  it('refuses an outside path through a symlink that leaves the workspace', async () => {
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(workspace, 'leak'))
    const failure = await failureOf(write('leak/agent.json', 'x'))
    expect(failure.code).toBe('workspace-file/outside-workspace')
  })

  it('rejects an empty path as a bad request', async () => {
    const failure = await failureOf(endpoint().write(harness.agent, { path: '', content: '' }, signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })

  it('rethrows a non-sandbox write failure unmapped', async () => {
    // Writing over an existing directory fails inside the backend's atomic
    // replace, surfaced as a non-sandbox FsError; the service must rethrow it
    // unchanged rather than mapping it to the sandbox write-denied code.
    await mkdir(join(workspace, 'adir'))
    await expect(endpoint().write(harness.agent, { path: 'adir', content: 'x' }, signal())).rejects.toThrow()
  })

  it('maps a read-only sandbox denial to a structured write-denied error', async () => {
    // The shared harness mounts the bare LocalFileSystem (which never denies a
    // write), so a read-only denial only arises under the sandboxing backend.
    // Provide a minimal sandbox policy stub and mount the sandboxing fs that
    // enforces it, then one service against that context.
    const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-files-write-denied-'))
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    const ctx = new Context()
    ctx.provide('sandboxPolicy', {
      defaultMode: 'read-only' as const,
      workspaceRoot,
      resolve: () => ({ mode: 'read-only' as const, workspaceRoot }),
    } as never)
    const fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspaceRoot })
    const service = new WorkspaceFiles(ctx, {
      maxBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxLines: 5000,
      maxEntries: 2000,
    })
    try {
      const failure = await failureOf(service.write(harness.agent, { path: 'agent.json', content: 'x' }, signal()))
      expect(failure.code).toBe('workspace-file/write-denied')
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
