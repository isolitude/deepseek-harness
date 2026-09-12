/**
 * Bounded embedded conversation a host mounts inside its own surface (the
 * LLMPWA agent drawer): a transcript of the current session's user and
 * assistant messages plus a working composer. It is deliberately
 * non-authoritative — it renders assistant text through the shared GFM
 * markdown renderer but not tool-call cards or images (ChatView owns those
 * node slots) — yet it drives the same per-session input machine and reflects
 * live streaming assistant text, so sending here and reading the reply works
 * exactly as in the full view.
 *
 * The slot is `session` scoped, so the component binds to whichever session is
 * current. Callers mount it only after they have opened (and thus selected)
 * their target session.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import type { AssistantChatData } from '../contract/chat-nodes.ts'
import type { EmbeddedConversationProps } from '../contract/slots.ts'
import css from './EmbeddedConversation.module.css'

/** Message kinds rendered by the bounded transcript. */
type TranscriptKind = 'user' | 'assistant'

/** Extract the text string of each text content block, in order. */
function textBlocks(content: readonly unknown[]): string[] {
  const texts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
  }
  return texts
}

/** Build localized Markdown chrome labels from the locale seat. */
function markdownLabels(t: EmbeddedConversationProps['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }
}

/** Resolve the transcript role of one Chat node kind, or null to skip it. */
function transcriptKind(node: ChatConversationViewNode | undefined): TranscriptKind | null {
  if (node === undefined) return null
  if (node.kind === 'user' || node.kind === 'steering') return 'user'
  if (node.kind === 'assistant-step') return 'assistant'
  return null
}

/** Extract the text string of each body assistant block, in order. Reasoning
 * blocks are deliberately omitted: the bounded transcript shows the assistant's
 * answer only, not its thinking. */
function assistantBlocks(blocks: readonly AssistantBlock[]): string[] {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.kind === 'text') texts.push(block.text)
  }
  return texts
}

/** Whether the assistant message is still streaming (drives incremental parse). */
function assistantStreaming(node: ChatConversationViewNode): boolean {
  const data = node.data as AssistantChatData
  return data.status === 'running'
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
  if (node === undefined || kind === null) return null
  // Stable per locale revision: a fresh object every render would rebuild
  // MarkdownText's component table each chunk while the reply streams.
  const labels = useMemo(() => markdownLabels(t), [t])
  if (kind === 'user') {
    const lines = textBlocks((node.data as { readonly content: readonly unknown[] }).content)
    if (lines.length === 0) return null
    return (
      <div className={css.row} data-role="user" data-chat-flow-key={nodeKey}>
        <div className={css.role}>{t('embedded.role.user')}</div>
        <div className={css.text}>
          {lines.map(line => (
            <p key={line} className={css.line}>{line}</p>
          ))}
        </div>
      </div>
    )
  }
  const blocks = assistantBlocks((node.data as AssistantChatData).blocks)
  if (blocks.length === 0) return null
  const streaming = assistantStreaming(node)
  return (
    <div className={css.row} data-role="assistant" data-chat-flow-key={nodeKey}>
      <div className={css.role}>{t('embedded.role.assistant')}</div>
      <div className={css.markdown}>
        {blocks.map((text, index) => (
          <MarkdownText key={index} text={text} streaming={streaming} labels={labels} />
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
