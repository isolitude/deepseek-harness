---
description: "远程执行能力家族：面向选择与组合远程 SSH 命令执行、文件传输与模型可见 remote_* 工具的部署方与维护者。"
kind: "package-group"
---

# remote/ — 远程执行能力家族

[English](README.md) | 中文

## 概述

ssh 组为 agent 提供经 SSH 的远程命令执行与文件传输，同时不触碰本地执行世界：一个接缝定义约定，一个后端经 SSH2 执行它，一个工具包把六个 `remote_*` 工具暴露给模型。每个 analysis 在 `.dsh/config.yml` 下自行配置远程服务器，因此不同 analysis 可在不同硬件上执行而不改工具或后端代码。凭据（密钥文件、密码）在工具层内部解析，绝不触及模型或会话日志。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`remote`](remote/README.zh.md) | 定义远程执行约定：按调用解析的连接、run/read/text/transfer 原语、类型化错误 | `ctx.remote` |
| [`remote-ssh2`](remote-ssh2/README.zh.md) | 经 SSH2 执行该接缝：池化连接、严格主机密钥校验、SFTP 传输 | 注册 `ctx.remote` |
| [`tool-remote`](tool-remote/README.zh.md) | 把远程执行与传输暴露给模型：`remote_exec`/`remote_read`/`remote_write`/`remote_edit`/`remote_push`/`remote_pull` | 注册于 `ctx.tools` |

组合挂载一个后端（当前为 `dsh-remote-ssh2`）与工具包；工具随后在每次执行时解析各 analysis 的 `.dsh/config.yml`。按 analysis 的 `remote:` 配置还支持可选的 `proxyJump:` 块，命名一个 SSH 跳板（bastion）主机，使仅能经该跳板到达的目标经其转发（`ssh -J` 语义），且每一跳都固定到各自的主机密钥。

-----

<a id="related-documentation"></a>
## 相关文档

- [远程 SSH 工具计划](../../LLMPWA/documentation/ssh-remote-tools-plan.md) — 本家族实现的按 analysis 组合设计、决策点与凭据存储指南。
- [文件系统子系统](../../docs/subsystems/filesystem.zh.md) — 远程文件工具所补充的本地文件系统接缝。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
