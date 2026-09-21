/**
 * Pure DAG + status presenters for the LLMPWA pipeline workbench.
 *
 * These are React-free folds over the `pipeline_state.json` snapshot: they
 * turn `stages[]` / `manifest` into a display model the workbench renders.
 * No DSH or React concepts cross this boundary. Each function is a pure
 * function of its inputs, so the workbench never recomputes a subscription.
 */

/** A stage's run status, as the exporter's `manifest` reports it. */
export type StageStatus = 'cached' | 'ran' | 'missing'

/** The stable status of one stage. */
export interface StageStatusView {
  readonly name: string
  readonly status: StageStatus
  /** Human label key, resolved by the caller through `t`. */
  readonly labelKey: StageStatus
}

/** One DAG node. */
export interface DagNode {
  readonly id: string
  /** Stage name, shown on the node. */
  readonly label: string
  /** Stage kind (python | llm | agent). */
  readonly kind: string
  readonly status: StageStatus
}

/** One DAG edge: `from` → `to`. */
export interface DagEdge {
  readonly from: string
  readonly to: string
}

/** One node's rank (layer) in a layered layout: no edge between nodes of a rank. */
export interface DagNodeLayout {
  readonly id: string
  /** 0-based layer. */
  readonly layer: number
}

/** The whole display model the DAG component renders. */
export interface DagModel {
  readonly nodes: readonly DagNode[]
  readonly edges: readonly DagEdge[]
  readonly layout: readonly DagNodeLayout[]
  /** Longest chain length (layers), for aspect hints. */
  readonly layered: boolean
}

/** One flattened parameter row. */
export interface ParamRow {
  readonly resonance: string
  readonly path: string
  readonly value: string
  readonly fixed: boolean
  readonly range: string
  readonly error: string
}

/** A stage's manifest record as the exporter reports it (outputs keyed by field). */
export interface ManifestStage {
  readonly present: boolean
  readonly status: StageStatus
  readonly promptHash?: string | null
  readonly outputs?: Readonly<Record<string, unknown>>
}

/** The slice of the exporter snapshot the workbench reads. */
export interface PipelineSnapshot {
  readonly schema_version?: number
  readonly workdir?: string
  readonly config_file?: string
  readonly stages?: readonly StageDecl[]
  readonly manifest?: {
    readonly stages?: Readonly<Record<string, ManifestStage>>
  }
  readonly params?: readonly ParamDecl[]
  readonly artifacts?: Readonly<Record<string, readonly string[]>>
}

/** One declared stage, from `stages[]`. */
export interface StageDecl {
  readonly name: string
  readonly kind: string
  readonly dependencies?: readonly string[]
  readonly deps_all?: boolean
  [key: string]: unknown
}

/** One flattened parameter from `params[]`. */
export interface ParamDecl {
  readonly path?: string
  readonly kind?: string
  readonly value?: unknown
  readonly fixed?: boolean
  readonly range?: unknown
  readonly error?: unknown
}

/** The status the exporter assigns a missing stage record. */
const MISSING: StageStatus = 'missing'

/**
 * Resolve a declared stage's run status from the manifest sub-record.
 * @param stage - the optional manifest sub-record for that stage.
 * @returns the resolved status.
 */
export function statusOf(stage: ManifestStage | undefined): StageStatus {
  if (stage === undefined || !stage.present) return MISSING
  return stage.status
}

/**
 * Build the DAG display model: nodes, edges, and a layered layout.
 *
 * Edges come from each stage's `dependencies`; a `deps_all` stage depends on
 * every other stage (it fans in from all of them). Layers are computed by
 * longest-path depth, so no edge connects two nodes on the same layer.
 * @param stages - declared stages in config order.
 * @param manifest - optional manifest sub-records keyed by stage name.
 * @returns the display model.
 */
export function buildDag(
  stages: readonly StageDecl[],
  manifest?: Readonly<Record<string, ManifestStage>>,
): DagModel {
  const names = stages.map(s => s.name)
  const nodes: DagNode[] = stages.map(s => ({
    id: s.name,
    label: s.name,
    kind: s.kind,
    status: statusOf(manifest?.[s.name]),
  }))

  const edgeSet = new Set<string>()
  const edges: DagEdge[] = []
  const addEdge = (from: string, to: string): void => {
    if (from === to) return
    const key = `${from}\u0000${to}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push({ from, to })
  }
  for (const s of stages) {
    for (const dep of s.dependencies ?? []) {
      if (names.includes(dep)) addEdge(dep, s.name)
    }
    if (s.deps_all === true) {
      for (const other of names) addEdge(other, s.name)
    }
  }

  // Layered (longest-path) depth via Kahn's topological sort.
  // layer[v] = 1 + max(layer[u]) over every edge u → v, so no edge ever
  // connects two nodes on the same layer.
  const inDegree = new Map<string, number>()
  for (const name of names) inDegree.set(name, 0)
  for (const e of edges) {
    // v8 ignore next -- every edge endpoint is a declared stage (guarded above), so the lookup is never undefined.
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
  }
  const remaining = new Map(inDegree)
  const adjacency = new Map<string, string[]>()
  for (const e of edges) {
    // v8 ignore next -- an edge source is always a declared stage, so the lookup is never undefined.
    const list = adjacency.get(e.from) ?? []
    list.push(e.to)
    adjacency.set(e.from, list)
  }
  const layer = new Map<string, number>()
  // v8 ignore next -- a zero-in-degree stage is always declared, so the lookup is never undefined.
  const queue = names.filter(n => (inDegree.get(n) ?? 0) === 0)
  for (const n of queue) layer.set(n, 0)
  // `for...of` over an array whose length grows visits the appended nodes:
  // appending only happens under `if (rem === 0)`, after their predecessors
  // are consumed, so the ordering is a valid Kahn sweep.
  for (const node of queue) {
    // v8 ignore next -- every queued node has a layer, set when it entered or was processed.
    const depth = layer.get(node) ?? 0
    for (const next of adjacency.get(node) ?? []) {
      const nextDepth = layer.get(next) ?? 0
      if (depth + 1 > nextDepth) layer.set(next, depth + 1)
      // v8 ignore next -- every declared stage is present in `remaining`, so the lookup is never undefined.
      const rem = (remaining.get(next) ?? 1) - 1
      remaining.set(next, rem)
      if (rem === 0) queue.push(next)
    }
  }

  const layout: DagNodeLayout[] = names.map(name => ({
    id: name,
    // v8 ignore next -- every declared stage is layered by the sweep, so the lookup is never undefined.
    layer: layer.get(name) ?? 0,
  }))

  return { nodes, edges, layout, layered: true }
}

/**
 * Flatten `params[]` into display rows.
 * @param params - the exporter's flattened parameters.
 * @returns rows for the parameters table.
 */
export function buildParamRows(params: readonly ParamDecl[]): readonly ParamRow[] {
  return params.map(p => ({
    resonance: p.kind ?? '',
    path: p.path ?? '',
    value: formatValue(p.value),
    fixed: p.fixed === true,
    range: formatValue(p.range),
    error: formatValue(p.error),
  }))
}

/**
 * Stringify a scalar, array, or null value for table display.
 * @param value - the value to format.
 * @returns a short display string.
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return `[${value.map(item => stringifyScalar(item)).join(', ')}]`
  return stringifyScalar(value)
}

/**
 * Stringify one array element or scalar for the parameters table. Objects
 * (including arrays, handled by the caller) JSON-serialize; everything else
 * formats as itself.
 * @param item - the element to format.
 * @returns a short display string.
 */
function stringifyScalar(item: unknown): string {
  // The value is JSON-derived (from the exporter snapshot); only JSON
  // primitives (string, number, boolean) reach the final arm. The object and
  // function arms keep JSON round-tripping for the nested cases.
  if (item === null) return 'null'
  if (typeof item === 'object') return JSON.stringify(item)
  if (typeof item === 'function') return '[function]'
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
    return String(item)
  }
  return '[value]'
}

/**
 * Group the artifacts listing by category, keeping only non-empty categories.
 * @param artifacts - the exporter's `artifacts` record.
 * @returns ordered category → file list pairs.
 */
export function groupArtifacts(
  artifacts: Readonly<Record<string, readonly string[]>>,
): ReadonlyArray<{ readonly category: string; readonly files: readonly string[] }> {
  return Object.entries(artifacts)
    .filter(([, files]) => files.length > 0)
    .map(([category, files]) => ({ category, files }))
}

/** A fit task's lifecycle status, as `status.json` reports it. */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'paused'

/** The stable status of one fit task. */
export interface TaskStatusView {
  readonly name: string
  readonly status: TaskStatus
  /** Human label key, resolved by the caller through `t`. */
  readonly labelKey: TaskStatus
}

/** The `summary` block of a task's `status.json`, all optional (a running task has none). */
export interface TaskSummaryDecl {
  readonly n_starts?: number
  readonly n_success?: number
  readonly success_rate?: number
  readonly best_nll?: number
  readonly best_start?: number
  readonly near_global_frac?: number
  readonly wall_clock_h?: number
  [key: string]: unknown
}

/** The `artifacts` block of a task's `status.json`, all optional. */
export interface TaskArtifactsDecl {
  readonly code_dir?: string
  readonly records_dir?: string
  readonly reports_dir?: string
  readonly images_dir?: string
  readonly generator_logs_dir?: string
  readonly remote_work_dir?: string
  readonly summary_files?: readonly string[]
  [key: string]: unknown
}

/** The `environment` block of a task's `status.json`, all optional. */
export interface TaskEnvironmentDecl {
  readonly host?: string
  readonly gpu?: string
  readonly python_env?: string
  [key: string]: unknown
}

/** One parsed fit-task record, read from `<analysis>/task/<id>/status.json`. */
export interface TaskRecord {
  readonly task_id?: string
  readonly title?: string
  readonly status?: TaskStatus
  readonly date_start?: string | null
  readonly date_end?: string | null
  readonly environment?: TaskEnvironmentDecl
  readonly task_type?: string
  readonly summary?: TaskSummaryDecl
  readonly artifacts?: TaskArtifactsDecl
  readonly reports?: readonly string[]
  readonly issues_fixed?: readonly string[]
  readonly notes?: string
  [key: string]: unknown
}

/** A label/value row for a flattened task section (summary metrics or artifacts). */
export interface TaskRow {
  readonly key: string
  readonly value: string
}

/** The task display model the Tasks tab renders. */
export interface TaskView {
  readonly task: TaskRecord
  readonly status: TaskStatusView
  readonly environmentRows: readonly TaskRow[]
}

/** The lifecycle statuses a task can report, in the palette's canonical order. */
const TASK_STATUSES: readonly TaskStatus[] = ['running', 'completed', 'failed', 'paused']

/**
 * Resolve a task's lifecycle status.
 * @param status - the raw `status` field from `status.json`, unknown when absent.
 * @returns a known status; an unknown or missing value defaults to `running`
 * (a task folder without a settled status is conservatively in progress).
 */
export function taskStatusOf(status: unknown): TaskStatus {
  return TASK_STATUSES.find(s => status === s) ?? 'running'
}

/**
 * Flatten a record's plain fields into ordered label/value rows, skipping
 * absent and empty fields. A nested object or an array is formatted with
 * {@link formatValue} so no row shows the type-only shape.
 * @param record - the optional block (summary, artifacts, environment).
 * @param fields - the field names to emit, in display order.
 * @returns the non-empty rows.
 */
function rowsOf(
  record: Readonly<Record<string, unknown>> | undefined,
  fields: readonly string[],
): readonly TaskRow[] {
  if (record === undefined) return []
  const rows: TaskRow[] = []
  for (const key of fields) {
    const value = record[key]
    if (value === undefined || value === null || value === '') continue
    rows.push({ key, value: formatValue(value) })
  }
  return rows
}

/** Environment fields shown on the status card, in display order. */
const ENVIRONMENT_FIELDS: readonly string[] = ['host', 'gpu', 'python_env']

/**
 * Build the task display model: a resolved status and the flattened
 * environment rows. A running or failed task that omits `environment` yields
 * empty rows rather than an error.
 * @param task - the parsed `status.json` record.
 * @returns the display model.
 */
export function buildTaskView(task: TaskRecord): TaskView {
  const status = taskStatusOf(task.status)
  return {
    task,
    status: { name: status, status, labelKey: status },
    environmentRows: rowsOf(task.environment, ENVIRONMENT_FIELDS),
  }
}

/**
 * Format a task's start/end timestamps into a period string.
 * @param start - the task's ISO start timestamp, or null/undefined when unset.
 * @param end - the task's ISO end timestamp, or null/undefined when unset.
 * @returns a `start → end` string, or the sole timestamp, or an em dash.
 */
export function formatPeriod(start: string | null | undefined, end: string | null | undefined): string {
  if (start === undefined || start === null) {
    return end === undefined || end === null ? '—' : end
  }
  return end === undefined || end === null ? start : `${start} → ${end}`
}
