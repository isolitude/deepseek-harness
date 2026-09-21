# Agent Note: LLMPWA 分析 agent 会话归入各自的 analysis workspace

Status: implemented

[English](2026-09-15-llmpwa-analysis-workspace-grouping.md) | 中文

## Problem

LLMPWA 工作台（`ui-llmpwa-pipeline`）用 `sessions.create({ cwd })` 为选中的 analysis 启动 agent 会话，其中 `cwd` 是 analysis 目录（`<workspaceRoot>/LLMPWA/analyses/<analysis>`）。 `dsh-workspace` 只在 Session 的 `cwd` 与 Workspace 记录的 `path` 完全相等时才把该 Session 计入某个 Workspace。本仓库只有仓库根被注册为 Workspace，因此 analysis agent 会话永远不会匹配它：它不被任何 Workspace 收纳，Workspace 浏览器把它显示在 `未分组` 下。这种不匹配也让浏览器分组显得杂乱：每个 analysis 目录变成自己的一小簇 `未分组`，而不是一个命名组。

## Decision

工作台现在把它的 agent 会话归到每个 analysis 各自的 Workspace 下，并把已经在该 analysis 目录运行过的会话迁移进该 Workspace。

1. `listAnalyses` 时，face 调用 `ensureAnalysisWorkspaces`：对每个发现的 analysis 解析 （首次创建）一个覆盖该 analysis 目录的 Workspace 记录，然后把 `cwd` 等于该目录的 活跃 Session 计入其中。Host `create` 动词是幂等的（已注册目录解析到已有记录）， `attachSession` 在 Session 已计入时是空操作，因此该过程在每次列表时都是安全的， 并在删除后被再次创建、自我修复。
2. Agent 启动（`launchAgent`）解析该 analysis 的 Workspace，用 `{ workspaceId }` 而非 `{ cwd }` 创建 Session，因此新的 agent 会话在诞生时就挂到该 analysis 的 Workspace。

新增了一个 Host 侧 `attachSession` Remote 动词（`workspace/attachSession`），使 Client 可以把一个已存在的 Session 计入某个 Workspace。它返回变化后的 Workspace 投影，把 cwd/账目不匹配映射为稳定的 `workspace/attach-failed` RemoteError；意外的 registry 失败按原样传播。

## Alternatives considered

**只在 agent 启动时创建 Workspace，而非列表发现时。** 拒绝：用户必须先打开工作台并 点击动作，组才会出现；但分组应当在地列表一显示时就反映 analysis。发现时创建也让 「迁移已存在未分组会话」能在每次列表时运行一次。

**用路径前缀而非精确匹配来分组。** 拒绝：那需要改动 `dsh-workspace` 的记账不变量 （`cwd === path` 精确相等），把归属放宽到不止一个 Workspace，并有让 Session 加入 错误 project 的风险。为每个 analysis 创建一个真正的 Workspace 保留了既有的精确匹配 不变量和标准分组表面。

**只迁移新会话，把既有未分组会话留在原地。** 拒绝：用户要求两者都做 —— 既有的 analysis 会话也应移入其分组；`attachSession` 正是实现它且不改文件或日志的最小 Host 动作。

## Consequences

- analysis agent 会话现在显示在命名分组（analysis 目录）下，而非 `未分组`；对新建 和既有会话都适用。
- 工作台首次列出某个 analysis 时，该目录会获得一个持久的 Workspace 记录。通过 workspace 删除流程移除该记录后，文件与 Session 保持不变；下次列表会重建分组并把 活跃的匹配 Session 重新计入。
- 工作台的读会话选择会选取「拥有这些 analysis 的项目工作区」——路径是当前会话 cwd 的严格祖先的工作区（回退到与 cwd 精确相等的工作区，再回退到会话最多的项目工作区）， 而非「恰好包含当前会话的工作区」。一旦 analysis agent 会话被归入各自的工作区， 当前会话本身就可能位于其中；如果以「当前会话所在工作区」为准，就会把 `LLMPWA/analyses` 解析到 analysis 目录下而列出为空。保留按 Session 的 `cwd` 匹配以 恢复 analysis 映射的回退，因此无论当前对话会话本身是否为 analysis agent 会话， 面板都能正常工作。
