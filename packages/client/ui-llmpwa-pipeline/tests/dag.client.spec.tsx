/**
 * The pure SVG DAG presentation over a display model: nodes, edges, status
 * colors, and the defensive arms for a layout/node that does not match.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Dag } from '../src/client/Dag.tsx'
import type { DagModel } from '../src/client/presenters.ts'

afterEach(() => { cleanup() })

const twoLayer: DagModel = {
  nodes: [
    { id: 'a', label: 'a', kind: 'python', status: 'ran' },
    { id: 'b', label: 'b', kind: 'llm', status: 'cached' },
    { id: 'c', label: 'c', kind: 'agent', status: 'missing' },
  ],
  edges: [{ from: 'a', to: 'b' }],
  layout: [
    { id: 'a', layer: 0 },
    { id: 'b', layer: 1 },
    { id: 'c', layer: 1 },
  ],
  layered: true,
}

describe('Dag', () => {
  it('renders nodes and edges over a layered model', () => {
    render(<Dag model={twoLayer} label="pipeline dag" />)
    const svg = screen.getByTestId('llmpwa-dag')
    // One plotted edge; the `<defs>` arrow marker also emits a `path`.
    expect(svg.querySelectorAll('path[marker-end]')).toHaveLength(1)
    expect(svg.querySelectorAll('rect')).toHaveLength(3)
  })

  it('skips a node whose layout id has no node record', () => {
    const model: DagModel = {
      nodes: [{ id: 'a', label: 'a', kind: 'python', status: 'ran' }],
      edges: [],
      layout: [{ id: 'a', layer: 0 }, { id: 'ghost', layer: 0 }],
      layered: true,
    }
    render(<Dag model={model} label="pipeline dag" />)
    expect(screen.getByTestId('llmpwa-dag').querySelectorAll('rect')).toHaveLength(1)
  })

  it('skips an edge whose endpoint has no layout record', () => {
    const model: DagModel = {
      nodes: [
        { id: 'a', label: 'a', kind: 'python', status: 'ran' },
        { id: 'b', label: 'b', kind: 'python', status: 'ran' },
      ],
      edges: [{ from: 'a', to: 'b' }],
      layout: [{ id: 'a', layer: 0 }, { id: 'ghost', layer: 1 }],
      layered: true,
    }
    // `b` has no layout, so the edge is skipped and only node `a` renders.
    render(<Dag model={model} label="pipeline dag" />)
    const svg = screen.getByTestId('llmpwa-dag')
    expect(svg.querySelectorAll('path[marker-end]')).toHaveLength(0)
    expect(svg.querySelectorAll('rect')).toHaveLength(1)
  })

  it('uses the neutral color for a status not in the palette', () => {
    const model: DagModel = {
      nodes: [{ id: 'a', label: 'a', kind: 'python', status: 'pending' as 'cached' | 'ran' | 'missing' }],
      edges: [],
      layout: [{ id: 'a', layer: 0 }],
      layered: true,
    }
    render(<Dag model={model} label="pipeline dag" />)
    const circle = screen.getByTestId('llmpwa-dag').querySelector('circle')
    expect(circle?.getAttribute('fill')).toBe('#9ca3af')
  })

  it('skips an edge that does not advance a layer', () => {
    const model: DagModel = {
      nodes: [
        { id: 'a', label: 'a', kind: 'python', status: 'ran' },
        { id: 'b', label: 'b', kind: 'python', status: 'ran' },
      ],
      edges: [{ from: 'a', to: 'b' }],
      layout: [
        { id: 'a', layer: 1 },
        { id: 'b', layer: 0 },
      ],
      layered: true,
    }
    render(<Dag model={model} label="pipeline dag" />)
    expect(screen.getByTestId('llmpwa-dag').querySelectorAll('path[marker-end]')).toHaveLength(0)
  })
})
