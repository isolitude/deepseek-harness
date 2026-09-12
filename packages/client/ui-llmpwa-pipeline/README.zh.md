---
description: "LLMPWA 工作台：一个左侧 Sidebar 动作，打开全幅面板以选择 LLMPWA analysis 并从 pipeline_state.json 快照预览其流水线 DAG。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-llmpwa-pipeline

[English](README.md) | 中文

## 概述

`dsh-client-ui-llmpwa-pipeline` 在同一个共享 store 上挂载两个浏览器插槽：一个打开工作台的 `sidebar.footer.action` 和一个绘制它的 `shell.overlay` 主体。工作台列出 `LLMPWA/analyses` 下的 analyses，从其 `gen/pipeline_state.json` 快照预览所选 analysis 的流水线 DAG，列出并读取其参考文件，并打开或启动该 analysis 的 agent 会话——每次打开为每个 analysis 保留一个记录的会话。本包只读取导出的快照；从不写文件或触发 LLMPWA 执行。

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

工作台从调用它的会话解析工作区根，并调用 Remote `workspaceFiles` 命名空间以列出 analyses、加载快照与读取参考文件。`inject` 声明 `slots`、`locale`、`sessions`、`remote` 与 `remote.workspaceFiles`。

### 工作台面板

面板从 `LLMPWA/analyses` 排序列出 analyses。选择其一即加载并渲染其流水线 DAG，在其下列出该 analysis 的参考文件，并挂载绑定到该 analysis agent 会话的嵌入式实时会话。页脚动作打开同一 analysis 的 agent 会话（当其仍存活时复用它）或启动一个新会话。

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
| [`src/client/face.ts`](src/client/face.ts) | 异步业务 face：analyses、快照、参考文件、agent 会话 |
| [`src/client/load.ts`](src/client/load.ts) | 经 `workspaceFiles` 命名空间的远程调用 |
| [`src/client/store.ts`](src/client/store.ts) | 会话级工作台状态与 actions |
| [`src/client/Workbench.tsx`](src/client/Workbench.tsx) | 覆盖层主体：DAG 预览、参考文件列表、嵌入式会话 |
| [`src/client/FooterButton.tsx`](src/client/FooterButton.tsx) | 打开面板的 Sidebar 页脚动作 |

### Agent 会话映射

每个 analysis 的 agent 会话以 `cwd` 设为 analysis 目录的方式创建，且 dsh 会话持久化该 `cwd`。因此恢复会话先检查 analysis 的磁盘 settings 文件，再扫描实时 Session 列表中 `cwd` 匹配的会话——即使 settings 写入尚未执行，该映射也能跨服务器重启与页面重载存活。

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

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
