---
name: file-system-mcp
description: 通过 DreamMate 能力网络操作目标节点开放目录内的文件和文件夹；适用于跨项目或跨设备读取、编辑、搜索和管理文件。
---

通过 dreammate-node 的发现与调用入口使用文件系统服务。

1. 调用 `dreammate_list_services`，按 `keyword: "filesystem"` 查找服务；需要其他设备时指定 `node`，全网检索可用 `node: "all"`。服务默认 ID 为 `filesystem`，部署时可自定义，使用发现结果中的实际 ID。
2. 首次操作调用 `dreammate_invoke`，使用 `method: "filesystem.list_allowed_directories"` 查看目标节点开放的目录。所有路径都是**目标节点**的绝对路径。服务不会接受调用方扩展开放目录。
3. 用 `dreammate_inspect` 查看要调用的方法契约，再调用 `dreammate_invoke`。方法名称为 `filesystem.` 加上游 MCP 工具名；按需查看 Schema，无需一次加载全部工具。

示例（将 node、service_id 和 path 替换为发现结果及实际目标路径）：

```json
{
  "node": "my-mac",
  "service_id": "filesystem",
  "method": "filesystem.read_text_file",
  "params": { "path": "/absolute/allowed/project/README.md", "head": 80 }
}
```

使用 `search_files` 按名称/glob 搜索文件；它不是文件内容搜索。`read_text_file` 支持 head/tail；媒体读取会返回 MCP image/audio 内容块。`edit_file` 支持 `dryRun: true` 预览差异，再按任务授权写入。`write_file` 会覆盖已有文件。

检查完整 MCP 结果的 `isError`，HTTP 200 不等于操作成功。写调用超时或断连后先读回目标状态，不自动重试，以免重复编辑或移动。只读部署仅公开标注为只读的工具，写方法不会出现在方法清单中。当前上游没有删除工具。

跨设备调用经目标节点的 dreammate-node 网关（默认端口 36908）转发；文件系统服务只监听本机回环。访问范围取决于部署时的 --root 配置和网关现有的访问控制。
