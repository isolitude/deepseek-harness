# Agent Note: LLMPWA workbench reference-rendering improvements

Status: implemented

English | [中文](2026-09-14-llmpwa-reference-rendering.zh.md)

## Problem

The LLMPWA workbench's reference preview had three rendering gaps that hurt how an analysis's own documents present. A markdown report whose figures sit next to the file (`![alt](fig4_whitened.png)`) rendered an empty `alt` instead of the image, because the GFM renderer had no resolver for relative destinations. An HTML report (a matplotlib export served the pane a fixed white canvas) stayed bright and jarred the surrounding workbench in dark mode. And the preview panes reserved more padding and a wider task tree than the content needed, shrinking the area the report actually got.

## Decision

The `ReferenceDocument` renderer now resolves relative markdown images against the workspace and themes HTML documents for the active palette, while the workbench layout gives the preview more room.

- `buildPathImages(workspacePath, filePath)` builds a `MarkdownPathImages` resolver — the renderer vocabulary the local-media display note (`2026-09-07-session-prose-local-media-display`) owns — reusing the same-origin `/api/file?path=<encoded>` serving channel that authenticated filesystem reads (the `2026-09-08-file-display-through-filesystem` note) owns (the same one `ui-chat`'s `localPathMediaUrl` uses). A relative destination joins the file's own directory and the workspace root; absolute guest paths (`/…`) pass through unchanged, remote and `data:` destinations pass through for the renderer's own protocol check, and a non-HTTP(S) page or an absent `workspacePath` resolves nothing, so the image stays an inert `alt` rather than a broken request. Only a page served over `http:`/`https:` resolves local files.
- `themedHtml(text)` wraps or patches an HTML report with a `color-scheme` meta and a small style block, so the iframe's canvas follows the environment's light/dark palette instead of a fixed white. A full document gets the baseline inserted after its `<head>`; a fragment is wrapped in a minimal `<!doctype html>`. The report's own (later, inline) styles still win for figures, so this only blends the pane. Dark-mode page text is forced with `!important`, because a report that hardcodes a dark inline `body` color would otherwise beat the palette rule and leave its text unreadable on the dark canvas.
- The preview panes widen: `.refBody` and `.preview` lose side padding, the HTML iframe fills the pane edge-to-edge, and the task tree pane narrows to 280px so the document preview gets the reclaimed column. The bottom task popup opens taller (400px) and its resize handle can drag up to the row's full height (a 90px card floor keeps the task grid visible; `max-height: 100%` keeps it inside the preview row). `.taskPreviewPane` is a vertical flex container, so the reference body and its iframe resolve a real height and the HTML document reflows when the popup changes size. Neutral-token borders across the workbench sheets are hairline (`0.5px`), matching the `ui-theme` elevation contract.

## Alternatives considered

**Encode each referenced image as an inline `data:` URL.** Rejected: it would read every figure into the client and rebuild the report, rather than letting the browser request only the images the user views, and the text reader already rejects non-text bytes at the load boundary.

**Serve resolved images through a `blob:` URL in the frame.** Rejected: the iframe is an opaque origin, so a `blob:` created in the parent page is not reachable from inside the document; the same-origin `/api/file` request is the channel that works from the workspace's own authority.

**Pull the dark baseline from the workbench's live theme tokens into iframe CSS.** Rejected: the iframe is a cross-origin (opaque) document and has no access to the parent's computed styles; the portable `@media (prefers-color-scheme: dark)` override is the only reliable self-contained signal, and the report's own figures stay untouched.

## Consequences

- Relative image resolution needs a `workspacePath` threaded from the workbench into the renderer; without it (or on a non-HTTP(S) page) the resolver is absent and the image degrades to `alt` text — the safe fallback, not an error.
- An HTML report whose figures are external files (not inlined `data:` URIs) still cannot load them, because the opaque-origin sandboxed iframe cannot reach the parent-origin `/api/file` endpoint; self-contained reports remain the fully-rendered case, documented as the limitation.
- The iframe keeps `sandbox="allow-scripts"` and a `data-html-preview` hook, so it stays isolated from the application origin and remounts cleanly on a new document.
- The report's own styles win for figures inside the iframe; the injected baseline only sets the pane canvas so it blends with the surrounding workbench. Dark-mode page text is forced `!important`, so a report's hardcoded inline body color cannot leave unreadable dark text on the dark canvas.
- The package's client `src/` stays at per-file 100% coverage; the new arms are pinned by reference-document specs (relative and absolute image resolution, inert destinations, no-resolver cases, and both the full-document and fragment HTML theme paths).
