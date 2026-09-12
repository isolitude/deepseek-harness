// @vitest-environment jsdom
/**
 * The reference-document renderer: GFM for markdown files, shiki-highlighted
 * code for other types, and a plain pre as the safe fallback. Each arm is
 * asserted on user-visible output.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { isMarkdownReference, referenceLang, ReferenceDocument } from '../src/client/reference-document.tsx'

const t = (key: string): string => key

afterEach(() => { cleanup() })

describe('ReferenceDocument', () => {
  it('renders markdown files through the GFM renderer', () => {
    render(<ReferenceDocument path="document/guide.md" text={'# Title\n\nSome body.'} t={t} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy()
    expect(screen.getByText('Some body.')).toBeTruthy()
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

describe('reference language detection', () => {
  it('recognizes markdown extensions', () => {
    expect(isMarkdownReference('document/x.md')).toBe(true)
    expect(isMarkdownReference('document/x.markdown')).toBe(true)
    expect(isMarkdownReference('resonances_config.toml')).toBe(false)
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
