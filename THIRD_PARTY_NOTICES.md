# 上游与许可证

本项目以 npm 依赖方式使用上游实现，不复制或修改其文件系统代码。

- `@modelcontextprotocol/server-filesystem@2026.8.31`：Model Context Protocol 官方参考服务器，npm 包声明 `SEE LICENSE IN LICENSE`。源码与许可证见 https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem 和 https://github.com/modelcontextprotocol/servers/blob/main/LICENSE 。该版本 npm 包的 files 清单仅包含 dist，许可证文本需从上游仓库查看；当前仓库对历史代码和新贡献分别声明 MIT 与 Apache-2.0。
- `@modelcontextprotocol/sdk@1.30.0`：MCP TypeScript SDK，MIT。源码与许可证见 https://github.com/modelcontextprotocol/typescript-sdk 。
- `@modelcontextprotocol/server-memory@2026.8.31` 与 `@modelcontextprotocol/server-sequential-thinking@2026.8.31`：官方参考实现，npm 包声明 `SEE LICENSE IN LICENSE`；归属与许可证见 https://github.com/modelcontextprotocol/servers/blob/main/LICENSE ，该仓库目前对历史代码和新贡献分别声明 MIT 与 Apache-2.0。
- `mcp-server-fetch`、`mcp-server-git`、`mcp-server-time`（均为 `2026.8.18`）：官方 Python 参考实现，PyPI 元数据声明 MIT；源码位于同一官方仓库的 src/fetch、src/git、src/time。

Node 依赖版本在 package.json 中固定，完整传递依赖由 package-lock.json 锁定；Python 依赖在 requirements.lock 中锁定版本与哈希。升级上游后运行对应真实服务、目录/网络边界、状态隔离和 MCP/HTTP 转发测试，再部署。
