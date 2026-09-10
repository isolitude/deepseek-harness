/**
 * Render one reference file's text as a real document rather than a pre block.
 * Markdown files render through the shared GFM renderer (with shiki-highlighted
 * code fences); other file types render as a syntax-highlighted code block via
 * the shared shiki highlighter. Unknown or absent languages fall back to a
 * plain pre so nothing renders unstyled or errors.
 */
import { memo, useMemo } from 'react'
import { CodeBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Workbench.module.css'

/** A `ReferenceDocument` render call's locale seat. */
export interface ReferenceDocumentProps {
  /** The reference file's workspace-relative path (drives language detection). */
  path: string
  /** The reference file's full text. */
  text: string
  /** Locale seat: resolves the markdown/code chrome copy. */
  t: (key: 'panel.copy' | 'panel.copied' | 'panel.footnotes') => string
}

/** File extensions rendered as full markdown (not a code block). */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

/** Extension → shiki grammar id, mirroring ui-primitives' alias table. */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  toml: 'toml',
  ini: 'ini',
  py: 'python',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  sh: 'shellscript',
  bash: 'shellscript',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  xml: 'xml',
}

/** The trailing extension of a path, lowercased, or `undefined` for no dot. */
function extensionOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  /* v8 ignore next -- a reference path always carries a dot (listReferenceFiles matches extensions), so the arm is defensive. */
  if (dot < 0) return undefined
  return path.slice(dot + 1).toLowerCase()
}

/** Whether a reference path is a markdown file (rendered as GFM, not code). */
export function isMarkdownReference(path: string): boolean {
  const extension = extensionOf(path)
  return extension !== undefined && MARKDOWN_EXTENSIONS.has(extension)
}

/** Resolve a reference path to a shiki grammar id, or `undefined` for plain text. */
export function referenceLang(path: string): string | undefined {
  const extension = extensionOf(path)
  return extension === undefined ? undefined : LANG_BY_EXTENSION[extension]
}

/** Build localized markdown chrome labels from the locale seat. */
function markdownLabels(t: ReferenceDocumentProps['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('panel.copy'), copiedLabel: t('panel.copied') },
    footnotes: t('panel.footnotes'),
  }
}

/**
 * Render one reference file as a document: GFM for markdown, shiki-highlighted
 * code for other types, and a plain pre (no background) as the safe fallback.
 */
export const ReferenceDocument = memo(function ReferenceDocument({ path, text, t }: ReferenceDocumentProps) {
  const labels = useMemo(() => markdownLabels(t), [t])
  if (isMarkdownReference(path)) {
    return <MarkdownText text={text} labels={labels} />
  }
  const lang = referenceLang(path)
  if (lang === undefined) {
    return <pre className={css.refFallback}>{text}</pre>
  }
  return (
    <CodeBlock
      code={text}
      lang={lang}
      copyLabel={labels.code.copyLabel}
      copiedLabel={labels.code.copiedLabel}
      className={css.refCode}
    />
  )
})
