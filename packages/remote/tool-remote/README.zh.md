---
description: "面向模型的远程 SSH 工具（remote_exec、remote_read、remote_write、remote_edit、remote_push、remote_pull）：供在按 analysis 配置的远程服务器上执行命令与传输文件的 agent 使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-remote

[English](README.md) | 中文

## 概述

`dsh-tool-remote` 为 agent 提供一组远程 SSH 工具——`remote_exec`、`remote_read`、`remote_write`、`remote_edit`、`remote_push` 与 `remote_pull`——在按 analysis 配置的远程服务器上运行命令与传输文件。每个工具解析调用方会话最近的 `.dsh/config.yml`（从会话工作目录向上查找），构建完全显式的连接，并委托给已挂载的 `ctx.remote` 后端。`remote_push` 上传本地文件到服务器（发送脚本），`remote_pull` 把远程文件下载回来（回收实验结果），文件工具有界输出且原子运行。当 analysis 的 agent 既要本地执行世界又要远程执行世界时，把本包与 `dsh-remote-ssh2` 一起选用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先挂载后端再挂载本包：`ctx.remote` 与工具运行时就绪后工具即注册。

```yaml
- name: '@deepseek-ai/dsh-remote-ssh2'
- name: '@deepseek-ai/dsh-tool-remote'
```

### 按 analysis 配置

每个 analysis 的 agent 在 `<analysis>/.dsh/config.yml` 的 `remote:` 块下找到远程服务器：

```yaml
remote:
  host: compute-1
  port: 22
  user: phys
  remoteRoot: /home/phys/workspace
  hostKeyFingerprint: <SHA256 base64 of the server host key>
  timeoutMs: 60000          # optional
  maxTransferBytes: 268435456 # optional
  auth:
    kind: key               # key | password | agent
    keyPath: ./.dsh/secrets/id_ed25519
    # passwordRef: LLPWA_<analysis>_SSH_PASSWORD
```

工具把 `keyPath` 相对 analysis 目录解析；`passwordRef` 命名一个凭据（环境变量或 `dsh-credentials` 存储），其值绝不进入工具参数、结果或会话日志。无 `auth` 块时默认为 `.dsh/secrets/id_ed25519` 的密钥文件。

### 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `remote_exec` | `command`、`workdir?`、`timeout_ms?` | 运行一条远程 shell 命令；返回 `{ exit_code, signal, stdout, stderr, timed_out }` |
| `remote_read` | `path`、`offset?`、`limit?` | 带行号的远程文本窗口、总数与截断真值 |
| `remote_write` | `path`、`content` | 原子创建/替换远程 UTF-8 文本文件 |
| `remote_edit` | `path`、`old_string`、`new_string`、`replace_all?` | 一次字面量替换；除非 `replace_all`，否则要求唯一匹配 |
| `remote_push` | `local_path`、`remote_path`、`overwrite?` | SFTP 上传一个本地文件（发送脚本）；默认拒绝覆盖 |
| `remote_pull` | `remote_path`、`local_path`、`overwrite?` | SFTP 下载一个远程文件（回收结果）；默认拒绝覆盖 |

本地路径相对调用方会话工作区解析；远程路径相对 `remoteRoot` 解析。`..` 越界与远程根越界均被拒绝。

### 插件配置

| 键 | 默认 | 含义 |
|---|---|---|
| `timeoutMs` | `60000` | `remote_exec` 的默认命令期限 |
| `readLimit` | `2000` | 一次 `remote_read` 返回的默认与最大行数 |
| `maxTransferBytes` | `268435456` | `remote_push`/`remote_pull` 的默认传输上限 |
| `workdir` | 配置 `remoteRoot` | `remote_exec` 的默认远程工作目录 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计概念

- **每次调用解析。** 每次执行都从调用方会话最近的 `.dsh/config.yml` 加载连接，因此轮换的凭据与会话特定配置立即生效；注册时不缓存任何东西。
- **凭据留在内部。** 配置加载器在工具边界内物化认证；后端要么收到密钥文件路径，要么收到经 `dsh-credentials` 解析的密码值，要么收到 agent socket。工具参数或渲染结果绝不携带秘密。
- **稳定渲染。** 结果使用熟悉的标记渲染——`[exit code: N]`、`[killed by signal: X]`、`[timed out]`、带行号的读取窗口、`Created file`/`Updated file` 确认、`uploaded N bytes`/`downloaded N bytes`。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、工具接线、正数校验 |
| [`src/config.ts`](src/config.ts) | 按 analysis `.dsh/config.yml` 的发现、解析与认证物化 |
| [`src/connection.ts`](src/connection.ts) | 共享连接加载与缺失配置的显式报错 |
| [`src/exec.ts`](src/exec.ts) | `remote_exec` 执行器与渲染 |
| [`src/files.ts`](src/files.ts) | `remote_read`/`remote_write`/`remote_edit` 执行器与渲染 |
| [`src/transfer.ts`](src/transfer.ts) | `remote_push`/`remote_pull` 执行器与渲染 |

### 失败

缺失配置、畸形配置、未知认证种类或后端失败均呈现为稳定的 `Error: <message>` 结果；后端代码（`REMOTE_*`、`LOCAL_*`）对调用方保持可用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不足时阅读以下页面。

- [dsh-remote](../remote/README.zh.md) — 工具消费的 `ctx.remote` 接缝。
- [dsh-remote-ssh2](../remote-ssh2/README.zh.md) — 执行这些操作的 SSH2 后端。
- [远程 SSH 工具计划](../../../LLMPWA/documentation/ssh-remote-tools-plan.md) — 完整的按 analysis 组合设计，包括凭据存储。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示

#### 模型看到什么

本插件注册范围内的每个请求都收到远程工具指导。作用域工具限制可以隐藏 schema，但不会移除该段。

##### 远程工具指导

```markdown
Use the remote_* tools to execute commands and transfer files on the analysis's remote server: remote_exec runs a shell command, remote_read/write/edit manage remote text files, remote_push uploads a local file (scripts), remote_pull downloads a remote file (results). Paths are relative to the remote workspace root unless absolute; overwrites require explicit overwrite: true.
```

#### Token 影响

插件激活时每个请求小额固定成本。

#### KV 缓存影响

注册作用域与指导文本不变时前缀稳定。

### 工具 schema

#### 模型看到什么

模型看到生成的 `remote_exec`、`remote_read`、`remote_write`、`remote_edit`、`remote_push`、`remote_pull` schema，参数为 snake_case；[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-remote) 列出精确 schema。

#### Token 影响

工具可见的每个请求上固定 schema 成本。

#### KV 缓存影响

可见工具定义与顺序不变时前缀稳定。

### 命令结果

#### 模型看到什么

`remote_exec` 渲染 stdout、存在时的 `[stderr]` 段、可选 `[timed out]`/`[killed by signal: X]` 标记，以及末尾 `[exit code: N]` 行；未知退出渲染 `[exit status unknown]`。

#### Token 影响

调用前零结果 token；输出按流有界并保留到压缩。

#### KV 缓存影响

追加式；输出跟随可复用请求前缀。

### 文件与传输结果

#### 模型看到什么

`remote_read` 渲染带分页页脚的编号行；`remote_write` 渲染 `Created file` 或 `Updated file`；`remote_edit` 渲染替换次数；传输渲染 `uploaded N bytes to <path>` / `downloaded N bytes from <path>`。

#### Token 影响

小额保留确认；变更参数保留在历史中直到压缩。

#### KV 缓存影响

追加式；结果跟随可复用请求前缀。

## 已知限制与延期工作

- **单文件传输** — `remote_push`/`remote_pull` 每次调用处理一个文件；目录传输用 `remote_exec` 配合 `tar`。
- **仅配置驱动的主机** — 远程主机来自 analysis `.dsh/config.yml`；没有逐调用主机覆盖（有意策略默认）。
- **无清点工具** — 列出远程目录留给 `remote_exec`；接缝与工具定位单个文件。

## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
