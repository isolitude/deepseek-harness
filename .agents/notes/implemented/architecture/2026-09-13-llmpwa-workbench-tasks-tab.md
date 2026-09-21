# Agent Note: LLMPWA workbench fit-task records tab

Status: implemented

English | [中文](2026-09-13-llmpwa-workbench-tasks-tab.zh.md)

## Problem

The LLMPWA workbench previews an analysis's pipeline DAG and reference documents, but the per-run fit records that the analysis actually produces — the `task/` directory tree documented in the analysis's own README — were invisible in the GUI. Each fit run writes a machine-readable `task/<id>/status.json` (status, timestamps, environment, summary metrics, artifact paths, reports, issues, notes) and a set of numbered output directories, and users needed to parse that status and open those files from the same panel that already previews the DAG and references.

## Decision

Add a third preview tab, **Tasks**, alongside **DAG** and **Documents**, that reads each analysis's `task/` directory and lets the user browse the fit records without touching the Host.

- The tab lists the analysis's task directories under `LLMPWA/analyses/<analysis>/task/`. A missing or unreadable task root yields an empty state, not an error — `kk_new`/`kk_pipi` have no `task/` directory. The task root and `status.json` paths are constants (`TASKS_ROOT`, `TASK_STATUS_FILE`) plus per-analysis helpers, mirroring the existing snapshot-path constants.
- Each task's `status.json` is read through the existing `readPaged` walk and JSON-parsed in `loadTaskStatus`, returning a structured `TaskLoad` (`missing` / `parse` / `unexpected`) exactly like `loadSnapshot`. Parsing happens at this boundary; presenters assume a validated record shape. `listTasks` loads every task's status so each card in the grid shows its status, type, period, and environment; a single failed status degrades that card to the directory name rather than failing the grid.
- Pure folds in `presenters.ts` build the display model: `taskStatusOf` resolves the lifecycle status (`running` / `completed` / `failed` / `paused`, defaulting unknown to `running`), `buildTaskView` flattens the `environment` block into label/value rows (skipping absent and empty fields), and `formatPeriod` renders the timestamp pair. No React or DSH concepts cross this boundary.
- The `state`/`actions` and `WorkbenchInjected` face grow a task surface: list tasks, list one directory (`listTaskDir`), and read one file. New files are read by lazily expanding tree directories; a fresh read aborts the prior in-flight read; a settlement after abort writes nothing.
- The tab renders the tasks as a **card grid**, each card showing the task name, status dot, type, period, and environment. Clicking a card opens a **bottom popup** (like the agent drawer but anchored to the bottom edge) that opens a **directory tree** rooted at the task folder, whose subdirectories expand in place and preview files through the same `ReferenceDocument` renderer as the reference files (GFM for markdown, shiki for code). The popup is resizable by dragging its top handle, and clicking the page behind it collapses it to a bottom title strip.

A `status.json` that is absent (a freshly created running task) degrades the card to the directory name while the tree still lists what the task holds; a malformed one likewise degrades the card rather than failing the grid.

## Alternatives considered

**Skip the tasks tab and rely on the agent or an external viewer.** Rejected: task status and files are stable machine-readable state that belongs in the same workbench surface already reading the analysis's snapshot and references, and the GUI is the intended consumer of the documented `status.json` contract.

**List the task folder's known numbered subdirectories flatly.** Rejected: the task folder can hold arbitrary nested subdirectories beyond the documented `1_运行代码` … `5_生成器日志` layout, so a lazily expanded directory tree navigates the real nesting instead of flattening to a fixed set.

**Add image/binary rendering for `4_图片/`.** Deferred: the text reader rejects non-text bytes; image preview is recorded as a known limitation rather than pulling binary rendering into this change.

## Consequences

- `WorkbenchView` widens by one member (`'tasks'`); the `TABS` array, focus, and preview switch handle it. The default tab remains `DAG`.
- The store's `selected` action resets all task state (including the popup and tree) so switching analyses never leaks a prior task selection.
- The bottom task popup mirrors the agent drawer's collapse/expand and resize handles, so it never reflows the card grid behind it.
- Analysis agent-session mapping is untouched; the tasks tab reads the workspace only and does not write or trigger execution.
- The package's client `src/` stays at per-file 100% coverage; new behavior is pinned by presenter, load, store, face, and component specs.

## Verification

The package's presenter, load, store, face, and workbench specs cover the new surfaces: status resolution, structured load outcomes (including missing, parse, and non-object `status.json`), task discovery across absent subdirs, all-status loading for cards, the card grid and bottom popup render, directory-tree expand/load, abort suppression, and popup collapse/resize. `verify-client-ui-i18n` confirms all new copy is locale-owned; `verify-export-jsdoc` and typecheck/lint stay green.
