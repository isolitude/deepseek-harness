/**
 * Reading the LLMPWA pipeline snapshot and the analyses list over the
 * `workspaceFiles` Remote namespace, host-free.
 *
 * The workbench never touches the Host directly: it binds these functions to
 * the Client Remote once in `apply` and threads the result through the store /
 * inject face. Reads are workspace-relative and resolve against the current
 * Session's workspace root on the Host.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkspaceDirectoryEntry,
  WorkspaceFileRange,
  WorkspaceFileText,
  WorkspaceFileWrite,
  WorkspaceFileWriteRequest,
} from '@deepseek-ai/dsh-api-workspace-files/types'
import type { PipelineSnapshot } from './presenters.ts'

/** The LLMPWA analyses root, workspace-relative. */
export const ANALYSES_ROOT = 'LLMPWA/analyses'
/** The exported snapshot filename under each analysis's `gen/` directory. */
export const PIPELINE_STATE_FILE = 'gen/pipeline_state.json'
/** The per-analysis settings directory, inside each analysis. */
export const AGENT_SETTINGS_DIR = '.dsh'
/** The per-analysis settings filename holding the agent session id. */
export const AGENT_SETTINGS_FILE = 'agent.json'

/** One analysis: its directory name and, when known, a config file. */
export interface Analysis {
  readonly dir: string
}

/** A load failure's kind, so the workbench can render a targeted message. */
export type SnapshotErrorKind = 'missing' | 'parse' | 'unexpected'

/** A completed snapshot load. */
export interface SnapshotLoad {
  readonly ok: boolean
  readonly snapshot?: PipelineSnapshot
  readonly error?: SnapshotError
}

/** A load failure description. */
export interface SnapshotError {
  readonly kind: SnapshotErrorKind
  readonly message: string
}

/** One discoverable reference file: its workspace path and display name. */
export interface ReferenceFile {
  /** Workspace-relative path, passed to the `read` endpoint. */
  readonly path: string
  /** Short name shown in the reference list (e.g. `resonances_config.toml`, `document/…`). */
  readonly name: string
}

/** A completed reference-file text load. */
export type ReferenceLoad =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: SnapshotError }

/** Matches an analysis-root resonance config `resonances_config*.toml`. */
const RESONANCE_CONFIG_PATTERN = /^resonances_config.*\.toml$/
/** The analysis-local directory holding supporting reference documents. */
const DOCUMENT_DIR = 'document'

/**
 * The slice of the Client Remote this module needs: the `workspaceFiles`
 * namespace's `list` (directory listing), `read` (paged text), and `write`
 * (whole-file, confined by the Host sandbox).
 */
export interface WorkspaceFilesLoadRemote {
  readonly workspaceFiles: {
    list(
      sessionId: SessionId,
      path: string,
      signal?: AbortSignal,
    ): Promise<RemoteResult<{ readonly entries: readonly WorkspaceDirectoryEntry[] }>>
    read(
      sessionId: SessionId,
      path: string,
      range: WorkspaceFileRange,
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileText>>
    write(
      sessionId: SessionId,
      request: WorkspaceFileWriteRequest,
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileWrite>>
  }
}

/** An alias for the remote the load functions bind to. */
export type WorkspaceFilesReadRemote = WorkspaceFilesLoadRemote

/**
 * List the analyses directories under `LLMPWA/analyses`.
 * @param remote - the Client Remote.
 * @param sessionId - the session whose workspace resolves the path.
 * @param signal - cancels the call.
 * @returns the directory names, oldest-first; an empty result on failure.
 */
export async function listAnalyses(
  remote: WorkspaceFilesLoadRemote,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<readonly Analysis[]> {
  const result = await remote.workspaceFiles.list(sessionId, ANALYSES_ROOT, signal)
  if (!result.ok) return []
  const entries = result.value.entries
  return entries
    .filter(entry => entry.type === 'directory')
    .map(entry => ({ dir: entry.name }))
}

/** Safe page bound: the Host caps a read at its own `maxLines`, so requesting a
 * larger `limit` is rejected loudly. The cap is never requested — the Host's
 * default is used and pagination follows the returned line count. */
const MAX_PAGES = 200

/**
 * Read a workspace file in full, walking the Host's capped pages until the
 * file's last line. Every page is requested without a `limit`, so the Host's
 * own `maxLines` applies; a file larger than one page is reconstructed by
 * concatenating page texts at their newline-joined boundaries.
 * @param remote - the Client Remote.
 * @param sessionId - the session whose workspace resolves the path.
 * @param path - the workspace-relative file path.
 * @param signal - cancels the call.
 * @returns the full text, or a structured read failure.
 */
async function readPaged(
  remote: WorkspaceFilesLoadRemote,
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
): Promise<ReferenceLoad> {
  let text = ''
  let offset = 1
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const result = await remote.workspaceFiles.read(sessionId, path, { offset }, signal)
    if (!result.ok) {
      const code = result.error.code
      const isMissing = code === 'workspace-file/not-found' || code === 'workspace-file/outside-workspace'
      return {
        ok: false,
        error: {
          kind: isMissing ? 'missing' : 'unexpected',
          message: result.error.message,
        },
      }
    }
    const page = result.value
    if (i > 0) text += '\n'
    text += page.text
    if (page.eof || page.lines === 0) break
    offset += page.lines
  }
  return { ok: true, text }
}

/**
 * Load and parse one analysis's `gen/pipeline_state.json`, walking the Host's
 * capped pages until the file's last line.
 * @param remote - the Client Remote.
 * @param sessionId - the session whose workspace resolves the path.
 * @param analysis - the selected analysis directory.
 * @param signal - cancels the call.
 * @returns a structured load result.
 */
export async function loadSnapshot(
  remote: WorkspaceFilesLoadRemote,
  sessionId: SessionId,
  analysis: string,
  signal: AbortSignal,
): Promise<SnapshotLoad> {
  const path = `${ANALYSES_ROOT}/${analysis}/${PIPELINE_STATE_FILE}`
  const paged = await readPaged(remote, sessionId, path, signal)
  if (!paged.ok) return { ok: false, error: paged.error }
  try {
    const snapshot = JSON.parse(paged.text) as PipelineSnapshot
    return { ok: true, snapshot }
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        // v8 ignore next -- JSON.parse throws a native SyntaxError (an Error), so the string arm is unreachable.
        message: cause instanceof Error ? cause.message : String(cause),
      },
    }
  }
}

/**
 * Discover an analysis's reference files: the root `resonances_config*.toml`
 * configs and any file under its `document/` directory. A directory that does
 * not exist (or cannot be listed) contributes nothing, so the result is stable
 * across analyses that omit either part.
 * @param remote - the Client Remote.
 * @param sessionId - the session whose workspace resolves the paths.
 * @param analysis - the selected analysis directory.
 * @param signal - cancels the call.
 * @returns the reference files, ordered by display name.
 */
export async function listReferenceFiles(
  remote: WorkspaceFilesLoadRemote,
  sessionId: SessionId,
  analysis: string,
  signal: AbortSignal,
): Promise<readonly ReferenceFile[]> {
  const dir = `${ANALYSES_ROOT}/${analysis}`
  const files: ReferenceFile[] = []
  const root = await remote.workspaceFiles.list(sessionId, dir, signal)
  if (root.ok) {
    for (const entry of root.value.entries) {
      if (entry.type === 'file' && RESONANCE_CONFIG_PATTERN.test(entry.name)) {
        files.push({ path: `${dir}/${entry.name}`, name: entry.name })
      }
    }
  }
  const doc = await remote.workspaceFiles.list(sessionId, `${dir}/${DOCUMENT_DIR}`, signal)
  if (doc.ok) {
    for (const entry of doc.value.entries) {
      if (entry.type === 'file') {
        files.push({ path: `${dir}/${DOCUMENT_DIR}/${entry.name}`, name: `${DOCUMENT_DIR}/${entry.name}` })
      }
    }
  }
  /* v8 ignore next -- `document/` names disambiguate cross-directory rows, so the sort never compares two equal names. */
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Read one reference file's full text, walking the Host's capped pages.
 * @param remote - the Client Remote.
 * @param sessionId - the session whose workspace resolves the path.
 * @param path - the reference file's workspace-relative path.
 * @param signal - cancels the call.
 * @returns the full text, or a structured read failure.
 */
export async function loadReferenceText(
  remote: WorkspaceFilesLoadRemote,
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
): Promise<ReferenceLoad> {
  return readPaged(remote, sessionId, path, signal)
}

/**
 * Build the absolute working directory for an analysis, for the agent session.
 * @param workspacePath - the workspace root's canonical host path.
 * @param analysis - the selected analysis directory.
 * @returns the agency directory the agent session should own.
 */
export function analysisWorkspaceCwd(workspacePath: string, analysis: string): string {
  return `${workspacePath}/${ANALYSES_ROOT}/${analysis}`
}

/**
 * The per-analysis settings path, workspace-relative, pointing at the agent
 * session id file inside the analysis's `.dsh` settings directory.
 * @param analysis - the selected analysis directory.
 * @returns the workspace-relative settings path.
 */
export function analysisSettingsPath(analysis: string): string {
  return `${ANALYSES_ROOT}/${analysis}/${AGENT_SETTINGS_DIR}/${AGENT_SETTINGS_FILE}`
}

/**
 * Read one analysis's persisted agent session id from its `.dsh/agent.json`.
 * An absent file (no settings yet) or an unreadable one yields `undefined`;
 * only a well-formed `{ agentSessionId }` object yields the id.
 * @param remote - the Client Remote.
 * @param sessionId - the session whose workspace resolves the path.
 * @param analysis - the selected analysis directory.
 * @param signal - cancels the call.
 * @returns the recorded agent session id, or `undefined` when none is stored.
 */
export async function readAnalysisAgentSession(
  remote: WorkspaceFilesLoadRemote,
  sessionId: SessionId,
  analysis: string,
  signal: AbortSignal,
): Promise<SessionId | undefined> {
  const load = await readPaged(remote, sessionId, analysisSettingsPath(analysis), signal)
  if (!load.ok) return undefined
  try {
    const value: unknown = JSON.parse(load.text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const id = (value as { agentSessionId?: unknown }).agentSessionId
    return typeof id === 'string' ? (id as SessionId) : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist one analysis's agent session id to its `.dsh/agent.json`. The write
 * is Host-side and confined by the workspace sandbox, so a read-only session
 * reports a write failure the caller records.
 * @param remote - the Client Remote.
 * @param sessionId - the session whose workspace resolves the path.
 * @param analysis - the selected analysis directory.
 * @param id - the agent session id to record.
 * @param signal - cancels the call.
 * @returns whether the write succeeded.
 */
export async function writeAnalysisAgentSession(
  remote: WorkspaceFilesLoadRemote,
  sessionId: SessionId,
  analysis: string,
  id: SessionId,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await remote.workspaceFiles.write(sessionId, {
    path: analysisSettingsPath(analysis),
    content: JSON.stringify({ agentSessionId: id }),
  }, signal)
  return result.ok
}

/**
 * Build a human hint for a missing snapshot: the command that produces it.
 * @param analysis - the selected analysis directory.
 * @returns the export command the user can run.
 */
export function missingSnapshotHint(analysis: string): string {
  return `python LLMPWA/agent/pipeline_state.py -w LLMPWA/analyses/${analysis} -c llm_config_fit.toml -o gen/pipeline_state.json`
}
