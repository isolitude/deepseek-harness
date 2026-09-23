# Agent Note: 将功能分支合并到最新的 release tag

Status: implemented

[English](2026-09-23-merge-forward-onto-newest-release-tag.md) | 中文

## Problem

基于较早 release 的功能分支会随着上游推进而偏离。这里 `feat/llmpwa-workbench` 基于 `dsh-v0.1.6-alpha.2` tag，它早于 0.1.7 的源码启动修复链。把它合并到某个固定的上游 commit 有落在缺乏后续修复的 base 上的风险；合并到任意 master commit 则没有稳定、可评审的目标。

具体故障是源码启动的模块身份分裂。`@deepseek-ai/dsh-tools` 用 `Symbol()` 创建 `TOOL_RUNTIME_SCHEDULER`。通过逻辑符号链接声明锚点解析的 workspace 回退可能选中构建出来的 `lib/` 导出，而从最终真实 workspace 文件发起的导入则经 tsconfig `paths` 映射选中 `src/`。此时从 `lib/` 加载的 Tools 实例无法把该调度器键暴露给从独立 `src/` 模块实例导入的消费者，启动时表现为 `Cannot read properties of undefined (reading 'prepare')`。

## Decision

把功能分支前向合并到**最新的 `dsh-v<version>` release tag**，而不是任意 master commit。本仓库的 `master` 没有版本分支；release 只有 tag，且最新的 tag 就是 release 合并提交处的 master 尖端，因此最新 tag 与 master 尖端重合。

具体来说，本次合并的目标是 `dsh-v0.1.7-alpha.2` tag，正好等于 `upstream/master`。解决全部冲突后，要验证目标修复确实存在于合并后的树中——这里 `packages/boot/app-boot/` 的 resolver 与 profile 文件与 release 尖端零差异一致——并确认分支自身的 commit 在合并后得以保留。

[profile-resolution](../architecture/2026-09-09-profile-resolution-generations.zh.md) 决策拥有修复源码启动身份分裂的 resolver 机制；本 note 记录应合并到哪个 base 以使该修复被继承。

## Alternatives considered

**合并到任意 master commit。** 任意 master commit 都是合法合并 base，但缺少具名的 release 锚点时，评审者无法判断该分支是对照哪个上游状态调和而成，分支还可能静默继承一个缺少刚落地修复的 base。

**把功能分支 rebase 到 master。** Rebase 会丢弃已完成的冲突解决与已校验的检查点，并改写已推送的历史。[增量更新 base 的决策](../../archived/process/2026-07-26-incremental-pr-base-retargeting.md)和[原生堆叠决策](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)在需要时已经允许受 lease 保护的 rebase，但在大量冲突解决之后，merge-forward 才是安全选择。

**创建长期存在的 release 分支。** 这里的 release 只有 tag，因此版本分支会引入第二个 master，并重复 `master` 已承载的 release-tag 权威。

## Consequences

落在最新 release tag 上的功能分支必然携带自其 base 以来发布的每一项修复，且合并拥有单一可评审目标。代价是：基于较早 release 的分支必须调和更大的上游差异，并且必须断言而非假设目标中确实存在该修复。release-tag 约定让 `master` 尖端保持唯一的最新 base，避免并行的版本分支历史。
