# Agent Note: LLMPWA 工作台参考渲染优化

Status: implemented

[English](2026-09-14-llmpwa-reference-rendering.md) | 中文

## Problem

LLMPWA 工作台的参考预览存在三处渲染缺口，影响 analysis 自身文档的呈现。位于文件旁的 markdown 报告图片（`![alt](fig4_whitened.png)`）渲染为空 `alt` 而非图片，因为 GFM 渲染器没有相对路径的解析器。HTML 报告（matplotlib 导出）为该面板提供固定白色画布，在深色模式下保持明亮，与周围工作台格格不入。而预览面板保留了比内容所需更多的内边距与更宽的任务树，挤压了报告实际获得的区域。

## Decision

`ReferenceDocument` 渲染器现在基于工作区解析相对 markdown 图片，并为当前配色主题化 HTML 文档，同时工作台布局为预览腾出更多空间。

- `buildPathImages(workspacePath, filePath)` 构建 `MarkdownPathImages` 解析器——即本地媒体展示说明（`2026-09-07-session-prose-local-media-display`）所拥有的渲染词汇——复用认证文件系统读取（`2026-09-08-file-display-through-filesystem` 说明）所拥有的同源 `/api/file?path=<encoded>` 提供通道（与 `ui-chat` 的 `localPathMediaUrl` 相同）。相对目标与文件自身目录及工作区根拼接；绝对访客路径（`/…`）原样通过，远程与 `data:` 目标按渲染器自身协议检查通过，非 HTTP(S) 页面或缺少 `workspacePath` 时不解析任何内容，因此图片保持为惰性 `alt` 而非一个失败的请求。仅通过 `http:`/`https:` 提供的页面才解析本地文件。
- `themedHtml(text)` 以 `color-scheme` meta 与一小段样式块包裹或修补 HTML 报告，使 iframe 的画布遵循环境明暗配色，而非固定白色。完整文档在其 `<head>` 之后插入基线；片段被包裹进最小化的 `<!doctype html>`。报告自身的（更晚的、内联的）样式仍对图形生效，因此这仅让面板融合。深色模式下页面文本以 `!important` 强制，因为硬编码深色内联 `body` 颜色的报告会否则压过配色规则，使其文本在深色画布上不可读。
- 预览面板变宽：`.refBody` 与 `.preview` 去掉侧边内边距，HTML iframe 铺满面板边缘到边缘，任务树面板收窄到 280px，使文档预览获得腾出的列。底部任务弹窗打开时更高（400px），其拖拽手柄可向上拉到行的全高（90px 卡片地面保留使任务网格仍可见；`max-height: 100%` 使其保持在预览行内）。`.taskPreviewPane` 为纵向 flex 容器，使参考体及其 iframe 解析出真实高度，HTML 文档随弹窗大小变化而重排。工作台各样式表中的中性 token 边框为发丝线（`0.5px`），符合 `ui-theme` 的 elevation 契约。

## Alternatives considered

**将每个被引用图片编码为内联 `data:` URL。** 拒绝：它会把每个图形读入客户端并重建报告，而非让浏览器只请求用户查看的那些图片，且文本阅读器在加载边界已拒绝非文本字节。

**通过帧中的 `blob:` URL 提供解析后的图片。** 拒绝：iframe 是不透明源，父页面中创建的 `blob:` 无法从文档内部访问；同源的 `/api/file` 请求才是从工作区自身权限出发可用的通道。

**从工作台的实时主题 token 拉取深色基线到 iframe CSS。** 拒绝：iframe 是跨源（不透明）文档，无法访问父级已计算样式；可移植的 `@media (prefers-color-scheme: dark)` 覆盖是唯一可靠的自包含信号，报告的图形保持不变。

## Consequences

- 相对图片解析需要从工作台向渲染器传入 `workspacePath`；缺少它（或非 HTTP(S) 页面）时解析器缺失，图片退化为 `alt` 文本——安全回退，而非报错。
- 图形为外部文件（而非内联 `data:` URI）的 HTML 报告仍无法加载它们，因为不透明源、带沙箱的 iframe 无法触达父源 `/api/file` 端点；自包含报告仍是完整渲染的情形，并被记录为限制。
- iframe 保留 `sandbox="allow-scripts"` 与 `data-html-preview` 钩子，因此它与应用源保持隔离，并在新文档时干净地重挂载。
- iframe 内报告的自身样式对图形生效；注入的基线仅设置面板画布，使其与周围工作台融合。深色模式下页面文本以 `!important` 强制，因此报告硬编码的内联 body 颜色无法在深色画布上留下不可读的深色文本。
- 该包的客户端 `src/` 保持逐文件 100% 覆盖率；新分支由 reference-document spec 固定（相对与绝对图片解析、惰性目标、无解析器情形，以及完整文档与片段两条 HTML 主题路径）。
