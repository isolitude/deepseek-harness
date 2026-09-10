/**
 * Shared shape between the `remote_*` tool executors and the config loader:
 * each execution resolves the caller's per-analysis connection lazily, so
 * rotated credentials and session-specific config apply per call.
 * @module @deepseek-ai/dsh-tool-remote/connection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { RemoteConnection } from '@deepseek-ai/dsh-remote'
import { RemoteError } from '@deepseek-ai/dsh-remote'

/** Resolve (or fail) the remote connection for one tool call. */
export type ConnectionLoader = (
  ctx: Context,
  session: Session,
) => Promise<RemoteConnection | undefined>

/** Load the connection for one execution, or raise the loud missing-config error. */
export async function requireConnection(
  ctx: Context,
  session: Session,
  loader: ConnectionLoader,
): Promise<RemoteConnection> {
  const connection = await loader(ctx, session)
  if (connection === undefined) {
    throw new RemoteError(
      'no remote configuration found: create a `remote:` block in the .dsh/config.yml of this analysis (see LLMPWA/documentation/ssh-remote-tools-plan.md)',
      'REMOTE_CONNECT_FAILED',
    )
  }
  return connection
}
