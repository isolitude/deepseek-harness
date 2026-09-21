// @vitest-environment jsdom
/**
 * The reference-document renderer: GFM for markdown files, a live HTML
 * document for `.html`, shiki-highlighted code for other types, and a plain
 * pre as the safe fallback. Each arm is asserted on user-visible output.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { buildPathImages, isMarkdownReference, isHtmlReference, referenceLang, ReferenceDocument } from '../src/client/reference-document.tsx'

const t = (key: string): string => key

afterEach(() => { cleanup() })

describe('ReferenceDocument', () => {
  it('renders markdown files through the GFM renderer', () => {
    render(<ReferenceDocument path="document/guide.md" text={'# Title\n\nSome body.'} t={t} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy()
    expect(screen.getByText('Some body.')).toBeTruthy()
  })

  it('renders markdown relative images through the workspace file API', () => {
    const { container } = render(
      <ReferenceDocument
        path="LLMPWA/analyses/kk_dis/task/t1/3_报告/report.md"
        text={'![fig](fig1_all_paths.png)'}
        workspacePath="/home/user/ws"
        t={t}
      />,
    )
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toBe(
      'http://localhost:3000/api/file?path=%2Fhome%2Fuser%2Fws%2FLLMPWA%2Fanalyses%2Fkk_dis%2Ftask%2Ft1%2F3_%E6%8A%A5%E5%91%8A%2Ffig1_all_paths.png',
    )
  })

  it('renders HTML files as a live sandboxed document, not highlighted code', () => {
    const { container } = render(
      <ReferenceDocument path="report.html" text={'<!doctype html><html><head></head><body><h1>Report</h1></body></html>'} t={t} />,
    )
    const frame = container.querySelector('iframe')
    expect(frame).toBeTruthy()
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('srcdoc')).toContain('<h1>Report</h1>')
    // The theme baseline injects a color-scheme so the pane follows dark mode.
    expect(frame?.getAttribute('srcdoc')).toContain('color-scheme')
    expect(frame?.getAttribute('title')).toBe('panel.htmlPreview')
    // Dark-mode text is forced so a report's hardcoded inline body color
    // cannot leave dark text on the dark canvas.
    expect(frame?.getAttribute('srcdoc')).toContain('color:#e5e7eb !important')
    // The HTML document is not shown as a highlighted code block.
    expect(screen.queryByRole('button', { name: 'panel.copy' })).toBeNull()
  })

  it('renders an HTML fragment by wrapping it in a themed document', () => {
    const { container } = render(
      <ReferenceDocument path="report.html" text={'<h1>Fragment</h1>'} t={t} />,
    )
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('srcdoc')).toContain('<h1>Fragment</h1>')
    expect(frame?.getAttribute('srcdoc')).toContain('color-scheme')
  })

  it('highlights a code file with its language and a copy action', () => {
    render(<ReferenceDocument path="resonances_config.toml" text={'[resonances]\n# config'} t={t} />)
    // The shared CodeBlock's language banner names the grammar.
    expect(screen.getByText('toml')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'panel.copy' })).toBeTruthy()
  })

  it('falls back to a plain pre for an unknown language', () => {
    const { container } = render(<ReferenceDocument path="notes/todo.txt" text={'buy milk\nwalk dog'} t={t} />)
    expect(container.querySelector('pre')?.textContent).toContain('buy milk')
    // No copy button chrome for the plain fallback.
    expect(screen.queryByRole('button', { name: 'panel.copy' })).toBeNull()
  })
})

describe('buildPathImages', () => {
  it('resolves a relative image against the file directory to /api/file', () => {
    const resolve = buildPathImages('/home/user/ws', 'LLMPWA/analyses/kk_dis/task/t1/3_报告/report.md')
    expect(resolve?.resolve('fig1_all_paths.png')).toBe(
      'http://localhost:3000/api/file?path=%2Fhome%2Fuser%2Fws%2FLLMPWA%2Fanalyses%2Fkk_dis%2Ftask%2Ft1%2F3_%E6%8A%A5%E5%91%8A%2Ffig1_all_paths.png',
    )
  })

  it('passes an absolute host path through to /api/file', () => {
    const resolve = buildPathImages('/home/user/ws', 'LLMPWA/analyses/kk_dis/task/t1/3_报告/report.md')
    expect(resolve?.resolve('/data/fig.png')).toBe('http://localhost:3000/api/file?path=%2Fdata%2Ffig.png')
  })

  it('returns no resolver without a workspace path or off an HTTP(S) page', () => {
    expect(buildPathImages(undefined, 'report.md')).toBeUndefined()
    expect(buildPathImages('/home/user/ws', 'report.md', 'file:')).toBeUndefined()
    expect(buildPathImages('/home/user/ws', 'report.md', 'ws:')).toBeUndefined()
  })

  it('keeps destinations that cannot be a served file inert', () => {
    const resolve = buildPathImages('/home/user/ws', 'report.md')
    expect(resolve?.resolve('')).toBeUndefined()
    expect(resolve?.resolve('//cdn.example.com/x.png')).toBeUndefined()
    expect(resolve?.resolve('a\0b.png')).toBeUndefined()
  })
})

describe('reference language detection', () => {
  it('recognizes markdown extensions', () => {
    expect(isMarkdownReference('document/x.md')).toBe(true)
    expect(isMarkdownReference('document/x.markdown')).toBe(true)
    expect(isMarkdownReference('resonances_config.toml')).toBe(false)
  })

  it('recognizes HTML extensions', () => {
    expect(isHtmlReference('report.html')).toBe(true)
    expect(isHtmlReference('a/report.htm')).toBe(true)
    expect(isHtmlReference('resonances_config.toml')).toBe(false)
  })

  it('maps common extensions to shiki grammar ids', () => {
    expect(referenceLang('a/b.py')).toBe('python')
    expect(referenceLang('c.json')).toBe('json')
    expect(referenceLang('d.toml')).toBe('toml')
    expect(referenceLang('e.txt')).toBeUndefined()
    // A path with no extension resolves to no grammar (plain text).
    expect(referenceLang('noextension')).toBeUndefined()
  })
})
