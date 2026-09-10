// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import type { EmbeddedConversationProps } from '../src/client/contract/slots.ts'
import { EmbeddedConversation } from '../src/client/embedded/EmbeddedConversation.tsx'

afterEach(() => cleanup())

/** Build a full props value with the plain stub hooks the component consumes. */
function makeProps(options: {
  order?: readonly string[]
  nodes?: Record<string, unknown>
  running?: boolean
  draft?: string
  cwd?: string
} = {}): EmbeddedConversationProps {
  const order = options.order ?? []
  const nodes = options.nodes ?? {}
  const running = options.running ?? false
  const draft = options.draft ?? ''
  const cwd = options.cwd
  const snapshot = { order } as unknown as ChatSnapshot
  const useChat = ((sel: (snapshot: ChatSnapshot) => unknown) => sel(snapshot)) as EmbeddedConversationProps['useChat']
  const useChatNode = ((key: string) => nodes[key]) as EmbeddedConversationProps['useChatNode']
  const useSession = ((sel: (snapshot: { running?: boolean }) => unknown) => sel({ running })) as EmbeddedConversationProps['useSession']
  const useInput = ((sel: (snapshot: { draft: string }) => unknown) => sel({ draft })) as EmbeddedConversationProps['useInput']
  const useSessions = ((sel: (snapshot: { byId: Record<string, { cwd?: string }> }) => unknown) =>
    sel({ byId: cwd === undefined ? {} : { sx: { cwd } } })) as EmbeddedConversationProps['useSessions']
  return {
    sessionId: 'sx' as SessionId,
    useChat,
    useChatNode,
    useSession,
    useInput,
    useSessions,
    inputActions: { setDraft: vi.fn(), submit: vi.fn() },
    t: (key: string) => key,
  } as unknown as EmbeddedConversationProps
}

describe('EmbeddedConversation', () => {
  it('renders an empty hint and a disabled composer before any message', () => {
    render(<EmbeddedConversation {...makeProps()} />)
    expect(screen.getByText('embedded.empty')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'embedded.send' })).toHaveProperty('disabled', true)
  })

  it('renders user and assistant text lines in node order', () => {
    const { container } = render(<EmbeddedConversation {...makeProps({
      order: ['k1', 'k2', 'k3'],
      nodes: {
        k1: { kind: 'user', data: { content: [{ type: 'text', text: 'hello' }] } },
        k2: { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'world' }, { kind: 'reasoning', text: 'thinking' }] } },
        k3: { kind: 'tool-call', data: { root: {} } },
      },
    })} />)
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByText('world')).toBeTruthy()
    // The bounded view shows only the assistant's body text, not its reasoning.
    expect(screen.queryByText('thinking')).toBeNull()
    // Tool-call rows are out of the bounded text view.
    expect(container.textContent).not.toContain('tool-call')
  })

  it('omits rows with no text, unknown kinds, and missing nodes', () => {
    const { container } = render(<EmbeddedConversation {...makeProps({
      order: ['k1', 'k2', 'k3'],
      nodes: {
        k1: { kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call' }] } },
        k2: { kind: 'unknown', data: {} },
        // k3 has no node in the map: the keyed hook resolves undefined.
      },
    })} />)
    expect(container.textContent).not.toContain('tool-call')
    expect(container.textContent).not.toContain('k3')
  })

  it('skips non-text content blocks in a user message', () => {
    const { container } = render(<EmbeddedConversation {...makeProps({
      order: ['k1'],
      nodes: {
        k1: {
          kind: 'user',
          data: { content: [{ type: 'image' }, { type: 'text', text: 42 }, { type: 'text', text: 'kept' }] },
        },
      },
    })} />)
    expect(screen.getByText('kept')).toBeTruthy()
    expect(container.textContent).not.toContain('image')
  })

  it('scrolls the transcript to the newest text when it can', () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(<EmbeddedConversation {...makeProps({ order: ['k1'] })} />)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('shows the working directory when the session has one', () => {
    render(<EmbeddedConversation {...makeProps({ cwd: '/ws/LLMPWA/analyses/kk_dis' })} />)
    expect(screen.getByText('/ws/LLMPWA/analyses/kk_dis')).toBeTruthy()
  })

  it('sends the draft through the input machine', () => {
    const props = makeProps({ draft: 'hi' })
    const submit = props.inputActions.submit as ReturnType<typeof vi.fn>
    render(<EmbeddedConversation {...props} />)
    const submitButton = screen.getByRole('button', { name: 'embedded.send' })
    expect(submitButton).toHaveProperty('disabled', false)
    fireEvent.click(submitButton)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('does not send when the draft is blank', () => {
    const props = makeProps({ draft: '   ' })
    const submit = props.inputActions.submit as ReturnType<typeof vi.fn>
    render(<EmbeddedConversation {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'embedded.send' }))
    expect(submit).not.toHaveBeenCalled()
  })

  it('types into the composer and updates the shared draft', () => {
    const props = makeProps({ draft: '' })
    const setDraft = props.inputActions.setDraft as ReturnType<typeof vi.fn>
    render(<EmbeddedConversation {...props} />)
    const textarea = screen.getByPlaceholderText('embedded.placeholder') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'typed' } })
    expect(setDraft).toHaveBeenCalledWith('typed')
  })

  it('submits on Enter but not on Shift+Enter or other keys', () => {
    const props = makeProps({ draft: 'hi' })
    const submit = props.inputActions.submit as ReturnType<typeof vi.fn>
    render(<EmbeddedConversation {...props} />)
    const textarea = screen.getByPlaceholderText('embedded.placeholder') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(submit).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(submit).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(textarea, { key: 'a', shiftKey: false })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('does not submit from the key handler when the draft is blank', () => {
    const props = makeProps({ draft: '' })
    const submit = props.inputActions.submit as ReturnType<typeof vi.fn>
    render(<EmbeddedConversation {...props} />)
    const textarea = screen.getByPlaceholderText('embedded.placeholder') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(submit).not.toHaveBeenCalled()
  })

  it('disables send while the session is running', () => {
    render(<EmbeddedConversation {...makeProps({ draft: 'hi', running: true })} />)
    expect(screen.getByText('embedded.running')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'embedded.send' })).toHaveProperty('disabled', true)
  })
})
