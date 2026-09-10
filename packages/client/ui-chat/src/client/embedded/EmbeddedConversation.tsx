/**
 * Bounded embedded conversation a host mounts inside its own surface (the
 * LLMPWA agent drawer): a plain text transcript of the current session's user
 * and assistant messages plus a working composer. It is deliberately
 * non-authoritative — it renders text blocks only, not tool-call cards,
 * markdown, or images (ChatView owns those node slots) — yet it drives the
 * same per-session input machine and reflects live streaming assistant text,
 * so sending here and reading the reply works exactly as in the full view.
 *
 * The slot is `session` scoped, so the component binds to whichever session is
 * current. Callers mount it only after they have opened (and thus selected)
 * their target session.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import type { AssistantChatData } from '../contract/chat-nodes.ts'
import type { EmbeddedConversationProps } from '../contract/slots.ts'
import css from './EmbeddedConversation.module.css'

/** Message kinds rendered by the bounded transcript. */
type TranscriptKind = 'user' | 'assistant'

/** Resolve the plain-text lines one Chat node contributes to the transcript. */
function nodeTextLines(node: ChatConversationViewNode | undefined): readonly string[] {
  if (node === undefined) return []
  switch (node.kind) {
    case 'user':
    case 'steering':
      return textBlocks((node.data as { readonly content: readonly unknown[] }).content)
    case 'assistant-step':
      return assistantText((node.data as AssistantChatData).blocks)
    default:
      // Context, tool, compaction, and other rows are out of the bounded view.
      return []
  }
}

/** Extract the text string of each text content block, in order. */
function textBlocks(content: readonly unknown[]): string[] {
  const texts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
  }
  return texts
}

/** Extract the text string of each body assistant block, in order. Reasoning
 * blocks are deliberately omitted: the bounded transcript shows the assistant's
 * answer only, not its thinking. */
function assistantText(blocks: readonly AssistantBlock[]): string[] {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.kind === 'text') texts.push(block.text)
  }
  return texts
}

/** Resolve the transcript role of one Chat node kind, or null to skip it. */
function transcriptKind(node: ChatConversationViewNode | undefined): TranscriptKind | null {
  if (node === undefined) return null
  if (node.kind === 'user' || node.kind === 'steering') return 'user'
  if (node.kind === 'assistant-step') return 'assistant'
  return null
}

/** One transcript row: resolves its living node through the keyed hook. */
function EmbeddedRow({
  nodeKey, useChatNode, t,
}: {
  nodeKey: string
  useChatNode: EmbeddedConversationProps['useChatNode']
  t: EmbeddedConversationProps['t']
}): ReactNode {
  const node = useChatNode(nodeKey)
  const kind = transcriptKind(node)
  const lines = nodeTextLines(node)
  if (kind === null || lines.length === 0) return null
  return (
    <div className={css.row} data-role={kind} data-chat-flow-key={nodeKey}>
      <div className={css.role}>{t(kind === 'user' ? 'embedded.role.user' : 'embedded.role.assistant')}</div>
      <div className={css.text}>
        {lines.map(line => (
          <p key={line} className={css.line}>{line}</p>
        ))}
      </div>
    </div>
  )
}

/** The bounded embedded conversation surface. */
export function EmbeddedConversation({
  sessionId, useSession, useChat, useChatNode, useSessions, useInput, inputActions, t,
}: EmbeddedConversationProps): ReactNode {
  const order = useChat(s => s.order)
  const running = useSession(s => s.running)
  const draft = useInput(s => s.draft)
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const endRef = useRef<HTMLDivElement | null>(null)

  // Keep the reading line at the newest text as messages stream in.
  useEffect(() => {
    const end = endRef.current
    /* v8 ignore next -- jsdom and some non-browser hosts leave Element.prototype.scrollIntoView undefined. */
    if (end === null || typeof end.scrollIntoView !== 'function') return
    end.scrollIntoView({ block: 'end' })
  }, [order.length, running])

  const canSend = draft.trim() !== '' && !running
  const submit = (): void => {
    if (canSend) inputActions.submit()
  }

  return (
    <div className={css.root} data-testid="embedded-conversation">
      <div className={css.transcript} role="log" aria-live="polite">
        {order.length === 0
          ? <div className={css.empty}>{t('embedded.empty')}</div>
          : order.map(nodeKey => (
            <EmbeddedRow key={nodeKey} nodeKey={nodeKey} useChatNode={useChatNode} t={t} />
          ))}
        <div ref={endRef} />
      </div>
      {cwd !== undefined && <div className={css.cwd}>{cwd}</div>}
      {running && <div className={css.running} role="status">{t('embedded.running')}</div>}
      <form
        className={css.composer}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          className={css.textarea}
          value={draft}
          rows={2}
          placeholder={t('embedded.placeholder')}
          onChange={(event) => { inputActions.setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button type="submit" className={css.send} disabled={!canSend}>
          {t('embedded.send')}
        </button>
      </form>
    </div>
  )
}
