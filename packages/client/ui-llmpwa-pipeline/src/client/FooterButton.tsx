/**
 * The left-Sidebar foot action that opens the LLMPWA workbench.
 *
 * Pure entry to the store: it reads whether the panel is open and flips it.
 * It never triggers a Remote read — the full-frame body lists analyses the
 * moment it opens, so this button stays free of load bookkeeping.
 */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchInjected } from './face.ts'
import type { WorkbenchStore } from './store.ts'
import css from './FooterButton.module.css'

/** Full props composed by the sidebar footer-action seat. */
export type WorkbenchActionProps =
  PropsRuntime<'sidebar.footer.action'> & PropsStore<WorkbenchStore> & InjectFace<WorkbenchInjected> & PropsLocale<'llmpwa'>

/**
 * Render the foot action.
 * @param props - the composed footer-action props.
 * @returns the toggle button.
 */
export function FooterButton(props: WorkbenchActionProps): ReactNode {
  const state = props.useStore(s => s)
  const open = state.open
  return (
    <button
      type="button"
      className={css.action}
      data-wide={props.wide}
      aria-pressed={open}
      onClick={() => { if (open) props.actions.closed(); else props.actions.opened() }}
    >
      <span className={css.label}>{props.t('action.label')}</span>
    </button>
  )
}
