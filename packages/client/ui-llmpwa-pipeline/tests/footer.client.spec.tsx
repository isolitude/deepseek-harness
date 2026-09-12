/**
 * The sidebar foot action: renders its label and flips the shared store's
 * open/closed state. Props are fed directly (a real store instance; plain
 * selectors over it), per the component-test rule.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { FooterButton, type WorkbenchActionProps } from '../src/client/FooterButton.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'

afterEach(() => { cleanup() })

function makeProps(): { props: WorkbenchActionProps; instance: ReturnType<ReturnType<typeof createWorkbenchStore>['create']> } {
  const instance = createWorkbenchStore().create()
  const props = {
    wide: true,
    useStore: (sel: (s: ReturnType<typeof instance.getSnapshot>) => unknown) => sel(instance.getSnapshot()),
    actions: instance.actions,
    useSessions: (sel: (s: { current: string | undefined }) => unknown) => sel({ current: 's1' }),
    t: (key: string) => key,
    listAnalyses: () => {},
    loadSnapshot: () => {},
  } as unknown as WorkbenchActionProps
  return { props, instance }
}

describe('FooterButton', () => {
  it('shows the action label and opens the store on click', () => {
    const { props, instance } = makeProps()
    render(<FooterButton {...props} />)
    const button = screen.getByRole('button', { name: 'action.label' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(instance.getSnapshot().open).toBe(true)
  })

  it('closes the store when already open', () => {
    const { props, instance } = makeProps()
    instance.actions.opened()
    render(<FooterButton {...props} />)
    expect(screen.getByRole('button', { name: 'action.label' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'action.label' }))
    expect(instance.getSnapshot().open).toBe(false)
  })
})
