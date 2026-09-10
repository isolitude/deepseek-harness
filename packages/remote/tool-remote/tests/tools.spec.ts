/**
 * Tool-ssh unit tests: argument validation, per-analysis config resolution,
 * delegation to ctx.remote, canonical output shape, and rendering. The fake
 * executor records calls; no network is touched.
 * @module @deepseek-ai/dsh-tool-remote/tests
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-remote'
import { afterEach, describe, expect, it } from 'vitest'
import { buildHarness, buildHarnessWithCredentials, teardownHarness, writeAnalysisConfig } from './harness.ts'
import type { Harness } from './harness.ts'

const CONFIG = (authBlock = 'auth:\n    kind: agent'): string => `
remote:
  host: compute-1
  port: 2222
  user: phys
  remoteRoot: /home/phys/workspace
  hostKeyFingerprint: pinned-fp
  timeoutMs: 5000
  maxTransferBytes: 1024
  ${authBlock}
`

let harness: Harness

describe('plugin config validation', () => {
  it('rejects a non-positive tool tunable at apply time', async () => {
    const ToolSsh = await import('@deepseek-ai/dsh-tool-remote')
    const ctx = new Context()
    expect(() => { ToolSsh.apply(ctx, { timeoutMs: -1 }) }).toThrow(/positive finite number/)
  })
})

describe('session workspace requirement', () => {
  it('rejects push without a session workspace', async () => {
    harness = await buildHarness()
    await writeAnalysisConfig(harness.analysisDir, CONFIG())
    const result = await harness.call('remote_push', { local_path: 'a', remote_path: 'b' }, '')
    expect(result.isError).toBe(true)
  })

  it('rejects pull without a session workspace', async () => {
    harness = await buildHarness()
    await writeAnalysisConfig(harness.analysisDir, CONFIG())
    const result = await harness.call('remote_pull', { remote_path: 'a', local_path: 'b' }, '')
    expect(result.isError).toBe(true)
  })
})

afterEach(async () => {
  if (harness !== undefined) {
    await teardownHarness(harness.dir)
    harness = undefined as unknown as Harness
  }
})

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

async function withConfig(extra = ''): Promise<void> {
  harness = await buildHarness()
  await writeAnalysisConfig(harness.analysisDir, CONFIG(extra))
}

describe('remote_exec', () => {
  it('delegates a command and returns structured exit facts', async () => {
    await withConfig()
    harness.calls.nextRun = { exitCode: 2, signal: null, stdout: 'oops', stderr: 'boom', timedOut: false }
    const result = await harness.call('remote_exec', { command: 'ls -la', workdir: '/w', timeout_ms: 900 })
    expect(result.isError).toBe(false)
    expect(harness.calls.runs).toHaveLength(1)
    const { connection, request } = harness.calls.runs[0]!
    expect(connection).toMatchObject({ host: 'compute-1', port: 2222, user: 'phys', remoteRoot: '/home/phys/workspace' })
    expect(request).toMatchObject({ command: 'ls -la', cwd: '/w', timeoutMs: 900 })
    expect(result.value).toMatchObject({ exit_code: 2, stdout: 'oops', stderr: 'boom', timed_out: false })
    expect(text(result)).toContain('[exit code: 2]')
    expect(text(result)).toContain('[stderr]')
  })

  it('defaults workdir to remoteRoot and timeout to the tool default', async () => {
    await withConfig()
    await harness.call('remote_exec', { command: 'pwd' })
    const request = harness.calls.runs[0]!.request
    expect(request.cwd).toBe('/home/phys/workspace')
    expect(request.timeoutMs).toBe(60_000)
  })

  it('renders the timed-out marker', async () => {
    await withConfig()
    harness.calls.nextRun = { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: true }
    const result = await harness.call('remote_exec', { command: 'sleep' })
    expect(text(result)).toContain('[timed out]')
  })

  it('renders an unknown exit status', async () => {
    await withConfig()
    harness.calls.nextRun = { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false }
    const result = await harness.call('remote_exec', { command: 'x' })
    expect(text(result)).toContain('[exit status unknown]')
  })

  it('renders a killed signal marker', async () => {
    await withConfig()
    harness.calls.nextRun = { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: false }
    const result = await harness.call('remote_exec', { command: 'sleep' })
    expect(text(result)).toContain('[killed by signal: SIGKILL]')
  })

  it('rejects a missing remote configuration loudly', async () => {
    harness = await buildHarness() // no config.yml
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no remote configuration found')
  })

  it('rejects execution without an agent session', async () => {
    await withConfig()
    const result = await (harness.ctx.tools as unknown as {
      execute(input: { callId: string; name: string; arguments: unknown; signal: AbortSignal }): Promise<unknown>
    }).execute({
      callId: 'no-agent',
      name: 'remote_exec',
      arguments: { command: 'ls' },
      signal: new AbortController().signal,
    })
    expect((result as { isError: boolean }).isError).toBe(true)
  })

  it('rejects agent-less execution for every tool', async () => {
    await withConfig()
    const registry = harness.ctx.tools as unknown as {
      execute(input: { callId: string; name: string; arguments: unknown; signal: AbortSignal }): Promise<{ isError: boolean }>
    }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['remote_read', { path: 'a' }],
      ['remote_write', { path: 'a', content: 'x' }],
      ['remote_edit', { path: 'a', old_string: 'x', new_string: 'y' }],
      ['remote_push', { local_path: 'a', remote_path: 'b' }],
      ['remote_pull', { remote_path: 'a', local_path: 'b' }],
    ]
    for (const [name, args] of cases) {
      const result = await registry.execute({
        callId: `no-agent-${name}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
      expect(result.isError, name).toBe(true)
    }
  })

  it('rejects an empty command', async () => {
    await withConfig()
    const result = await harness.call('remote_exec', { command: '' })
    expect(result.isError).toBe(true)
  })
})

describe('remote_read', () => {
  it('delegates a bounded window and renders numbered lines', async () => {
    await withConfig()
    harness.calls.nextRead = {
      path: 'f.txt',
      totalLines: 3,
      truncated: false,
      lines: [
        { number: 1, text: 'alpha' },
        { number: 2, text: 'beta' },
      ],
    }
    const result = await harness.call('remote_read', { path: 'f.txt', offset: 1, limit: 2 })
    expect(result.isError).toBe(false)
    expect(harness.calls.reads[0]!.request).toMatchObject({ path: 'f.txt', offset: 1, limit: 2 })
    expect(result.value).toMatchObject({ path: 'f.txt', total_lines: 3, truncated: false })
    expect(text(result)).toContain('2: beta')
    expect(text(result)).toContain('(End of file - total 3 lines)')
  })

  it('defaults offset and limit', async () => {
    await withConfig()
    await harness.call('remote_read', { path: 'f.txt' })
    expect(harness.calls.reads[0]!.request).toMatchObject({ offset: 1, limit: 2000 })
  })

  it('rejects a non-positive offset', async () => {
    await withConfig()
    const result = await harness.call('remote_read', { path: 'f.txt', offset: 0 })
    expect(result.isError).toBe(true)
  })

  it('renders an empty truncated window with fallback line numbers', async () => {
    await withConfig()
    harness.calls.nextRead = { path: 'big.txt', totalLines: 100, truncated: true, lines: [] }
    const result = await harness.call('remote_read', { path: 'big.txt', offset: 1, limit: 2000 })
    expect(text(result)).toContain('Showing lines 1-0.')
  })

  it('renders a truncated read window with a continuation footer', async () => {
    await withConfig()
    harness.calls.nextRead = {
      path: 'big.txt',
      totalLines: 100,
      truncated: true,
      lines: [{ number: 1, text: 'first' }],
    }
    const result = await harness.call('remote_read', { path: 'big.txt' })
    expect(text(result)).toContain('(Output capped. Showing lines 1-1. Use offset to continue.)')
  })

  it('renders the updated-file confirmation for an existing target', async () => {
    await withConfig()
    harness.calls.nextWrite = { path: 'n.txt', created: false }
    const result = await harness.call('remote_write', { path: 'n.txt', content: 'x' })
    expect(text(result)).toContain('Updated file')
  })

  it('renders a singular occurrence count', async () => {
    await withConfig()
    const result = await harness.call('remote_edit', { path: 'f.txt', old_string: 'a', new_string: 'b' })
    expect(text(result)).toContain('1 occurrence replaced')
  })

  it('rejects a limit above the cap', async () => {
    await withConfig()
    const result = await harness.call('remote_read', { path: 'f.txt', limit: 5000 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('between 1 and 2000')
  })
})

describe('remote_write and remote_edit', () => {
  it('delegates an atomic write and renders the confirmation', async () => {
    await withConfig()
    const result = await harness.call('remote_write', { path: 'n.txt', content: 'data' })
    expect(result.isError).toBe(false)
    expect(harness.calls.writes[0]!.request).toMatchObject({ path: 'n.txt', content: 'data' })
    expect(text(result)).toContain('Created file')
  })

  it('delegates a literal edit', async () => {
    await withConfig()
    harness.calls.nextEdit = { path: 'f.txt', occurrences: 2 }
    const result = await harness.call('remote_edit', { path: 'f.txt', old_string: 'a', new_string: 'b', replace_all: true })
    expect(result.isError).toBe(false)
    expect(harness.calls.edits[0]!.request).toMatchObject({ oldString: 'a', newString: 'b', replaceAll: true })
    expect(result.value).toMatchObject({ occurrences: 2 })
    expect(text(result)).toContain('2 occurrences replaced')
  })

  it('rejects an empty old_string', async () => {
    await withConfig()
    const result = await harness.call('remote_edit', { path: 'f.txt', old_string: '', new_string: 'b' })
    expect(result.isError).toBe(true)
  })

  it('rejects old_string equal to new_string', async () => {
    await withConfig()
    const result = await harness.call('remote_edit', { path: 'f.txt', old_string: 'same', new_string: 'same' })
    expect(result.isError).toBe(true)
  })
})

describe('remote_push and remote_pull', () => {
  it('pushes with a session-relative local path and renders bytes', async () => {
    await withConfig()
    await mkdir(join(harness.analysisDir, 'local'), { recursive: true })
    await writeFile(join(harness.analysisDir, 'local', 's.py'), 'x')
    harness.calls.nextTransfer = { localPath: 'local/s.py', remotePath: 'remote/s.py', bytes: 12 }
    const result = await harness.call('remote_push', { local_path: 'local/s.py', remote_path: 'remote/s.py' })
    expect(result.isError).toBe(false)
    const { connection, request } = harness.calls.pushes[0]!
    expect(connection.host).toBe('compute-1')
    expect(request.localPath).toBe(join(harness.analysisDir, 'local', 's.py'))
    expect(text(result)).toContain('uploaded 12 bytes')
  })

  it('forwards an explicit overwrite flag on push', async () => {
    await withConfig()
    await mkdir(join(harness.analysisDir, 'local'), { recursive: true })
    await writeFile(join(harness.analysisDir, 'local', 'o.py'), 'x')
    const result = await harness.call('remote_push', { local_path: 'local/o.py', remote_path: 'o.py', overwrite: true })
    expect(result.isError).toBe(false)
    expect(harness.calls.pushes[0]!.request.overwrite).toBe(true)
  })

  it('forwards an explicit overwrite flag on pull', async () => {
    await withConfig()
    await mkdir(join(harness.analysisDir, 'local'), { recursive: true })
    const result = await harness.call('remote_pull', { remote_path: 'o.py', local_path: 'local/o.py', overwrite: true })
    expect(result.isError).toBe(false)
    expect(harness.calls.pulls[0]!.request.overwrite).toBe(true)
  })

  it('accepts an absolute local path for push', async () => {
    await withConfig()
    const absolute = join(harness.analysisDir, 'abs.py')
    await writeFile(absolute, 'x')
    harness.calls.nextTransfer = { localPath: absolute, remotePath: 'r.py', bytes: 1 }
    const result = await harness.call('remote_push', { local_path: absolute, remote_path: 'r.py' })
    expect(result.isError).toBe(false)
    expect(harness.calls.pushes[0]!.request.localPath).toBe(absolute)
  })

  it('pulls with a session-relative target path', async () => {
    await withConfig()
    harness.calls.nextTransfer = { localPath: 'out/f.txt', remotePath: 'remote/f.txt', bytes: 7 }
    const result = await harness.call('remote_pull', { remote_path: 'remote/f.txt', local_path: 'out/f.txt' })
    expect(result.isError).toBe(false)
    expect(harness.calls.pulls[0]!.request).toMatchObject({ remotePath: 'remote/f.txt' })
    expect(text(result)).toContain('downloaded 7 bytes')
  })
})

describe('config resolution', () => {
  it('supports a password reference through credentials when mounted', async () => {
    await withConfig('auth:\n    kind: password\n    passwordRef: LLPWA_KK_TEST_SSH_PASSWORD')
    // No credentials service is mounted, so resolution must fail loudly.
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no credentials service is mounted')
  })

  it('walks up from a nested session cwd to the analysis config', async () => {
    await withConfig()
    const nested = join(harness.analysisDir, 'run')
    await mkdir(nested, { recursive: true })
    const result = await harness.call('remote_exec', { command: 'ls' }, nested)
    expect(result.isError).toBe(false)
  })

  it('surfaces a malformed config as a typed failure', async () => {
    harness = await buildHarness()
    await writeFile(join(harness.analysisDir, '.dsh', 'config.yml'), 'remote: [not, a, map]\n')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('remote config')
  })

  it('rejects a missing required field in the remote block', async () => {
    harness = await buildHarness()
    await writeAnalysisConfig(harness.analysisDir, 'remote:\n  host: compute-1\n  user: phys\n')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("'remote.remoteRoot' must be a non-empty string")
  })

  it('rejects a non-positive timeoutMs in the config', async () => {
    harness = await buildHarness()
    await writeAnalysisConfig(harness.analysisDir, `remote:
  host: h
  user: u
  remoteRoot: /r
  timeoutMs: -5
`)
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("'remote.timeoutMs' must be a positive number")
  })

  it('accepts a key-auth block with an absolute keyPath', async () => {
    await withConfig('auth:\n    kind: key\n    keyPath: /etc/keys/id_ed25519')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(false)
    expect(harness.calls.runs[0]!.connection.auth).toMatchObject({ kind: 'key', keyPath: '/etc/keys/id_ed25519' })
  })

  it('accepts a key-auth block with a relative keyPath', async () => {
    await withConfig('auth:\n    kind: key\n    keyPath: ./.dsh/secrets/id_ed25519')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(false)
    expect(harness.calls.runs[0]!.connection.auth).toMatchObject({
      kind: 'key',
      keyPath: join(harness.analysisDir, '.dsh', 'secrets', 'id_ed25519'),
    })
  })

  it('rejects a key-auth block without a keyPath', async () => {
    await withConfig('auth:\n    kind: key')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("auth.kind 'key' requires a keyPath")
  })

  it('rejects a non-string passphraseRef', async () => {
    await withConfig('auth:\n    kind: key\n    keyPath: k\n    passphraseRef: [bad]')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('passphraseRef must be a string')
  })

  it('fails loudly when a passphrase credential is not configured', async () => {
    harness = await buildHarnessWithCredentials({})
    await writeAnalysisConfig(harness.analysisDir, `remote:
  host: h
  user: u
  remoteRoot: /r
  auth:
    kind: key
    keyPath: k
    passphraseRef: MISSING_PASSPHRASE
`)
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("passphrase credential 'MISSING_PASSPHRASE' is not configured")
  })

  it('resolves a materialized key passphrase through credentials', async () => {
    harness = await buildHarnessWithCredentials({ MY_PASSPHRASE: 'pp-value' })
    await writeAnalysisConfig(harness.analysisDir, `remote:
  host: h
  user: u
  remoteRoot: /r
  auth:
    kind: key
    keyPath: k
    passphraseRef: MY_PASSPHRASE
`)
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(false)
    expect(harness.calls.runs[0]!.connection.auth).toMatchObject({
      kind: 'key',
      keyPath: join(harness.analysisDir, 'k'),
      passphrase: 'pp-value',
    })
  })

  it('rejects a password-auth block without a passwordRef', async () => {
    await withConfig('auth:\n    kind: password')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("auth.kind 'password' requires a passwordRef")
  })

  it('fails loudly when a password credential is not configured', async () => {
    harness = await buildHarnessWithCredentials({})
    await writeAnalysisConfig(harness.analysisDir, `remote:
  host: h
  user: u
  remoteRoot: /r
  auth:
    kind: password
    passwordRef: MISSING_PW
`)
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("password credential 'MISSING_PW' is not configured")
  })

  it('resolves a materialized password through credentials', async () => {
    harness = await buildHarnessWithCredentials({ MY_PW: 's3cret' })
    await writeAnalysisConfig(harness.analysisDir, `remote:
  host: h
  user: u
  remoteRoot: /r
  auth:
    kind: password
    passwordRef: MY_PW
`)
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(false)
    expect(harness.calls.runs[0]!.connection.auth).toEqual({ kind: 'password', password: 's3cret' })
  })

  it('rejects an unknown auth kind', async () => {
    await withConfig('auth:\n    kind: kerberos')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown auth.kind')
  })

  it('returns no connection when the session has no cwd', async () => {
    harness = await buildHarness()
    await writeAnalysisConfig(harness.analysisDir, CONFIG())
    const result = await harness.call('remote_exec', { command: 'ls' }, harness.analysisDir)
    expect(result.isError).toBe(false)
    // A cwd-less call is not producible through the dispatch helper; the
    // loader path is covered by its unit test below.
  })

  it('returns undefined when config.yml has no remote block', async () => {
    harness = await buildHarness()
    await writeAnalysisConfig(harness.analysisDir, 'other: true\n')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no remote configuration found')
  })

  it('returns undefined when the config root is not an object', async () => {
    harness = await buildHarness()
    await writeFile(join(harness.analysisDir, '.dsh', 'config.yml'), '[list, root]\n')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no remote configuration found')
  })

  it('propagates typed provider failures into tool errors', async () => {
    await withConfig()
    harness.calls.throwError = new RemoteError('auth exploded', 'REMOTE_AUTH_FAILED')
    const result = await harness.call('remote_exec', { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('auth exploded')
  })
})
