/**
 * Pure DAG / params / artifacts presenters. These are React-free folds, so
 * they run in the default node environment and assert the display model they
 * produce — statuses, layered layout, and flattening.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDag, buildParamRows, buildTaskView, formatPeriod, formatValue, groupArtifacts, statusOf, taskStatusOf,
} from '../src/client/presenters.ts'

describe('statusOf', () => {
  it('reports a missing status when the manifest has no record or the record is absent', () => {
    expect(statusOf(undefined)).toBe('missing')
    expect(statusOf({ present: false, status: 'ran' })).toBe('missing')
  })

  it('reports the manifest status when the record is present', () => {
    expect(statusOf({ present: true, status: 'cached' })).toBe('cached')
    expect(statusOf({ present: true, status: 'ran' })).toBe('ran')
  })
})

describe('buildDag', () => {
  const stages = [
    { name: 'a', kind: 'python', dependencies: [] },
    { name: 'b', kind: 'llm', dependencies: ['a'] },
    { name: 'c', kind: 'agent', dependencies: ['a', 'b'] },
  ]

  it('builds nodes with labels, kinds, and statuses from the manifest', () => {
    const model = buildDag(stages, {
      a: { present: true, status: 'ran' },
      b: { present: true, status: 'cached' },
    })
    expect(model.nodes).toEqual([
      { id: 'a', label: 'a', kind: 'python', status: 'ran' },
      { id: 'b', label: 'b', kind: 'llm', status: 'cached' },
      { id: 'c', label: 'c', kind: 'agent', status: 'missing' },
    ])
  })

  it('derives edges from dependencies and deduplicates them', () => {
    const model = buildDag(stages)
    expect(model.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ])
  })

  it('lays nodes in longest-path layers so no edge joins a same layer', () => {
    const model = buildDag(stages)
    expect(model.layout).toEqual([
      { id: 'a', layer: 0 },
      { id: 'b', layer: 1 },
      { id: 'c', layer: 2 },
    ])
    const layerOf = (id: string): number => model.layout.find(l => l.id === id)?.layer ?? -1
    for (const edge of model.edges) {
      expect(layerOf(edge.to)).toBeGreaterThan(layerOf(edge.from))
    }
  })

  it('skips self edges and edges to unknown stages', () => {
    const model = buildDag([
      { name: 'a', kind: 'python', dependencies: ['a', 'no-such'] },
    ])
    expect(model.edges).toEqual([])
    expect(model.layout).toEqual([{ id: 'a', layer: 0 }])
  })

  it('fans a deps_all stage in from every other stage', () => {
    const model = buildDag([
      { name: 'a', kind: 'python', dependencies: [] },
      { name: 'b', kind: 'python', dependencies: [] },
      { name: 'all', kind: 'agent', deps_all: true },
    ])
    expect(model.edges).toEqual([
      { from: 'a', to: 'all' },
      { from: 'b', to: 'all' },
    ])
  })

  it('deduplicates an edge reached from both an explicit dep and deps_all', () => {
    const model = buildDag([
      { name: 'a', kind: 'python', dependencies: [] },
      { name: 'b', kind: 'python', dependencies: ['a'] },
      { name: 'c', kind: 'agent', dependencies: ['a', 'b'], deps_all: true },
    ])
    const keys = model.edges.map(e => `${e.from}->${e.to}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(model.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ])
  })
})

describe('buildParamRows', () => {
  it('flattens params into display rows', () => {
    const rows = buildParamRows([
      { path: 'p.0', kind: 'fixed', value: 1.5, fixed: true },
      { path: 'p.1', kind: 'range', value: [0, 1], range: [0.2, 0.9] },
      { path: 'p.2', kind: 'free', error: 'bad' },
      { value: 7 },
    ])
    expect(rows[0]).toEqual({ resonance: 'fixed', path: 'p.0', value: '1.5', fixed: true, range: '—', error: '—' })
    expect(rows[1]?.value).toBe('[0, 1]')
    expect(rows[1]?.range).toBe('[0.2, 0.9]')
    expect(rows[2]?.error).toBe('bad')
    expect(rows[2]?.fixed).toBe(false)
    // No kind or path → the empty fallbacks.
    expect(rows[3]).toEqual({ resonance: '', path: '', value: '7', fixed: false, range: '—', error: '—' })
  })

  it('formats scalars, arrays, and empty values', () => {
    expect(formatValue(undefined)).toBe('—')
    expect(formatValue(null)).toBe('—')
    expect(formatValue('x')).toBe('x')
    expect(formatValue([1, 'a'])).toBe('[1, a]')
    expect(formatValue(3)).toBe('3')
    expect(formatValue(3.5)).toBe('3.5')
    // Nested scalar kinds: an array element that is null, an object, and one
    // with no JSON form each round-trip through stringifyScalar.
    expect(formatValue([null])).toBe('[null]')
    expect(formatValue([{ a: 1 }])).toBe('[{"a":1}]')
    expect(formatValue([() => 1])).toBe('[[function]]')
    expect(formatValue([1n])).toBe('[[value]]')
  })
})

describe('groupArtifacts', () => {
  it('keeps only non-empty categories in insertion order', () => {
    const groups = groupArtifacts({
      fit: ['a.json'],
      misc: [],
      plots: ['p.png', 'q.png'],
    })
    expect(groups).toEqual([
      { category: 'fit', files: ['a.json'] },
      { category: 'plots', files: ['p.png', 'q.png'] },
    ])
  })
})

describe('taskStatusOf', () => {
  it('resolves each documented lifecycle status', () => {
    expect(taskStatusOf('running')).toBe('running')
    expect(taskStatusOf('completed')).toBe('completed')
    expect(taskStatusOf('failed')).toBe('failed')
    expect(taskStatusOf('paused')).toBe('paused')
  })

  it('defaults an unknown or missing status to running', () => {
    expect(taskStatusOf(undefined)).toBe('running')
    expect(taskStatusOf('weird')).toBe('running')
    expect(taskStatusOf(null)).toBe('running')
  })
})

describe('buildTaskView', () => {
  it('resolves the status and flattens the environment rows', () => {
    const model = buildTaskView({
      task_id: 't1',
      title: 'Run 100',
      status: 'completed',
      date_start: '2026-09-12',
      date_end: '2026-09-13',
      environment: { host: 'HEP1', gpu: '2xRTX', python_env: 'kk_fit' },
      task_type: 'fit_multistart',
    })
    expect(model.status).toEqual({ name: 'completed', status: 'completed', labelKey: 'completed' })
    expect(model.environmentRows).toEqual([
      { key: 'host', value: 'HEP1' },
      { key: 'gpu', value: '2xRTX' },
      { key: 'python_env', value: 'kk_fit' },
    ])
  })

  it('yields empty rows for a task that omits environment', () => {
    const model = buildTaskView({ task_id: 't1', status: 'running' })
    expect(model.status.status).toBe('running')
    expect(model.environmentRows).toEqual([])
  })

  it('skips absent and empty fields in a flattened block', () => {
    // The record deliberately carries values outside the document contract
    // (null / empty-string / undefined) to pin the defensive skip behavior, so
    // the environment block is cast away from the typed TaskEnvironmentDecl.
    const model = buildTaskView({
      task_id: 't1',
      status: 'completed',
      environment: { host: '', gpu: null, python_env: 'venv' } as never,
    })
    expect(model.environmentRows).toEqual([{ key: 'python_env', value: 'venv' }])
  })

  it('defaults an unknown status to running even with a full record', () => {
    const model = buildTaskView({ task_id: 't1', status: 'done' as never })
    expect(model.status.status).toBe('running')
  })
})

describe('formatPeriod', () => {
  it('formats a full start → end period', () => {
    expect(formatPeriod('2026-09-12', '2026-09-13')).toBe('2026-09-12 → 2026-09-13')
  })

  it('falls back to the sole timestamp when one side is unset', () => {
    expect(formatPeriod('2026-09-12', undefined)).toBe('2026-09-12')
    expect(formatPeriod(undefined, '2026-09-13')).toBe('2026-09-13')
    expect(formatPeriod(null, '2026-09-13')).toBe('2026-09-13')
  })

  it('renders an em dash when both sides are unset', () => {
    expect(formatPeriod(undefined, undefined)).toBe('—')
    expect(formatPeriod(null, null)).toBe('—')
  })
})
