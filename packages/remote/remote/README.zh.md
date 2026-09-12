---
description: "ctx.remote 远程执行服务约定：面向选择或挂载远程后端的部署方，以及实现后端的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote

[English](README.md) | 中文

## 概述

`dsh-remote` 定义 `ctx.remote` 远程执行服务：一个紧凑、与后端无关的约定，在每次调用解析的远程连接（SSH）上运行 shell 命令与有界文件操作。每次调用携带一个由消费工具层构建的完全显式 `RemoteConnection`，因此该接缝不施加隐藏默认值，也从不接触秘密。已提供的后端是 `dsh-remote-ssh2`；面向模型的工具位于 `dsh-tool-remote`。当 agent 需要在本地执行世界之侧具备远程命令执行与文件传输能力时选择它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

你很少直接加载 `dsh-remote`：你挂载一个注册 `ctx.remote` 的后端，然后从自己的插件调用该服务，或让 `dsh-tool-remote` 工具替你调用。本页服务于两类读者——选择后端的部署方，以及实现或消费该约定的开发者。

### 选择并挂载后端

选择 `dsh-remote-ssh2` 执行 SSH。挂载后端即填充 `ctx.remote`；工具 schema 在各后端间保持相同。未挂载后端的组合没有 `ctx.remote`，工具在注册时失败。

### 服务能做什么

通过 `ctx.remote` 你可以运行一条远程 shell 命令并获得有界输出（`run`），读取远程 UTF-8 文本文件的有界行号窗口（`readText`），原子创建或替换文件（`writeText`），应用一次字面量编辑（`editText`），并经 SFTP 双向流式传输单个文件（`push` / `pull`）。每个操作都接收解析后的连接；失败是带稳定代码（如 `REMOTE_AUTH_FAILED`、`REMOTE_HOST_KEY_MISMATCH`、`REMOTE_NOT_FOUND`、`REMOTE_TOO_LARGE`）的 `RemoteError`，调用方按代码分支，而不是解析消息文本。连接还可携带一个 `proxyJump` 跳板（SSH 跳板/bastion 主机），后端在到达目标前先经其隧道转发；该跳板是带自身 `RemoteAuth` 与主机密钥固定的 `RemoteJumpHost`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计思路

- **每次调用显式连接。** 该接缝不施加连接默认值：工具层在每个操作前把按 analysis 解析的配置（主机、认证、远程根、上限）物化为完全解析的 `RemoteConnection`，因此部署策略停留在配置边界。
- **类型化错误、不透明身份。** 失败携带稳定代码；远程路径基于连接的 `remoteRoot` 解析并拒绝父级越界。
- **取消随请求。** 每个请求可选携带调用方拥有的 `AbortSignal`（工具传入 `exec.signal`）；后端在通道与传输边界观察它。
- **连接上可选的跳板。** 连接可携带一个后端经其隧道转发的 `proxyJump`（SSH bastion）跳板；它独立认证并固定自己的主机密钥，因此每一跳都单独校验。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务定义：抽象 `RemoteExecutor`、`resolveRemotePath`、`ctx.remote` 声明 |
| [`src/types.ts`](src/types.ts) | 词汇：`RemoteConnection`、`RemoteAuth`、请求/结果形状、`RemoteError` 及其代码 |

### 调用的流转

消费方构建解析后的连接，然后调用一个抽象方法。每个文件操作在 provider 触碰远端之前先用 `resolveRemotePath` 将请求路径基于 `remoteRoot` 解析，因此 `..` 越界或兄弟根以 `REMOTE_PERMISSION_DENIED` 快速失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不足时阅读以下页面。它们从接缝表面转到基于它构建的后端与工具。

- [dsh-remote-ssh2](../remote-ssh2/README.zh.md) — 实现本约定的 SSH2 后端。
- [dsh-tool-remote](../tool-remote/README.zh.md) — 消费 `ctx.remote` 的模型可见 `remote_*` 工具。
- [远程 SSH 工具计划](../../../LLMPWA/documentation/ssh-remote-tools-plan.md) — 本接缝为之构建的按 analysis `.dsh` 组合设计。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 `dsh-tool-remote`，后者把远程命令输出、行窗口、变更确认与传输确认为模型渲染。

#### KV 缓存影响

无直接失效；工具包拥有请求前缀变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **单文件传输** — `push`/`pull` 恰好流式传输一个文件；递归目录传输超出范围（当前用 `remote_exec` 配合 `tar`）。
- **无远程列表原语** — `readText`/`writeText`/`editText` 定位单个文件；远程世界的目录发现留给消费方。
- **无交互词汇** — 该接缝把命令运行到完成；交互式终端会话超出范围。

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
