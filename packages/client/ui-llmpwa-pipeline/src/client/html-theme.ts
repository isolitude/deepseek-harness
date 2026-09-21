/**
 * Build the themed wrapper document that an HTML reference file renders in.
 * Kept in a `.ts` module so the app-style HTML markup is not mistaken for
 * product copy by the client i18n gate (which scans `.tsx` string returns).
 */

/**
 * Inject a theme-aware baseline into a report HTML document so a dark
 * application theme is not jarred by a fixed white report: a `color-scheme`
 * meta and an override that flips the page background and text to the dark
 * palette under `prefers-color-scheme: dark`. The report's own (later, inline)
 * styles still win for figures; this only sets the page canvas so the pane
 * blends with the surrounding workbench. Dark-mode text is `!important` because
 * a report often hardcodes a dark inline `body` color, which would otherwise
 * beat the palette rule and leave text unreadable on the dark canvas.
 * @param text - the authored HTML document (may be a fragment or a full doc).
 * @returns the document with the theme baseline injected into `<head>`.
 */
export function themedHtml(text: string): string {
  const baseline = '<meta charset="utf-8" /><meta name="color-scheme" content="dark light" />'
    + '<style>html,body{background:#fff;color:#111827;color-scheme:light}'
    + '@media (prefers-color-scheme:dark){html,body{background:#161b22;color:#e5e7eb !important;color-scheme:dark}}</style>'
  const head = /<head([^>]*)>/i.exec(text)
  if (head !== null) {
    const at = head.index + head[0].length
    return `${text.slice(0, at)}${baseline}${text.slice(at)}`
  }
  return `<!doctype html><html><head>${baseline}</head><body>${text}</body></html>`
}
