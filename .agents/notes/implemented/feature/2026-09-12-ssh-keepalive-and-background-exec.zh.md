# Agent Note: SSH keepalive default and remote_exec backgrounding

Status: implemented

[English](2026-09-12-ssh-keepalive-and-background-exec.md) | 中文

## Problem

长时 SSH 会话在空闲连接被防火墙、NAT 或空闲清理服务器拦截时会静默断开：传输层无任何信号即关闭，下一次 `remote_exec` 调用以 `REMOTE_CONNECT_FAILED` 失败。`ssh2` 后端打开每条池化连接时未启用 keepalive，也不读取 `~/.ssh/config`，因此常见的 `Host * / ServerAliveInterval 60 / ServerAliveCountMax 3` 变通方案对 harness 自身的连接无效。用户在连接断开后不得不重建长时远程任务的进程。与此并行，`remote_exec` 把命令运行到完成，仅当远程通道关闭时才返回。想启动长时训练任务而不等待的用户没有工具级开关：要么命令超过 `timeoutMs` 期限，要么 agent 阻塞在对可能耗时数小时完成的等待上。

## Decision

`dsh-remote-ssh2` 默认保持每条连接存活：每次 `client.connect(...)` 传 `keepaliveInterval: 60000` 与 `keepaliveCountMax: 3`，对应 OpenSSH 的 `ServerAliveInterval 60` / `ServerAliveCountMax 3`。这两个值可通过后端 Config 字段 `keepaliveIntervalMs` 与 `keepaliveCountMax` 配置（默认 60000 与 3），`keepaliveIntervalMs: 0` 则对每条连接禁用 keepalive。跳板连接对跳板与目标应用相同 keepalive，因此隧道连接在两跳上都保持存活。

这是全局生效的：无需按主机设置，也不依赖 `~/.ssh/config`，因为这些值随 ssh2 已发送的程序化连接配置生效。后端仍不读取 `~/.ssh/config`；keepalive 默认替代了用户求助于它的常见原因。

`remote_exec` 现在提供 `run_in_background` 参数，用于必须跨越单次调用的任务。当组合了任务注册表（`ctx.jobs`）时，置 `run_in_background: true` 立即返回任务 id；工具在注册表的 starter 内以分离方式启动命令，调用方用 `job_output` 读取增量输出、用 `job_kill` 停止它。无注册表时该参数不可用，工具保持仅前台。后台任务自持有生命周期——无工具 `timeoutMs` 生效——`ctx.jobs` 的取消会编排到远程运行的 `kill`。对于应独立于会话运行的长任务，远程 shell 分离模式（`nohup <cmd> > run.log 2>&1 & echo $!`，随后用 `remote_exec`/`remote_pull` 轮询）仍然可用；keepalive 在这些后续调用间保持池化连接存活。

## Verification

- 后端单元测试断言默认 `connect` 选项携带 `keepaliveInterval: 60000` 与 `keepaliveCountMax: 3`、跳板跳同样携带两者，且显式配置值覆盖默认。
- 完整 `ssh` 组单元套件（ssh、remote-ssh2、tool-remote）通过；无快照变更，因为 keepalive 不是模型可见或用户可见的文字内容。

## Alternatives considered

**在 provider 中读取 `~/.ssh/config`。** 被拒绝：会为程序化配置已表达的行为增加用户可配置文件依赖与平台特定解析，且无需设置。

**让工具缓冲一切并仅在完成时返回。** 被拒绝：会让 agent 阻塞在可能运行数小时的任务上，且无中间输出。在任务注册表后做后台化保留了前台契约（`run` 定局一次），同时给长时命令一个可轮询、可终止的一等 handle——而非强制远程 shell `nohup` 分离使输出难以管理。

**仅在配置时启用 keepalive。** 被拒绝：无法修复默认（免设置）场景，并会让大多数部署重新引入静默断开失败。

## Consequences

- 每条池化连接与跳板跳现在发送 SSH keepalive，并在 3 个包未应答后断开，因此被空闲清理或 NAT 拦截的连接在默认 60 秒空闲复用窗口内无需按主机配置即可保持。
- 位于丢弃 keepalive 的服务器或高延迟链路上的连接，现在可能被 keepalive 计数器终止，而非由服务器自身的空闲清理终止；运维可调 `keepaliveIntervalMs`/`keepaliveCountMax` 或设 `keepaliveIntervalMs: 0` 恢复先前行为。
- `remote_exec` 默认等待完成；组合了任务注册表时还提供 `run_in_background`，因此长任务可分离启动、增量读取并终止。远程 shell `nohup` 分离模式仍可用于必须跨越会话的任务。
