# Agent Note: 工作台跟随主对话会话

Status: implemented

[English](2026-09-11-workbench-follows-main-conversation-session.md) | 中文

## Problem

在主对话区选中某个 session，然后打开 LLMPWA 工作台时，工作台仍显示之前的 analysis 选中项，而不是该 session 所属的 analysis。工作台在打开/关闭之间保留同一个选中项，且从不查看当前对话会话，因此用户打开某个 analysis 的 agent session 后再打开工作台，会看到另一个 analysis 的 DAG。

## Decision

当工作台打开（或在其打开期间当前对话会话变化）时，它会自动选中其 agent session 为当前会话的那个 analysis。映射由工作台加载层的 `analysisForSession` 解析，基于[恢复的 analysis → agent-session 映射](../architecture/2026-09-09-bounded-live-conversation-in-session-slot.zh.md)：

- 首先从恢复的 `agentSessions` 表（analysis 目录 → session id）读取；该表由 face 在每次 analysis 列表时根据不同 analysis 的磁盘 settings 文件与活跃 session 列表重建。
- 否则从活跃 session 列表匹配：将该 session 的 `cwd` 与 analysis 目录按路径后缀（`<workspaceRoot>/LLMPWA/analyses/<analysis>`）匹配。之所以用后缀匹配（而非仅与 `workspacePath` 拼接），是因为 analysis agent session 可能落在未分组这一栏，而不是计入持有 analyses 的工作区。

`cwd` 不是 analysis 目录的 session 无法解析到 analysis，工作台会保留自身选中项。

同一次打开内的手动列表选中优先：工作台记录其最近一次自动选中的 session id（`autoSyncedFor`），在该 session 未变化时不会覆盖用户手动选择的项。关闭面板会清除该标记，因此重新打开时根据（可能不同的）对话会话重新推导。

## Alternatives considered

**按持有 analyses 的工作区匹配 session。** 工作台在文件读取时已优先选择 analyses 工作区所属的 session。但该方式不能解析 analysis，因为 analysis agent session 的 `cwd` 嵌套在工作区根目录之下，而工作区分组不会把嵌套 session 计入父工作区（它们落入未分组这一栏）。因此依赖工作区成员关系恰好对用户所报告的那些 session 无法解析映射。

**仅在全新打开时自动选中，而不在会话变化时处理。** 用户在工作台已打开时切换到某个 analysis agent session，仍会看到过期 analysis。在会话变化时跟随当前会话可保持工作台与对话一致。

## Consequences

在主对话区选中某 analysis 的 agent session 后打开工作台，现在会定位到该 analysis，因此 DAG 与参考文档与对话一致。同一次打开内手动选中会被尊重而不会被还原。工作台组件与加载层保持逐文件 100% 覆盖，组件测试断言了自动选中、仅靠 cwd 匹配以及手动选中/重新打开行为。

## Verification

工作台 spec（`tests/workbench.client.spec.tsx`）固定了跟随行为——切换到当前会话映射的 analysis、仅靠 cwd 匹配切换、保留手动选中、重新打开时重新推导。加载 spec（`tests/load.client.spec.ts`）固定了 `analysisForSession` 的映射路径、cwd 回退、未分组 cwd 后缀以及不匹配场景。
