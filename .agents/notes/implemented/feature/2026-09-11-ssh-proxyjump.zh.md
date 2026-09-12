# Agent Note: SSH 远程工具经 ProxyJump 主机隧道转发

Status: implemented

[English](2026-09-11-ssh-proxyjump.md) | 中文

## 问题

SSH 远程执行家族（`dsh-remote` 接缝、`dsh-remote-ssh2` 后端、`dsh-tool-remote` 工具）直接连接目标主机。在许多部署中，目标仅能经 bastion 或跳板主机到达：目标可能位于 NAT 之后、私网子网内，或防火墙仅允许入口到达一个跳板机——这正是 OpenSSH `ProxyJump`（`-J`）解决的场景。

缺乏支持时，仅能经跳板到达其计算服务器的 analysis 便无法配置 `remote:` 块——工具在该拓扑下不可用。接缝（`RemoteConnection`）本就使连接输入完全显式，但没有中间跳板的概念，因此该特性必须贯穿类型、配置加载器与后端。

## 决策

analysis 的 `.dsh/config.yml` 可以在 `remote:` 内声明可选的 `proxyJump:` 块。该块命名单个 SSH 跳板（bastion）主机，并拥有自己的认证与主机密钥固定，镜像 `ssh -J`：

```yaml
remote:
  host: compute-1
  user: phys
  remoteRoot: /home/phys/workspace
  hostKeyFingerprint: <target host key fingerprint>
  proxyJump:
    host: bastion
    port: 22
    user: deploy
    hostKeyFingerprint: <jump host key fingerprint>
    auth:
      kind: key
      keyPath: ./.dsh/secrets/id_ed25519
```

后端经跳板隧道转发目标连接：它连接并认证到跳板，经 `client.forwardOut(...)` 请求一条通向目标的 `direct-tcpip` 转发，然后用 `{ sock: <forward stream> }` 连接目标客户端（ssh2 的连接跳转路径）。每一跳都固定到自己的 `hostKeyFingerprint` 并独立校验——未固定的跳板与未固定的目标一样被拒绝，任何地方都没有信任首次使用。

连接池的键与拆除都包含该跳。仅在跳板上不同的两个连接绝不共享池化客户端；当池化的一对被释放、空闲清扫或拆除时，先关闭隧道（销毁转发流），再结束跳板客户端。

## 验证

- tool-remote 配置加载器单元测试物化 `proxyJump` 块，将其 `port` 默认到 22、其认证默认到 analysis 密钥文件，并拒绝缺失 `host`/`user` 或非对象 `proxyJump` 的块。
- tool-remote 工具测试断言含 `proxyJump` 的配置在每个委托连接上呈现该跳板。
- 后端单元测试（可编程的假 ssh2 Client）断言针对目标调用了 `forwardOut`、目标经跳板流连接、两跳都运行各自的主机密钥校验器、池键包含跳板身份，且跳板转发或经跳板的目标连接失败呈现为 `REMOTE_CONNECT_FAILED`；拆除会释放跳板流与客户端。
- 修改后的源文件在 `pnpm run test:coverage` 下达到逐文件 100% 语句/分支/函数/行。
- 无需修改 recorded-session snapshot，因为 `proxyJump` 仅属配置：工具名、参数、schema 与系统提示文本均不变，凭据或跳板值也不进入工具参数、结果或会话日志。

## 考虑过的替代方案

| 已否决 | 原因 |
|---|---|
| 紧凑的 `user@host[:port]` 跳板字符串 | 丢失逐跳认证与主机密钥固定；经跳板的目标通常需要不同的密钥及其自身的主机密钥校验 |
| 为跳板复用目标的认证 | 跳板机通常用独立的密钥认证；折叠两者会掩盖真实的凭据边界 |
| 仅在目标应用 `hostKeyFingerprint` | 使跳板保持未固定，这是 ProxyJump 可能引入的最严重安全漏洞 |
| 仅记录该特性 | 没有代码支持该拓扑不可用；仅靠文档无法让工具在 bastion 之后工作 |

## 后果

- 接缝导出一个 `RemoteJumpHost` 类型，`RemoteConnection.proxyJump` 是可选的，因此现有直连不变且向后兼容。
- 后端为每个经跳板路由的池化连接打开第二个 SSH 会话；跳板会引入连接延迟，并在池化生命周期内持有两个客户端。
- 跳板与目标一样经 `dsh-credentials` 路径认证，因此针对跳板的 `passwordRef`/`passphraseRef` 在不进入工具参数或结果的情况下解析。
- 一跳被严格固定（缺 `hostKeyFingerprint` 则拒绝），与该家族无信任首次使用的主机密钥策略一致。
