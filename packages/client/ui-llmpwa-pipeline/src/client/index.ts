/**
 * Browser half: the LLMPWA workbench.
 *
 * Two registrations share one store and one inject face: a `sidebar.footer.action`
 * that opens the panel, and a `shell.overlay` body that draws it. Both slots are
 * root-scoped lists, so the store is a single instance (one SSS surface) and the
 * inject factory receives only the baked actions. Nothing here writes files or
 * triggers LLMPWA execution — the workbench reads the exported snapshot only.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only declaration merge: the workbench declares `conversation.embedded` as
// a child slot whose SlotMap entry ui-conversation owns, so the register call
// below types against that shared contract.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { FooterButton } from './FooterButton.tsx'
import { Workbench } from './Workbench.tsx'
import { workbenchFace } from './face.ts'
import { createWorkbenchStore } from './store.ts'
import { en, zh } from './locales.ts'

/** This package's copy namespace. */
const NS = 'llmpwa'

/** List-entry id shared by both registrations of one workbench surface. */
const ENTRY_ID = 'llmpwa-workbench'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workbench titles, statuses, and error lines. */
    llmpwa: import('./locales.ts').LlmpwaKey
  }
}

export type { WorkbenchInjected } from './face.ts'
export type { WorkbenchOverlayProps } from './Workbench.tsx'
export type { WorkbenchActionProps } from './FooterButton.tsx'
export type { WorkbenchStore } from './store.ts'
export type { LlmpwaKey } from './locales.ts'

/** Required browser services: slots, locale, sessions, workspaces, and the Remote carrier's `workspaceFiles` namespace. */
export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: register the dictionaries and both workbench surfaces.
 * @param ctx - client root context carrying the slots registry, copy, sessions, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-llmpwa-pipeline: dictionaries')

  const store = createWorkbenchStore()
  const face = workbenchFace(ctx.remote, ctx.sessions, ctx.workspaces, ctx.uiWorkspace)

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: ENTRY_ID,
    locale: NS,
    store,
    inject: face,
  }, FooterButton)), 'ui-llmpwa-pipeline: workbench foot action')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: ENTRY_ID,
    locale: NS,
    store,
    children: {
      // The drawer mounts one live session conversation; the scope adapter
      // supplies the current (agent) session so chat binds to the agent.
      'conversation.embedded': { kind: 'single', scope: 'session' },
    },
    inject: face,
  }, Workbench)), 'ui-llmpwa-pipeline: workbench overlay')
}
