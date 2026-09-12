# 远程 SSH 执行

[English](remote.md) | 中文

可选远程执行能力分为三部分：[dsh-remote](../../packages/remote/remote) 拥有 `ctx.remote` 与完全显式的按调用连接词汇，[dsh-remote-ssh2](../../packages/remote/remote-ssh2) 通过 SSH2 实现它（连接池、严格主机密钥校验、SFTP 传输），[dsh-tool-remote](../../packages/remote/tool-remote) 执行模型可见的 `remote_exec`/`remote_read`/`remote_write`/`remote_edit`/`remote_push`/`remote_pull` 调用，并解析每个 analysis 的 `.dsh/config.yml`。它位于本地执行世界之侧：本地 `bash`/`read`/`write`/`edit` 工具保持默认，`remote_*` 工具面向该 analysis 配置的服务器。

每个操作接受一个由消费方构建的完全解析 `RemoteConnection`，因此该接缝不施加连接默认值，也从不看到凭据名称。凭据（密钥文件、经由 `dsh-credentials` 的密码引用或 ssh-agent socket）在工具层内部物化，绝不进入工具参数、结果或会话日志。

Provider 源码：[`packages/remote/remote/src/types.ts`](../../packages/remote/remote/src/types.ts) 与 [`packages/remote/remote/src/index.ts`](../../packages/remote/remote/src/index.ts)。SSH2 provider 源码：[`packages/remote/remote-ssh2/src/index.ts`](../../packages/remote/remote-ssh2/src/index.ts)。工具源码：[`packages/remote/tool-remote/src/index.ts`](../../packages/remote/tool-remote/src/index.ts)。

## 连接与认证（消费方约定）

工具层根据 analysis 配置为每次调用构建一个 `RemoteConnection`：主机、端口、用户、远程根、上限、期望的主机密钥指纹，以及一种物化的认证形式（`key` 路径、`password` 值或 `agent`）。相对远程路径基于 `remoteRoot` 解析，并经 `resolveRemotePath` 拒绝 `..` 越界。主机密钥校验是严格的：未固定指纹的连接会被拒绝，绝不按信任首次使用接受。

```ts type-equiv
/**
 * How this connection authenticates. Exactly one materialized form — the tool layer
 * resolves configuration references (key files, credential refs) into these values, so
 * the provider never sees a credential name and no secret enters a tool argument.
 */
type RemoteAuth =
  /** SSH private key on the local host; the provider reads the file. */
  | { readonly kind: 'key'; readonly keyPath: string; readonly passphrase?: string }
  /** Materialized password. */
  | { readonly kind: 'password'; readonly password: string }
  /** Forward the local ssh-agent (`SSH_AUTH_SOCK`) when a socket is present. */
  | { readonly kind: 'agent' }
```

```ts type-equiv
/**
 * One fully-resolved remote connection for a single call. Built by the tool layer from
 * the per-analysis `.dsh/config.yml`; identity fields are immutable per call.
 */
interface RemoteConnection {
  /** Stable per-analysis handle the provider keys its connection cache on. */
  readonly id: string
  /** Remote host name or address. */
  readonly host: string
  /** Remote port. Defaults to 22 at the tool boundary. */
  readonly port: number
  /** Remote user. */
  readonly user: string
  /** Materialized authentication for this connection. */
  readonly auth: RemoteAuth
  /** Absolute remote directory relative paths resolve against; `..` escape is rejected. */
  readonly remoteRoot: string
  /** Connection-establishment deadline in milliseconds. */
  readonly connectTimeoutMs: number
  /** Positive finite byte cap for one transfer; exceeding it fails with `REMOTE_TOO_LARGE`. */
  readonly maxTransferBytes: number
  /** Expected host-key SHA256 fingerprint (base64, no prefix); absent = strict default refuses. */
  readonly hostKeyFingerprint?: string
  /**
   * Optional SSH jump (bastion) host the provider tunnels through before connecting to
   * the target; each hop verifies its own host key and authenticates independently.
   */
  readonly proxyJump?: RemoteJumpHost
}
```

## 操作与结果

| 操作 | 请求 | 结果 | 上限 |
|---|---|---|---|
| `run` | 命令 + cwd + 期限 | 退出码、信号、有界 stdout/stderr、超时真值 | 每流输出上限 |
| `readText` | 路径 + 1 基偏移 + 行数上限 | 行窗口、总行数、截断真值 | 载荷上限 |
| `writeText` | 路径 + 完整内容 | 路径 + 创建标志 | 载荷上限 |
| `editText` | 路径 + 新旧字面量 + 全部替换 | 路径 + 替换次数 | 载荷上限 |
| `push` | 本地路径 + 远程路径 + 覆盖 | 双方路径 + 字节数 | 传输上限 |
| `pull` | 远程路径 + 本地路径 + 覆盖 | 双方路径 + 字节数 | 传输上限 |

非零退出是结果而非失败。变更与传输原子发布：provider 先写临时同件，再经 OpenSSH `posix-rename@openssh.com` 扩展替换目标（若可用），否则回退到受防护的 `unlink` + `rename` 组合。传输默认拒绝覆盖（`overwrite` 显式开启）。取消随每个请求的可选 `AbortSignal`（工具传入 `exec.signal`）。

失败是带稳定代码的 `RemoteError`：`REMOTE_CONNECT_FAILED`、`REMOTE_AUTH_FAILED`、`REMOTE_HOST_KEY_MISMATCH`、`REMOTE_TIMEOUT`、`REMOTE_ABORTED`、`REMOTE_NOT_FOUND`、`REMOTE_PERMISSION_DENIED`、`REMOTE_IO_ERROR`、`REMOTE_TOO_LARGE`、`REMOTE_NOT_TEXT`、`REMOTE_AMBIGUOUS_EDIT`、`REMOTE_ALREADY_EXISTS`、`LOCAL_NOT_FOUND`、`LOCAL_PERMISSION_DENIED`、`LOCAL_ALREADY_EXISTS`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<!-- END GENERATED cordis-surface -->
