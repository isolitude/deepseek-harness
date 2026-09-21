# Agent Note: LLMPWA 工作台拟合任务记录标签页

Status: implemented

[English](2026-09-13-llmpwa-workbench-tasks-tab.md) | 中文

## Problem

LLMPWA 工作台可预览 analysis 的流水线 DAG 与参考文档，但该 analysis 实际产生的单次拟合记录——即其自身 README 所记录的 `task/` 目录树——在 GUI 中不可见。每次拟合运行都会写出机器可读的 `task/<id>/status.json`（状态、时间戳、环境、结果指标、产物路径、报告、问题、备注）与一组有编号的输出目录，用户需要从同一个已预览 DAG 与参考文件的面板中解析该状态并打开这些文件。

## Decision

在 **DAG** 与 **文档** 之外新增第三个预览标签页 **任务**，读取每个 analysis 的 `task/` 目录，让用户在不接触 Host 的情况下浏览拟合记录。

- 该标签页列出 `LLMPWA/analyses/<analysis>/task/` 下的任务目录。缺失或不可读的任务根渲染为空状态而非报错——`kk_new`/`kk_pipi` 没有 `task/` 目录。任务根与 `status.json` 路径是常量（`TASKS_ROOT`、`TASK_STATUS_FILE`），外加按 analysis 的辅助函数，与既有快照路径常量对应。
- 每个任务的 `status.json` 通过既有的 `readPaged` 遍历读取，并在 `loadTaskStatus` 中 JSON 解析，返回结构化的 `TaskLoad`（`missing` / `parse` / `unexpected`），与 `loadSnapshot` 完全一致。解析发生在该边界；presenters 假定记录形态已被校验。`listTasks` 加载每个任务的状态使网格中的每张卡片显示其状态、类型、时间段与环境；单个状态失败只会让该卡片退化为目录名，而不是让整个网格失败。
- `presenters.ts` 中的纯折叠函数构建显示模型：`taskStatusOf` 解析生命周期状态（`running` / `completed` / `failed` / `paused`，未知默认 `running`），`buildTaskView` 将 `environment` 块展平为标签/值行（跳过缺失与空字段），`formatPeriod` 渲染时间戳对。无 React 或 DSH 概念跨此边界。
- `state`/`actions` 与 `WorkbenchInjected` face 增加一个任务表面：列出任务、列出单个目录（`listTaskDir`）、读取一个文件。新文件通过懒展开的目录树读取；新读取会中止仍在途中的上一次读取；中止后才到达的结果不写入任何内容。
- 该标签页将任务渲染为**卡片网格**，每张卡片显示任务名、状态点、类型、时间段与环境。点击卡片打开一个**底部弹出页**（与 agent 抽屉类似，但锚定在底边），打开以任务文件夹为根目录的**目录树**，其子目录就地展开，并通过与参考文件相同的 `ReferenceDocument` 渲染器预览文件（markdown 用 GFM，代码用 shiki）。弹出页可通过拖动顶部手柄调整大小，点击其后的页面会将其收缩为底部标题条。

缺失的 `status.json`（刚创建的运行中任务）会让卡片退化为目录名，同时目录树仍列出该任务持有的内容；格式错误的同样让卡片退化，而非使整个网格失败。

## Alternatives considered

**跳过任务标签页，依赖 agent 或外部查看器。** 拒绝：任务状态与文件是稳定的机器可读状态，本就属于读取该 analysis 快照与参考文件的同一工作台表面，且 GUI 正是文档化 `status.json` 契约的预期消费方。

**扁平列出任务的已知有编号子目录。** 拒绝：任务文件夹可能包含文档化 `1_运行代码` … `5_生成器日志` 布局之外任意的嵌套子目录，因此懒展开的目录树浏览真实嵌套结构，而非压平到固定集合。

**为 `4_图片/` 添加图片/二进制渲染。** 延期：文本阅读器拒绝非文本字节；图片预览被记录为已知限制，而非把二进制渲染纳入本次改动。

## Consequences

- `WorkbenchView` 增加一个成员（`'tasks'`）；`TABS` 数组、焦点与预览切换处理它。默认标签页仍为 `DAG`。
- store 的 `selected` action 重置所有任务状态（包括弹出页与目录树），切换 analysis 时不会泄漏先前任务选择。
- 底部任务弹出页镜像 agent 抽屉的收缩/展开与调整手柄，因此不会重排其后的卡片网格。
- analysis 的 agent 会话映射不受影响；任务标签页只读取工作区，不写入或触发执行。
- 该包的客户端 `src/` 保持逐文件 100% 覆盖率；新行为由 presenter、load、store、face 与组件 spec 固定。

## Verification

该包的 presenter、load、store、face 与工作台 spec 覆盖新表面：状态解析、结构化加载结果（包括缺失、解析失败与非对象 `status.json`）、跨缺失子目录的任务发现、卡片的状态批量加载、卡片网格与底部弹出页渲染、目录树展开/加载、中止抑制，以及弹出页收缩/调整大小。`verify-client-ui-i18n` 确认所有新增文案由 locale 所有；`verify-export-jsdoc` 与 typecheck/lint 保持绿色。
