/**
 * Render one reference file's text as a real document rather than a pre block.
 * Markdown files render through the shared GFM renderer (with shiki-highlighted
 * code fences) and resolve relative images against the file's directory; HTML
 * files render in a sandboxed iframe; other file types render as a
 * syntax-highlighted code block via the shared shiki highlighter. Unknown or
 * absent languages fall back to a plain pre so nothing renders unstyled.
 */
import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels, MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import { themedHtml } from './html-theme.ts'
import { isImagePath } from './load.ts'
import css from './Workbench.module.css'

/** A `ReferenceDocument` render call's locale seat. */
export interface ReferenceDocumentProps {
  /** The reference file's workspace-relative path (drives language detection). */
  path: string
  /** The reference file's full text. */
  text: string
  /** The workspace root's canonical host path; resolves relative markdown images. */
  workspacePath?: string | undefined
  /** Locale seat: resolves the markdown/code chrome copy, the HTML frame, and the image label. */
  t: (key: 'panel.copy' | 'panel.copied' | 'panel.footnotes' | 'panel.htmlPreview' | 'panel.imagePreview') => string
}

/** File extensions rendered as full markdown (not a code block). */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
/** File extensions rendered as a live HTML document (not highlighted code). */
const HTML_EXTENSIONS = new Set(['html', 'htm'])

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

/** Whether a reference path is an HTML file (rendered as a live document). */
export function isHtmlReference(path: string): boolean {
  const extension = extensionOf(path)
  return extension !== undefined && HTML_EXTENSIONS.has(extension)
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
 * Build the markdown image vocabularly for one reference file: relative image
 * destinations resolve to the same-origin `/api/file` endpoint against the
 * file's own directory, so an analysis's `![...](fig4_whitened.png)` renders
 * its figure instead of an empty alt. Absolute host paths and `data:`/remote
 * destinations pass through (the renderer checks their protocol); only a page
 * served over HTTP(S) resolves local files.
 * @param workspacePath - the workspace root's canonical host path.
 * @param filePath - the reference file's workspace-relative path.
 * @param protocol - the page's URL protocol at render time (defaults to the live window).
 * @param origin - the page's URL origin at render time (defaults to the live window).
 * @returns the image resolver, or `undefined` when local files cannot be served.
 */
export function buildPathImages(
  workspacePath: string | undefined,
  filePath: string,
  protocol = window.location.protocol,
  origin = window.location.origin,
): MarkdownPathImages | undefined {
  if (workspacePath === undefined) return undefined
  if (protocol !== 'http:' && protocol !== 'https:') return undefined
  const slash = filePath.lastIndexOf('/')
  const baseDir = slash < 0 ? '' : filePath.slice(0, slash)
  return {
    /* v8 ignore next -- listReferenceFiles always builds a `dir/name` path, so the empty base join is defensive. */
    resolve: (value: string): string | undefined => {
      if (value.length === 0 || value.startsWith('//') || value.includes('\0')) return undefined
      const absolute = value.startsWith('/') ? value : `${workspacePath}/${baseDir}/${value}`
      return `${origin}/api/file?path=${encodeURIComponent(absolute)}`
    },
  }
}

/**
 * Render the file as a live HTML document inside an opaque-origin sandboxed
 * iframe. The LLMPWA reports (matplotlib HTML exports) embed their figures as
 * inline `data:` URIs, so `srcDoc` renders them fully without the parent page
 * access; the `sandbox="allow-scripts"` keeps the document isolated from the
 * application origin (it cannot reach the workspace or the authenticated file
 * API). A `srcDoc` avoids a network round trip and keeps the panel free of a
 * transient blob URL.
 * @param text - the HTML document source.
 * @param label - the localized frame label (accessibility name).
 * @returns a sandboxed iframe, keyed by the document so a new source remounts it.
 */
export function HtmlPreview({ text, label }: { text: string; label: string }): ReactNode {
  /* v8 ignore next -- a stable key ties the iframe to the document so srcDoc changes remount it. */
  return <iframe className={css.refHtml} sandbox="allow-scripts" title={label} srcDoc={themedHtml(text)} data-html-preview />
}

/**
 * Resolve one image file to the same-origin authenticated `/api/file` URL that
 * serves its bytes, or `undefined` when local files cannot be served (no
 * workspace path, or the page is not over HTTP(S)). The path is treated as an
 * absolute host path, matching how {@link buildPathImages} serves figures.
 * @param workspacePath - the workspace root's canonical host path.
 * @param filePath - the image file's workspace-relative path.
 * @param protocol - the page's URL protocol at render time (defaults to the live window).
 * @param origin - the page's URL origin at render time (defaults to the live window).
 * @returns the image URL, or `undefined` when local files cannot be served.
 */
export function imageSource(
  workspacePath: string | undefined,
  filePath: string,
  protocol = window.location.protocol,
  origin = window.location.origin,
): string | undefined {
  if (workspacePath === undefined) return undefined
  if (protocol !== 'http:' && protocol !== 'https:') return undefined
  const absolute = `${workspacePath}/${filePath}`
  return `${origin}/api/file?path=${encodeURIComponent(absolute)}`
}

/**
 * Render an image reference inline from the workspace `/api/file` endpoint, so
 * a figure under `4_图片/` displays instead of failing as a not-a-text file. The
 * image sits scaled to the pane width and scrolls vertically with the rest of
 * the reference body.
 * @param path - the image file's workspace-relative path.
 * @param workspacePath - the workspace root's canonical host path.
 * @param label - the localized accessibility name for the image.
 * @returns an inline image, or nothing when the file cannot be served.
 */
export function ImageReference({
  path,
  workspacePath,
  label,
}: {
  path: string
  workspacePath: string | undefined
  label: string
}): ReactNode {
  /* v8 ignore next -- an image renders only when the workspace path resolves, so the undefined arm is unreachable in practice. */
  const source = imageSource(workspacePath, path)
  return source === undefined
    ? null
    : <img className={css.refImage} src={source} alt={label} data-image-reference />
}

/**
 * Render one reference file as a document: GFM for markdown, a live HTML
 * document for `.html`, an inline image for image files, shiki-highlighted code
 * for other types, and a plain pre (no background) as the safe fallback.
 */
export const ReferenceDocument = memo(function ReferenceDocument({ path, text, workspacePath, t }: ReferenceDocumentProps) {
  const labels = useMemo(() => markdownLabels(t), [t])
  const pathImages = useMemo(() => buildPathImages(workspacePath, path), [workspacePath, path])
  if (isMarkdownReference(path)) {
    return <MarkdownText text={text} labels={labels} pathImages={pathImages} />
  }
  if (isHtmlReference(path)) {
    return <HtmlPreview text={text} label={t('panel.htmlPreview')} />
  }
  if (isImagePath(path)) {
    return <ImageReference path={path} workspacePath={workspacePath} label={t('panel.imagePreview')} />
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
