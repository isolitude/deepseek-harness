/**
 * The pipeline DAG, drawn with inline SVG over a layered layout.
 *
 * Pure presentation: it receives the display model and renders nothing that
 * subscribes or reaches a store. Node ranks and edges come from {@link buildDag}
 * in presenters.ts, so this component owns no layout math.
 */
import type { ReactNode } from 'react'
import type { DagModel } from './presenters.ts'
import css from './Dag.module.css'

const NODE_W = 148
const NODE_H = 44
const GAP_X = 70
const GAP_Y = 42

/** Colors for each stage status, on the node's status dot and border. */
export const STATUS_COLOR: Record<string, string> = {
  cached: '#22c55e',
  ran: '#3b82f6',
  missing: '#ef4444',
}

/**
 * Render one layer's nodes at their computed x/y.
 * @param model - the DAG display model.
 * @param layerIndex - the layer to draw.
 * @returns the node elements for that layer.
 */
function layerNodes(model: DagModel, layerIndex: number): ReactNode {
  const inLayer = model.layout.filter(l => l.layer === layerIndex)
  return inLayer.map((l, rank) => {
    const node = model.nodes.find(n => n.id === l.id)
    if (node === undefined) return null
    const x = layerIndex * (NODE_W + GAP_X)
    const y = rank * (NODE_H + GAP_Y)
    const color = STATUS_COLOR[node.status] ?? '#9ca3af'
    return (
      <g key={node.id}>
        <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={8}
          className={css.node} style={{ borderColor: color }} data-stage={node.id} />
        <circle cx={x + 12} cy={y + NODE_H / 2} r={5} fill={color} className={css.dot} />
        <text x={x + 24} y={y + NODE_H / 2 + 4} className={css.label}>{node.label}</text>
        <text x={x + 24} y={y + NODE_H / 2 + 21} className={css.kind}>{node.kind}</text>
      </g>
    )
  })
}

/**
 * Draw the DAG.
 * @param props - the display model and its localized accessible name.
 * @returns the SVG element.
 */
export function Dag({ model, label }: { model: DagModel; label: string }): ReactNode {
  const layers = Math.max(1, ...model.layout.map(l => l.layer + 1))
  const width = layers * (NODE_W + GAP_X) - GAP_X
  let maxRank = 1
  for (const l of model.layout) {
    const count = model.layout.filter(ll => ll.layer === l.layer).length
    if (count > maxRank) maxRank = count
  }
  const height = maxRank * (NODE_H + GAP_Y) - GAP_Y

  return (
    <svg className={css.dag} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={label} data-testid="llmpwa-dag">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className={css.arrow} />
        </marker>
      </defs>
      {model.edges.map((e) => {
        const from = model.layout.find(l => l.id === e.from)
        const to = model.layout.find(l => l.id === e.to)
        if (from === undefined || to === undefined) return null
        if (to.layer <= from.layer) return null
        const fromRank = model.layout.filter(l => l.layer === from.layer).indexOf(from)
        const toRank = model.layout.filter(l => l.layer === to.layer).indexOf(to)
        const x1 = from.layer * (NODE_W + GAP_X) + NODE_W
        const y1 = fromRank * (NODE_H + GAP_Y) + NODE_H / 2
        const x2 = to.layer * (NODE_W + GAP_X)
        const y2 = toRank * (NODE_H + GAP_Y) + NODE_H / 2
        const mid = (x1 + x2) / 2
        const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
        return <path key={`${e.from}-${e.to}`} d={d} className={css.edge} markerEnd="url(#arrow)" />
      })}
      {Array.from({ length: layers }, (_, layerIndex) => layerNodes(model, layerIndex))}
    </svg>
  )
}
