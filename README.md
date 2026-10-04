# @1agents/file-system-mcp

0.2.0 增加官方 Fetch、Git、Memory、Sequential Thinking 和 Time 的 DreamMate 适配与常驻服务入口，详见 [基础 MCP 能力说明](BASE_MCP.md)。文件系统命令与服务 ID 保持兼容。

将官方文件系统 MCP 轻量接入 dreammate-node 能力网络。其他项目或设备的智能体可通过已有的 DreamMate 工具发现服务、查看契约并操作开放目录里的文件。

文件操作与路径验证复用 `@modelcontextprotocol/server-filesystem@2026.8.31`，不复制上游源码。封装采用 Node.js 原生 HTTP 和 MCP SDK，没有 Web 框架、数据库、Docker 或 native addon。HTTP 服务复用一个上游 MCP 子进程。

## 运行与发布到能力网络

需要 Node.js >=22.5，以及已运行的 dreammate-node 网关（默认 36908）。

从 npm 安装到固定的用户目录（服务安装器会记录包入口的绝对路径）：

```sh
npm install --prefix ~/.local/share/file-system-mcp @1agents/file-system-mcp
~/.local/share/file-system-mcp/node_modules/.bin/file-system-mcp install --root /absolute/project
```

Fetch、Git、Time 还需要 Python 环境；运行安装目录内的 `scripts/setup-python.mjs`，再使用 `base-mcp install`。完整命令见 [BASE_MCP.md](BASE_MCP.md)。

```sh
npm ci --ignore-scripts
node bin/file-system-mcp.mjs serve --root /absolute/project

# 多目录 / 只读
node bin/file-system-mcp.mjs serve --root /project-a --root /project-b --read-only

# macOS launchd / Linux systemd user：登录自启，异常退出自动恢复
node bin/file-system-mcp.mjs install --root /absolute/project
node bin/file-system-mcp.mjs status
node bin/file-system-mcp.mjs uninstall
```

`install` 记录当前 Node 和入口脚本的绝对路径；移动源码、更新 Node 路径或更改开放目录后重新执行 install。Linux 默认在用户登出后停止，长期常驻需由用户配置 linger。Windows 可运行 `serve`，用现有服务管理器常驻。

服务仅监听 `127.0.0.1:7784`，启动后向本机 dreammate-node 自动报备；远程访问经目标节点的网关转发。服务默认 ID 为 `filesystem`，可用 `--id` 区分同机多个实例（每个实例使用不同 `--port`）。报备失败不影响本地服务，每 30 秒重新报备，网关重启后也可恢复。

必须显式提供至少一个已存在的开放目录。可重复 `--root`，或设置 `FILESYSTEM_ALLOWED_DIRS='["/absolute/project-a","/absolute/project-b"]'`；命令行 roots 优先。`--agent` 指定本机 HTTP 网关，`--no-report` 跳过报备。服务不向上游声明 MCP Roots，调用方不能替换部署的目录范围。

## 智能体调用

1. `dreammate_list_services({"keyword":"filesystem"})`；跨节点时指定 `node` 或 `node:"all"`。
2. `dreammate_inspect({"service_id":"filesystem","method":"filesystem.read_text_file"})` 获取 Schema。
3. `dreammate_invoke` 执行，例如：

```json
{
  "node": "scott-mac",
  "service_id": "filesystem",
  "method": "filesystem.read_text_file",
  "params": { "path": "/absolute/project/README.md", "head": 80 }
}
```

路径属于目标节点。首次使用先调用 `filesystem.list_allowed_directories`。配套指南可以用 `dreammate_inspect` 的 `skill:"file-system-mcp"` 查看，也可用 `dreammate_download_skill` 下载。

| 方法 | 用途 |
| --- | --- |
| `filesystem.read_text_file` | 读文本，支持 head/tail |
| `filesystem.read_media_file` | 读媒体或二进制，保留 MCP 内容块 |
| `filesystem.read_multiple_files` | 批量读取 |
| `filesystem.write_file` | 新建或覆盖文件 |
| `filesystem.edit_file` | 定点文本替换，支持 dryRun |
| `filesystem.create_directory` | 递归创建目录 |
| `filesystem.list_directory` | 列目录 |
| `filesystem.list_directory_with_sizes` | 列目录及大小 |
| `filesystem.directory_tree` | 目录树 |
| `filesystem.move_file` | 移动/重命名，目标已存在时报错 |
| `filesystem.search_files` | 按名称/glob 搜索 |
| `filesystem.get_file_info` | 元信息 |
| `filesystem.list_allowed_directories` | 开放目录范围 |
| `filesystem.read_file` | 上游保留的旧版读文本别名 |

方法契约从上游 `tools/list` 自动生成，包含 JSON Schema 与工具 annotations。只读模式只公开明确标注 `readOnlyHint:true` 的工具，并在调用层拒绝其他方法。当前上游不提供删除、追加或内容 grep 工具。

## 原生 MCP 与一次性 CLI

无需 DreamMate 即可直接接入 MCP 客户端：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/file-system-mcp/bin/file-system-mcp.mjs", "mcp", "--root", "/absolute/project"]
    }
  }
}
```

原生 MCP 工具名保持上游名称（如 `read_text_file`）；DreamMate 方法带 `filesystem.` 前缀。`mcp` 模式不启动 HTTP、不向网关报备。

```sh
printf '%s' '{"method":"filesystem.list_allowed_directories","params":{}}' |
  node bin/file-system-mcp.mjs invoke --root /absolute/project

node bin/file-system-mcp.mjs manifest --root /absolute/project
```

CLI invoke 保留完整 MCP JSON，错误时退出码为 1；日志输出到 stderr。

## HTTP 与调用结果

- `GET /health`：上游状态、开放目录、只读模式、报备状态。
- `GET /manifest`：DreamMate 服务与方法契约。
- `POST /invoke`：`{"method":"filesystem.read_text_file","params":{...}}`，兼容旧字段 `capability`。
- `POST /shutdown`：优雅停止并尽力注销服务。

完整保留 MCP `content`、`structuredContent`、`isError` 和媒体内容块。业务失败也可能为 HTTP 200，应检查 `isError`。单次上游调用超时为 12 秒，网关当前 HTTP 转发超时为 15 秒；写请求不会自动重试，超时后先读回状态。请求体上限 8 MiB。

目录权限继承运行进程的用户权限；网关的现有网络访问控制决定哪些智能体能调用。路径边界复用上游校验，不是操作系统级隔离。封装只接受回环网关报备地址，HTTP 拒绝带 Origin 的浏览器调用。仅开放任务需要的目录。

## 开源选型

| 项目 | 特点 | 本项目决定 |
| --- | --- | --- |
| [官方 server-filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | Node.js，基本文件操作与目录边界控制，npm 分发；许可见上游 LICENSE | 采用；接入现有 Node 网关最直接 |
| [j0hanz/filesystem-mcp](https://github.com/j0hanz/filesystem-mcp) | 内容搜索、patch、订阅与 HTTP；Node.js >=24、RE2 等额外依赖 | 当前仅需基础文件操作，暂不引入 |
| [mark3labs/mcp-filesystem-server](https://github.com/mark3labs/mcp-filesystem-server) | Go 文件系统 MCP | 需要另一套构建与二进制分发链，当前不采用 |

调研时间：2026-10-04。版本以 npm 实际安装包为准。上游归属与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 验证与打包

```sh
npm run check
npm test
npm pack
```

测试执行真实上游 MCP，覆盖文件操作、dryRun、目录越界、符号链接、只读模式、媒体块、原生 MCP 与 HTTP 报备/调用/注销。`npm pack` 生成可安装包；发布到 DreamMate 能力网络由 serve/install 报备完成，独立于 npm registry 发布。

MIT，见 [LICENSE](LICENSE)。

## GitHub 自动发布

CI 在 Linux Node 22/24 和 macOS Node 22 上运行全部测试，均安装哈希锁定的 Python 依赖。`.github/workflows/publish.yml` 支持手动 dry run，以及推送 `v<package.json 版本>` 标签后发布到 npm 并生成 provenance。

首次创建 npm 包后，将 Trusted Publisher 绑定到 `scottzx/file-system-mcp` 的 `publish.yml`，允许 npm publish。Workflow 使用 GitHub OIDC，不依赖长期 npm token Secret。
