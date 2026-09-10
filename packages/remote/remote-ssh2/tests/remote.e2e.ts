/**
 * Real-link e2e smoke for the SSH2 provider over a loopback sshd. The whole
 * round trip runs in a child Node process against the BUILT provider
 * (`lib/index.js`), so ssh2's native accelerator executes under the same
 * conditions as production instead of inside the vitest worker, then the test
 * asserts the child's protocol output. Skipped unless `DSH_SSH_E2E=1` and the
 * sshd/keygen binaries are on PATH.
 * @module @deepseek-ai/dsh-remote-ssh2/tests
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const ENABLED = process.env.DSH_SSH_E2E === '1'

let dir: string | undefined
let sshdPath: string | undefined
let remoteRoot: string | undefined

async function sshdAvailable(): Promise<boolean> {
  try {
    sshdPath = execFileSync('which', ['sshd'], { encoding: 'utf8' }).trim()
    execFileSync('which', ['ssh-keygen'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  if (ENABLED && !await sshdAvailable()) {
    throw new Error('DSH_SSH_E2E=1 requires the sshd and ssh-keygen binaries on PATH')
  }
})

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** Fingerprint of one OpenSSH public key. */
function fingerprintOfPublicKey(pub: string): string {
  const body = pub.trim().split(/\s+/)[1]!
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest('base64')
}

describe.skipIf(!ENABLED)('ssh2 provider real-link smoke (built provider)', () => {
  it('runs exec, read, write, edit, push, and pull against a live sshd', { timeout: 60_000 }, async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-e2e-'))
    const sshdDir = join(dir, 'sshd')
    await mkdir(sshdDir, { recursive: true })
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', join(sshdDir, 'host_key'), '-N', ''])
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', join(sshdDir, 'client_key'), '-N', ''])
    const authorized = join(sshdDir, 'authorized_keys')
    await writeFile(
      authorized,
      (await readFile(join(sshdDir, 'client_key.pub'), 'utf8')) + '\n',
      { mode: 0o600 },
    )
    const port = 22_222 + Math.floor(Math.random() * 1000)
    const sshd = spawn(sshdPath!, [
      '-D', '-e',
      '-h', join(sshdDir, 'host_key'),
      '-p', String(port),
      '-o', `AuthorizedKeysFile=${authorized}`,
      '-o', 'StrictModes=no',
      '-o', 'UsePAM=no',
      '-o', 'PasswordAuthentication=no',
    ], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { reject(new Error('e2e sshd did not listen in time')) }, 10_000)
        const probe = setInterval(() => {
          const socket = createConnection({ host: '127.0.0.1', port })
          socket.once('connect', () => {
            socket.destroy()
            clearInterval(probe)
            clearTimeout(deadline)
            resolve()
          })
          socket.once('error', () => socket.destroy())
        }, 200)
      })

      const hostPublicKey = await readFile(join(sshdDir, 'host_key.pub'), 'utf8')
      // The remote world must be writable by the sshd process; a temp dir
      // under the repository keeps CI sandboxes with read-only /tmp and home
      // green while still exercising the full round trip.
      remoteRoot = await mkdtemp(join(new URL('..', import.meta.url).pathname, 'tests', '.e2e-remote-'))
      const payload = {
        connection: {
          id: 'e2e',
          host: '127.0.0.1',
          port,
          user: process.env.USER ?? 'root',
          auth: { kind: 'key', keyPath: join(sshdDir, 'client_key') },
          remoteRoot,
          connectTimeoutMs: 5_000,
          maxTransferBytes: 1024 * 1024,
          hostKeyFingerprint: fingerprintOfPublicKey(hostPublicKey),
        },
        localScript: join(dir, 'script.py'),
        pulled: join(dir, 'out.txt'),
      }
      await writeFile(payload.localScript, 'print("from-script")\n')

      // Drive the BUILT provider from a child process so the ssh2 native
      // accelerator runs exactly as in production.
      const script = [
        "import { mkdir } from 'node:fs/promises'",
        "import { Context } from '@deepseek-ai/cordis'",
        "import Ssh2RemoteExecutor from '@deepseek-ai/dsh-remote-ssh2'",
        'const input = JSON.parse(process.argv[2])',
        'const { connection, localScript, pulled } = input',
        'await mkdir(connection.remoteRoot, { recursive: true })',
        'const executor = new Ssh2RemoteExecutor(new Context(), { connectTimeoutMs: 5_000 })',
        'try {',
        "  const run = await executor.run(connection, { command: 'echo hello-remote', cwd: connection.remoteRoot, timeoutMs: 10_000 })",
        "  if (run.exitCode !== 0 || !run.stdout.includes('hello-remote')) throw new Error('exec failed: ' + JSON.stringify(run))",
        "  const written = await executor.writeText(connection, { path: 'data.txt', content: 'line1\\nline2\\n' })",
        "  if (!written.created) throw new Error('write not created')",
        "  const read = await executor.readText(connection, { path: 'data.txt', offset: 1, limit: 10 })",
        "  if (read.totalLines !== 2 || read.lines[0]?.text !== 'line1') throw new Error('read mismatch: ' + JSON.stringify(read))",
        "  const edited = await executor.editText(connection, { path: 'data.txt', oldString: 'line1', newString: 'edited' })",
        "  if (edited.occurrences !== 1) throw new Error('edit mismatch')",
        "  const pushed = await executor.push(connection, { localPath: localScript, remotePath: 'script.py' })",
        "  if (pushed.bytes < 1) throw new Error('push failed')",
        "  const ran = await executor.run(connection, { command: 'python3 script.py > out.txt', cwd: connection.remoteRoot, timeoutMs: 10_000 })",
        "  if (ran.exitCode !== 0) throw new Error('script run failed: ' + JSON.stringify(ran))",
        "  const pulledData = await executor.pull(connection, { remotePath: 'out.txt', localPath: pulled })",
        "  if (pulledData.bytes < 1) throw new Error('pull failed')",
        '} finally {',
        '  executor.dispose()',
        '}',
        "process.stdout.write('E2E-OK\\n')",
      ].join('\n')
      const scriptFile = join(new URL('..', import.meta.url).pathname, 'tests', '.run-e2e.mjs')
      await writeFile(scriptFile, script, 'utf8')
      const child = await new Promise<{ stdout: string }>((resolve, reject) => {
        // Run from the repository root so the workspace-linked built packages
        // resolve exactly as in production (cwd-sensitive package links).
        const proc = spawn(process.execPath, [scriptFile, JSON.stringify(payload)], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: new URL('.', import.meta.url).pathname,
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
        proc.on('close', (code) => {
          if (code === 0) resolve({ stdout })
          else reject(new Error(`e2e child exited ${code}: ${stderr}`))
        })
      })
      expect(child.stdout).toContain('E2E-OK')
    } finally {
      sshd.kill('SIGKILL')
      const scratch = join(new URL('..', import.meta.url).pathname, 'tests', '.run-e2e.mjs')
      await rm(scratch, { force: true })
      if (remoteRoot !== undefined) await rm(remoteRoot, { recursive: true, force: true })
    }
  })
})
