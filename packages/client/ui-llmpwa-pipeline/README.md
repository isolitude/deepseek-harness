---
description: "LLMPWA workbench: a left-Sidebar action that opens a full-frame panel to pick an LLMPWA analysis and preview its pipeline DAG, reference documents, and fit-task records from the exported snapshots"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-llmpwa-pipeline

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-llmpwa-pipeline` mounts two browser slots on one shared store: a `sidebar.footer.action` that opens the workbench and a `shell.overlay` body that draws it. The workbench lists the analyses under `LLMPWA/analyses`; a selected analysis is previewed through three tabs — its pipeline DAG from `gen/pipeline_state.json`, its reference documents, and its fit-task records under `task/`, each reading that task's `status.json` and listing its files. The workbench also opens or launches the analysis's agent session, keeping one recorded session per analysis across opens. The package reads the exported snapshots and task records only; it never writes files or triggers LLMPWA execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser bundle in a composition that already mounts `dsh-client-ui-slots`, `dsh-client-ui-sidebar`, `dsh-client-ui-layout`, `dsh-client-ui-session`, `dsh-api-session-controller`, `dsh-api-workspace-controller`, and `dsh-api-workspace-files`. The package registers both workbench surfaces against the shared root-scoped entry id `llmpwa-workbench`: the footer action opens the overlay, and the overlay body draws the panel.

The workbench resolves the workspace root from the session it is invoked under and calls the Remote `workspaceFiles` namespace to list analyses, load a snapshot, read reference files, and read task records and their files. `inject` declares `slots`, `locale`, `sessions`, `workspaces`, `remote`, and `remote.workspaceFiles`.

### The workbench panel

The panel lists analyses sorted from `LLMPWA/analyses`. Selecting one loads and renders its pipeline DAG, listing the analysis's reference files below and mounting an embedded live conversation bound to that analysis's agent session. A third **Tasks** tab shows the analysis's fit tasks as a grid of cards (task name, status dot, type, period, environment); clicking a card opens a bottom popup that lets the user browse the task folder through a directory tree and preview each file. A footer action opens the same analysis's agent session (reusing the recorded one when it is still live) or launches a fresh one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details> <summary>Implementation internals — click to expand</summary>

### Design

Two registrations share one store and one inject face: a root-scoped `sidebar.footer.action` and `shell.overlay`. The component never awaits anything — each request goes through the face, which calls the Remote carrier and writes outcomes through the store's own actions. A fresh request for the same surface aborts the previous read still in flight, and a settlement arriving after the abort writes nothing.

### Source map

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Pure host half; contributes nothing to the host tree |
| [`src/client/index.ts`](src/client/index.ts) | Browser-plugin body: registers the two surfaces and dictionaries |
| [`src/client/face.ts`](src/client/face.ts) | Asynchronous business face: analyses, snapshot, references, tasks, agent sessions |
| [`src/client/load.ts`](src/client/load.ts) | Remote calls through the `workspaceFiles` namespace |
| [`src/client/store.ts`](src/client/store.ts) | Session-scoped workbench state and actions |
| [`src/client/presenters.ts`](src/client/presenters.ts) | Pure DAG, reference, and task-status display models |
| [`src/client/Workbench.tsx`](src/client/Workbench.tsx) | Overlay body: DAG, reference, task card grid and bottom popup; embedded conversation |
| [`src/client/FooterButton.tsx`](src/client/FooterButton.tsx) | Sidebar footer action that opens the panel |

### Agent-session mapping

Each analysis's agent session is created against a Workspace record over the analysis directory (created or reused when the workbench lists analyses), and dsh sessions persist that directory as `cwd`. Restoring a session therefore first checks the analysis's on-disk settings file, then scans the live Session list for a session whose `cwd` matches the analysis directory — so the mapping survives a server restart and a page reload even before the settings write has run. Listing also accounts any live Session already running in an analysis directory to that analysis's Workspace, so agent sessions appear under the analysis group instead of the Ungrouped bucket.

### Fit-task records

A fit task lives under `LLMPWA/analyses/<analysis>/task/<task_id>/`, and its machine-readable `status.json` (status, timestamps, environment, summary metrics, artifact paths, reports, issues, notes) follows the layout the analysis's own README documents. The Tasks tab lists the task directories as a card grid, loads each task's `status.json` so its card shows status, type, period, and environment, and opens a bottom popup on click. The popup opens a directory tree rooted at the task folder, whose numbered subdirectories (`1_运行代码` … `5_生成器日志`) and loose files expand in place and preview through the same document reader as the reference files. An analysis with no `task/` directory renders an empty state rather than an error.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-client-ui-slots](../ui-slots/README.md) — the slot registry the two surfaces register into.
- [dsh-api-workspace-files](../../api/workspace-files/README.md) — the Remote `workspaceFiles` namespace the workbench reads through.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package previews and drives agent sessions entirely in the browser and registers nothing model-facing.

#### KV Cache effect

None; the workbench does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Snapshot-only preview** — the workbench renders `gen/pipeline_state.json` as last exported; it does not execute or validate the pipeline.
- **One agent session per analysis** — reopening an analysis reuses its recorded live session; launching a new one clears the prior context.
- **Image preview scoped to the workspace** — the Tasks tab's file tree lists image files under `4_图片/` and previews them inline through the workspace file API, so it renders only when the page is served over HTTP(S) from a workspace-backed session; off-host or non-HTTP pages fall back to the text-error arm.

<a id="dev-note"></a>
### Dev Note

<details> <summary>Working context for maintainers — click to expand</summary>

None.

</details>
