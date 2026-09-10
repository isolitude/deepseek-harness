# Agent Note: 会话插槽内嵌的有界实时对话

Status: implemented

[English](2026-09-09-bounded-live-conversation-in-session-slot.md) | 中文

## Problem

LLMPWA 工作台（workbench）按分析（analysis）打开一个 Agent 会话，并需要在随之打开的抽屉（drawer）内开始对话。现有 `ChatView` 绑定到当前会话，并声明 `conversation.chat.node` keyed 插槽与唯一的 `conversation.message.images` 插槽。在抽屉中挂载它会重复声明这些插槽，也不符合宿主（host）的消费方式，因此完整、忠实地在抽屉中复用 `ChatView` 将分叉约十个包。

## Decision

新增一个 `single`、范围为 `session` 的插槽 `conversation.embedded`，承载有界（bounded）的文本对话：

- `ui-conversation` 在其 `SlotMap` 中声明 `conversation.embedded`。
- `ui-chat` 向该插槽注册一个组件，并为注入面（inject face）赋予类型，使声明方可以从会话的 Chat 源读取任意节点键。`inject(sessionId)` 解析会话绑定，暴露 `keyedHooks.chatNode(key)`，使对话记录保持实时。
- 该组件渲染一个单纯的、可滚动的用户/助手文本记录（不包含工具调用卡片、markdown 或图片），以及绑定到共享输入机（Input machine）的输入框。发送由会话 `running` 标志把关；Enter 提交，Shift+Enter 插入换行。当绑定会话存在 cwd 时显示该 cwd。

因为该插槽范围为 `session`，且对话绑定到当前会话，所以在抽屉打开一个 Agent 后绑定到的内嵌对话即绑定到刚打开的 Agent 会话。工作台（一个 `root` 声明方）将 `conversation.embedded` 声明为子插槽，并在抽屉的当前会话已定义时渲染它；当没有当前会话时不渲染，因为作用域绑定是严格的（strict）。

工作台还会记录每个分析的 Agent 会话 id，并按分析渲染运行状态标志，该标志从会话列表的 `running` 状态读取。Agent 抽屉支持水平拖拽调整宽度：主预览与抽屉之间有一条可拖拽的分隔条，它调整抽屉宽度，受最小值以及预览行宽度减去预览下限的约束，宽度保存在工作台 store 中，因此跨开关边保持稳定。

内嵌记录只显示助手正文块（`kind: 'text'`），不显示其思考块，因此抽屉呈现答案而非推理过程。

Agent 面板是右侧贴边的浮动覆盖层，而非弹性子项，因此不会导致其后的 DAG 重排或重新缩放。点击其后的页面会把面板折叠为窄标题条（贴右边缘）；点击该标题条或面板自身的标题栏会恢复完整面板。每个分析保留一个活跃 Agent 会话：再次调用 `openAgent` 时，若记录的会话 id 仍存在于会话列表，则复用它；面板标题栏提供「新建会话」操作，始终为该分析启动一个全新会话（清空之前的上下文）。

「分析 → Agent 会话」映射是持久化的。工作台会以两种方式恢复它，两者都由 face 的分析列表驱动：读取每个分析的磁盘设置文件；以及扫描活动会话列表，找出 `cwd` 等于该分析目录的会话（会话创建时 `cwd` 设为分析目录，且 dsh 会话会持久化该 `cwd`），并优先采用最近更新的一条。会话列表扫描是权威来源，可在页面刷新或服务端重启后恢复映射，即使设置文件尚未写入也如此；文件则作为长期载体。每个分析带有 `LLMPWA/analyses/<analysis>/.dsh/agent.json`，内容为 `{ agentSessionId }`，工作台在启动或复用 Agent 会话时写入它。Host 的 `workspaceFiles` 服务暴露了一个受限、限定于工作区内的 `write` 方法（此前客户端 remote 只读）：它会在工作区根目录下解析并校验路径，创建缺失的父目录，并以会话的 sandbox 策略（默认模式 `workspace-write`）保护原子写入，同时把只读会话的拒绝映射为结构化的 `workspace-file/write-denied` 错误。原先的 `dsh.llmpwa.agent-sessions` `localStorage` 持久化已移除。

「参考文档」标签页会把每个文件渲染为真正的文档，而非原始 pre 块。Markdown 文件通过共享的 `MarkdownText` GFM 渲染器渲染（继承其 shiki 高亮的代码围栏、数学与脚注）；其他文件类型通过共享的 `CodeBlock` 高亮器渲染为语法高亮的代码块，未知语言则回退为纯 pre。两者都来自共享的 `ui-primitives` 基准外部化。文档区域没有填充背景卡片，并延伸至面板底部，内部滚动，因此长参考可跨整块阅读，而不是被限制在带边框的框内。

## Alternatives considered

**在抽屉中复用 `ChatView`。** 这是完整的产品对话。它并非为二次挂载而设计，且声明独占的子插槽，因此忠实复用会分叉许多包。

**在抽屉中实时多 Agent 总览。** 本次改动不采用；只需按分析显示运行/空闲标志。

**将内嵌插槽声明为 `root` 范围。** `root` 声明方可以声明 `session` 子插槽，因此工作台保留自己的子插槽声明；该插槽经由标准会话作用域提供者解析。

## Consequences

抽屉获得针对已打开 Agent 会话的有界、实时文本对话，而无需分叉 `ChatView`。工具调用详情、图片与 markdown 仍保留在完整的产品对话中，而非抽屉。运行标志取代了实时总览，使工作台保持精简。测试固定了有界行、输入框把关以及按节点的实时源。

## Verification

插槽约定、内嵌组件与工作台接线均达到逐文件 100% 覆盖率。工作台规格断言：仅当存在当前会话时才请求该插槽；仅当某分析的 Agent 会话正在运行时，该分析才显示其运行标志。
