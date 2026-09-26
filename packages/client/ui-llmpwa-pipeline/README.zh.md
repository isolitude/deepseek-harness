---
description: "LLMPWA 工作台：一个左侧 Sidebar 动作，打开全幅面板以选择 LLMPWA analysis，并从导出的快照预览其流水线 DAG、参考文档与拟合任务记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-llmpwa-pipeline

[English](README.md) | 中文

## 概述

`dsh-client-ui-llmpwa-pipeline` 在同一个共享 store 上挂载两个浏览器插槽：一个打开工作台的 `sidebar.footer.action` 和一个绘制它的 `shell.overlay` 主体。工作台列出 `LLMPWA/analyses` 下的 analyses；所选 analysis 通过三个标签页预览——其来自 `gen/pipeline_state.json` 的流水线 DAG、其参考文档，以及其在 `task/` 下的拟合任务记录，每个任务读取其 `status.json` 并列出其文件。工作台还打开或启动该 analysis 的 agent 会话，每次打开为每个 analysis 保留一个记录的会话。本包只读取导出的快照与任务记录；从不写文件或触发 LLMPWA 执行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在已挂载 `dsh-client-ui-slots`、`dsh-client-ui-sidebar`、`dsh-client-ui-layout`、`dsh-client-ui-session`、`dsh-api-session-controller` 与 `dsh-api-workspace-files` 的组合中挂载浏览器 bundle。本包把两个工作台表面注册到共享的根级条目 id `llmpwa-workbench`：页脚动作打开覆盖层，覆盖层主体绘制面板。

工作台从调用它的会话解析工作区根，并调用 Remote `workspaceFiles` 命名空间以列出 analyses、加载快照、读取参考文件，以及读取任务记录及其文件。`inject` 声明 `slots`、`locale`、`sessions`、`remote` 与 `remote.workspaceFiles`。

### 工作台面板

面板从 `LLMPWA/analyses` 排序列出 analyses。选择其一即加载并渲染其流水线 DAG，在其下列出该 analysis 的参考文件，并挂载绑定到该 analysis agent 会话的嵌入式实时会话。第三个 **任务** 标签页将该 analysis 的拟合任务显示为卡片网格（任务名、状态点、类型、时间段、环境）；点击卡片打开一个底部弹出页，让用户通过目录树浏览任务文件夹、预览每个文件。页脚动作打开同一 analysis 的 agent 会话（当其仍存活时复用它）或启动一个新会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计

两个注册共享同一个 store 与同一个注入 face：一个根级的 `sidebar.footer.action` 与 `shell.overlay`。组件从不 await 任何事——每个请求经过 face，face 调用 Remote 载体并通过 store 自身的 actions 写入结果。对同一表面的新请求会中止仍在途中的上一次读取，中止后才到达的结果不写入任何内容。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 纯 host 半部；对 host 树无所贡献 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器插件主体：注册两个表面与字典 |
| [`src/client/face.ts`](src/client/face.ts) | 异步业务 face：analyses、快照、参考文件、任务、agent 会话 |
| [`src/client/load.ts`](src/client/load.ts) | 经 `workspaceFiles` 命名空间的远程调用 |
| [`src/client/store.ts`](src/client/store.ts) | 会话级工作台状态与 actions |
| [`src/client/presenters.ts`](src/client/presenters.ts) | 纯 DAG、参考文件与任务状态显示模型 |
| [`src/client/Workbench.tsx`](src/client/Workbench.tsx) | 覆盖层主体：DAG、参考文件、任务卡片网格与底部弹出页；嵌入式会话 |
| [`src/client/FooterButton.tsx`](src/client/FooterButton.tsx) | 打开面板的 Sidebar 页脚动作 |

### Agent 会话映射

每个 analysis 的 agent 会话针对覆盖该 analysis 目录的 Workspace 记录创建（在工作台列出 analyses 时创建或复用），且 dsh 会话把该目录持久化为 `cwd`。因此恢复会话先检查 analysis 的磁盘 settings 文件，再扫描实时 Session 列表中 `cwd` 匹配该 analysis 目录的会话——即使 settings 写入尚未执行，该映射也能跨服务器重启与页面重载存活。列出时还会把已在该 analysis 目录运行过的实时 Session 计入该 analysis 的 Workspace，因此 agent 会话显示在该 analysis 分组下，而非 `未分组`。

### 拟合任务记录

一个拟合任务位于 `LLMPWA/analyses/<analysis>/task/<task_id>/`，其机器可读的 `status.json`（状态、时间戳、环境、结果指标、产物路径、报告、问题、备注）遵循该 analysis 自身 README 记录的布局。任务标签页将任务目录显示为卡片网格，加载每个任务的 `status.json` 使卡片显示状态、类型、时间段与环境，并在点击时打开底部弹出页。弹出页打开以任务文件夹为根目录的目录树，其有编号子目录（`1_运行代码` … `5_生成器日志`）与散落文件就地展开，并通过与参考文件相同的文档阅读器预览。没有 `task/` 目录的 analysis 渲染为空状态而非报错。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-client-ui-slots](../ui-slots/README.zh.md) — 两个表面注册进的插槽注册表。
- [dsh-api-workspace-files](../../api/workspace-files/README.zh.md) — 工作台读取的 Remote `workspaceFiles` 命名空间。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包完全在浏览器中预览与驱动 agent 会话，不注册任何面向模型的内容。

#### KV Cache 影响

无；工作台不组装或变更 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅快照预览** — 工作台渲染最后导出的 `gen/pipeline_state.json`；不执行或验证流水线。
- **每个 analysis 一个 agent 会话** — 重开会话会复用其记录的存活会话；启动新会话会清除前序上下文。
- **图片预览限于工作区** — 任务标签页的目录树列出 `4_图片/` 下的图片文件，并通过工作区文件 API 内联预览；仅当页面经 HTTP(S) 且来自工作区会话时渲染；脱离主机或非 HTTP 页面回退到文本错误分支。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
