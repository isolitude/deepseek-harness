---
description: "SSH2 远程执行后端：面向选择 SSH 支撑的远程命令与文件传输的部署方，以及远程接缝的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-ssh2

[English](README.md) | 中文

## 概述

`dsh-remote-ssh2` 通过 SSH 实现 `ctx.remote`：每个连接身份一个活跃 SSH 客户端，在配置不变时跨调用复用，空闲超时或显式 `dispose()` 时关闭。它运行远程 `bash` 命令（有界收集输出）并通过 SFTP 流式传输单个文件。主机密钥按期望的 SHA256 指纹校验——未固定指纹的连接会被拒绝，而不是按信任首次使用接受。把它与 `dsh-tool-remote` 一起挂载；二者共同为 agent 提供按 analysis 配置的远程执行与文件传输。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当远程命令执行与文件传输应运行在可经 SSH 到达的服务器上时使用本包。它是远程接缝的后端半边：挂载它注册 `ctx.remote`；`remote_*` 工具随后根据各 analysis 的 `.dsh/config.yml` 自行配置。

### 挂载

```yaml
- name: '@deepseek-ai/dsh-remote-ssh2'
- name: '@deepseek-ai/dsh-tool-remote'
```

### 后端配置

所有键均可选；默认值适合交互使用。

| 键 | 默认 | 含义 |
|---|---|---|
| `idleTimeoutMs` | `60000` | 空闲该毫秒数后关闭池化连接 |
| `connectTimeoutMs` | `15000` | 建连期限 |
| `keepaliveIntervalMs` | `60000` | 每该毫秒数发送一个 SSH keepalive 包；`0` 禁用 |
| `keepaliveCountMax` | `3` | 连续该次数未应答 keepalive 后断开连接 |
| `maxOutputBytes` | `262144` | 单条命令收集输出的每流上限 |
| `maxReadBytes` | `16777216` | 单次文本读/写/编辑载荷上限 |

keepalive 默认开启：每条连接每 `keepaliveIntervalMs` 发送一个 SSH 级 keepalive 包，并在连续 `keepaliveCountMax` 个包未应答后断开。这是全局生效的，因此长时会话无需按主机设置即可保持稳定，对应 OpenSSH 的 `ServerAliveInterval` / `ServerAliveCountMax`。设 `keepaliveIntervalMs: 0` 可对每条连接禁用 keepalive。

按连接值（主机、端口、用户、认证、远程根、传输上限、指纹）来自 `dsh-tool-remote` 解析的按 analysis 配置；它们都不属于此处。

### 认证

工具层在连接上物化三种形式之一：私钥文件（`key`）、密码（`password`）或本地 ssh-agent（`agent`，经 `SSH_AUTH_SOCK`）。后端从不看到凭据名称，也从不把秘密放入工具参数或结果。

### 主机密钥策略

默认严格：连接必须携带期望的远程主机密钥 SHA256 指纹（analysis 配置中的 `hostKeyFingerprint`）。一次性带外收集（`ssh-keyscan` 或首次手动 `ssh` 会话）并固定；不匹配以 `REMOTE_HOST_KEY_MISMATCH` 失败，且不交换任何流量。当 analysis 配置命名了 `proxyJump` 跳板时，该跳板携带自己的 `hostKeyFingerprint`，并在打开任何隧道前与目标的指纹分开校验。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计思路

- **每身份一个池化客户端。** 连接按序列化身份（analysis id、主机、端口、用户、认证种类/密钥路径，以及存在时的跳板主机）为键；存活时复用，空闲超时、显式 `dispose()` 与上下文拆除时关闭。底层关闭的 socket 会被检测并在下次调用重建。经 `proxyJump` 跳板路由的连接会持有两个客户端，并在拆除时连同目标一起关闭跳板（销毁转发流、结束该跳）。
- **原子远程写。** 文本写与推送文件先落临时同件，再经 SFTP `rename` 发布，因此失败的传输不会留下半成品文件。
- **处处有界。** 命令输出、文本载荷与传输都遵守上限；溢出以 `REMOTE_TOO_LARGE` 失败，而不是静默截断。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Ssh2RemoteExecutor`、`Config`、连接池、命令运行、SFTP 文本操作、push/pull |

### 命令运行

`run` 经通道启动 `bash -s`，流式读取有界 stdout/stderr，并报告远程退出码、击杀信号与超时真值。非零退出是结果而非失败。

### 传输

`push`/`pull` 经 SFTP 流式传输一个文件并带有字节上限，默认拒绝覆盖（`overwrite` 显式开启），并经由目标侧临时文件 + 重命名原子发布。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不足时阅读以下页面。

- [dsh-remote](../remote/README.zh.md) — 本后端实现的 `ctx.remote` 接缝。
- [dsh-tool-remote](../tool-remote/README.zh.md) — 解析按 analysis 配置的模型可见工具。
- [子进程子系统](../../../docs/subsystems/subprocess.zh.md) — 同级的本地执行接缝。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 `dsh-tool-remote`，后者把远程命令输出、行窗口、变更确认与传输确认为模型渲染。

#### KV 缓存影响

无直接失效；工具包拥有请求前缀变更。

## 已知限制与延期工作

- **无递归传输** — `push`/`pull` 恰好处理一个文件；目录请用 `remote_exec` 配合 `tar`。
- **SFTP 级原子性** — 远程发布依赖服务器在相同目录内原子地执行 `rename`；跨文件系统重命名取决于服务器。
- **无交互式 PTY** — 命令运行到完成；交互式提示需要终端后端，此处超范围。

## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
