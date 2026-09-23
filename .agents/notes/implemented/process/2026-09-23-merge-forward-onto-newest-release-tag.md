# Agent Note: Merge feature branches onto the newest release tag

Status: implemented

English | [中文](2026-09-23-merge-forward-onto-newest-release-tag.zh.md)

## Problem

A feature branch based on an earlier release drifts from upstream as that upstream advances. Here `feat/llmpwa-workbench` was based on `dsh-v0.1.6-alpha.2` (`ddefc45fbc`), which predates the 0.1.7 source-launch fix chain. Merging it onto a fixed upstream commit risks landing on a base that lacks later fixes, while merging onto an arbitrary master commit gives no stable, reviewable target.

The concrete failure was the source-launch module-identity split. `@deepseek-ai/dsh-tools` creates `TOOL_RUNTIME_SCHEDULER` with `Symbol()`. A workspace fallback that resolved through a logical symlink declared anchor could select built `lib/` exports, while imports from the resulting real workspace files select `src/` through the tsconfig `paths` map. A Tools instance loaded from `lib/` then cannot expose that scheduler key to a consumer imported from the separate `src/` module instance, surfacing at launch as `Cannot read properties of undefined (reading 'prepare')`.

## Decision

Merge a feature branch forward onto the **newest `dsh-v<version>` release tag**, not onto an arbitrary master commit. In this repository `master` has no version branches; releases are tags only, and the newest tag is the master tip at the release merge commit, so the newest tag and master tip coincide.

Concretely, the target for this merge was `dsh-v0.1.7-alpha.2`, which resolves to commit `00102833df` and is exactly `upstream/master`. After resolving all conflicts, verify the target fix is actually present in the merged tree — here the `packages/boot/app-boot/` resolver and profile files match the release tip with zero diff — and confirm the branch's own commits survive the merge.

The [profile-resolution](../architecture/2026-09-09-profile-resolution-generations.md) decision owns the resolver mechanism that fixes the source-launch identity split; this note records which base to merge onto so that fix is inherited.

## Alternatives considered

**Merge onto an arbitrary master commit.** Any master commit is a valid merge base, but without a named release anchor a reviewer cannot tell which upstream state the branch was reconciled against, and the branch can silently inherit a base missing a just-landed fix.

**Rebase the feature branch onto master.** Rebase discards the completed conflict resolution and validated checkpoint, and rewrites pushed history. The [incremental base-retargeting](../../archived/process/2026-07-26-incremental-pr-base-retargeting.md) decision and the [native-stack decision](2026-08-02-native-github-stacks-and-optional-rebases.md) already permit a lease-protected rebase when intended, but merge-forward is the safe choice after a large conflict-resolving effort.

**Create a long-lived release branch.** Releases here are tags only, so a version branch would introduce a second master and duplicate the release-tag authority already carried by `master`.

## Consequences

A feature branch landing on the newest release tag is guaranteed to carry every fix shipped since its base, and the merge has one reviewable target. The cost is that a branch based on an older release must reconcile a larger upstream diff, and the fix present in the target must be asserted rather than assumed. The release-tag convention keeps `master` tip as the single newest baseline and avoids a parallel version-branch history.
