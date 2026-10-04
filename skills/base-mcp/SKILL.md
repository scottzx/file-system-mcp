---
name: base-mcp
description: 通过 DreamMate 能力网络调用官方网页抓取、Git 仓库、项目记忆、分步思考以及时间与时区服务。
---

先用 `dreammate_list_services` 查找实际 service_id 和 node，再用 `dreammate_inspect` 按方法查看参数 Schema，最后 `dreammate_invoke` 调用。各服务的默认 ID 如下，部署时可以自定义。

| service_id | 方法前缀 | 用途与参数约定 |
| --- | --- | --- |
| fetch | `fetch.` | `fetch.fetch` 抓取公网 HTTP/HTTPS 网页并转 Markdown，支持 max_length/start_index 分页。仅允许公网 80/443，内网与回环地址及指向这些地址的重定向会被拒绝。 |
| git | `git.` | `git.git_status`、diff、log、show、add、commit 和分支操作。repo_path 必须是目标节点开放目录内的绝对路径；查看服务 metadata 的 allowed_directories。 |
| memory | `memory.` | 知识图谱实体、关系和观察。所有方法都必须携带 namespace，例如项目名 project-a；不同 namespace 的文件独立保存。 |
| sequential-thinking | `thinking.` | 用上游方法记录分步问题分析；所有方法必须携带任务唯一的 session_id，避免不同任务混用历史。会话闲置 5 分钟后释放，状态为临时状态。 |
| time | `time.` | `time.get_current_time` 和 `time.convert_time`，时区使用 IANA 名称，如 Asia/Shanghai。 |

Memory namespace 和 thinking session_id 可用字母、数字、点、下划线与短横线，首字符须为字母或数字，最多 64 字符。每个服务最多 8 个活动命名空间/会话；闲置 5 分钟后回收进程，Memory 文件仍持久保存。命名空间避免项目误混，不提供身份鉴权；能访问网关的调用方仍须遵守项目的数据使用范围。

只提交任务需要的结论、计划和观察，不把密钥或私有推理过程写入 Memory 或思考日志。Git 修改按当前任务授权执行；git_reset 是取消暂存，其他 Git 行为以 inspect 返回的契约为准。只读部署仅公开标注为只读的工具。

检查 MCP 结果的 isError。写操作超时或断连后先核对实际状态，不自动重试。

时间调用示例：

```json
{"node":"my-mac","service_id":"time","method":"time.get_current_time","params":{"timezone":"Asia/Shanghai"}}
```

Memory 查询示例：

```json
{"node":"my-mac","service_id":"memory","method":"memory.search_nodes","params":{"namespace":"project-a","query":"deployment"}}
```
