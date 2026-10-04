# DreamMate 基础 MCP 能力

官方维护的参考服务包括 Everything、Fetch、Filesystem、Git、Memory、Sequential Thinking、Time。此项目发布其中 6 项实用基础能力；Everything 是协议演示/测试服务器，未作为业务能力启用。官方参考实现用于展示协议与 SDK，部署行为以此适配层的目录、网络和状态范围为准。

来源：[官方服务清单](https://github.com/modelcontextprotocol/servers#-reference-servers)，核对日期 2026-10-04。GitHub、PostgreSQL、SQLite、Puppeteer 等旧参考服务已移到 archived 仓库，不随本批次启用；需要时选择当前维护的对应供应商或社区实现。

| 服务 ID | 方法前缀 | 功能 | 固定上游版本 | 默认端口 |
| --- | --- | --- | --- | --- |
| filesystem | `filesystem.` | 文件、目录、编辑、搜索和移动 | npm 2026.8.31 | 7784 |
| fetch | `fetch.` | 抓取网页，HTML 转 Markdown | PyPI 2026.8.18 | 7790 |
| git | `git.` | 状态、diff、日志、提交、分支 | PyPI 2026.8.18 | 7791 |
| memory | `memory.` | 持久化知识图谱 | npm 2026.8.31 | 7792 |
| sequential-thinking | `thinking.` | 分步分析、修订和分支记录 | npm 2026.8.31 | 7793 |
| time | `time.` | 当前时间、IANA 时区转换 | PyPI 2026.8.18 | 7794 |

## 安装、运行、发布

文件系统沿用 [README.md](README.md) 中的入口。其余五项由 `base-mcp` 管理。需要 Node.js >=22.5；Fetch/Git/Time 另外需要 Python 3.12 和已安装的 Python 依赖，Git 还需要系统 git。

```sh
npm ci --ignore-scripts
node scripts/setup-python.mjs  # 使用 uv，按 requirements.lock 校验版本和哈希

# 调试运行全部五项（Git 必须显式给开放目录）
node bin/base-mcp.mjs serve --root /absolute/project

# 在 macOS/Linux 安装五个独立的用户常驻服务，自动向本机网关报备
node bin/base-mcp.mjs install --root /absolute/project
node bin/base-mcp.mjs status
node bin/base-mcp.mjs uninstall

# 单独安装/运行一个；端口仍可显式指定
node bin/base-mcp.mjs serve --service time --port 7794
node bin/base-mcp.mjs install --service git --root /absolute/project --port 7791 --read-only
```

`--service` 默认 all；all 从 `--port`（默认 7790）起依次分配五个端口。单项模式直接使用指定端口，默认 7790，和多个实例同时运行时应显式选择端口。安装前检查端口，被其他服务占用时请另选 --port。`--id` 只对单项模式有效。其他参数：`--python PATH`、`--data-dir DIR`、`--agent LOCAL_URL`、`--no-report`。自定义 Python 环境可以替代包内环境。

五项均只监听回环，跨项目/跨节点调用经 dreammate-node 网关。每 30 秒重新报备，恢复网关重启后的服务发现。macOS 用 launchd，Linux 用 systemd user；移动项目、更新 Node/Python 路径后重新 install。Windows 使用已有服务管理器运行 serve。

官方 PyPI 下载较慢时可设置 `BASE_MCP_PYPI_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple` 再运行 setup-python；包内容仍按官方锁文件的哈希校验。`BASE_MCP_UV` 可指定 uv 可执行文件。

## 调用契约

调用路径与文件系统一致：`dreammate_list_services` → `dreammate_inspect` → `dreammate_invoke`。方法与 Schema 从实际上游 tools/list 自动生成，不以网页文档中的旧工具名为准。

```json
{"node":"scott-mac","service_id":"time","method":"time.get_current_time","params":{"timezone":"Asia/Shanghai"}}
```

```json
{"node":"scott-mac","service_id":"fetch","method":"fetch.fetch","params":{"url":"https://example.com","max_length":2000}}
```

```json
{"node":"scott-mac","service_id":"git","method":"git.git_status","params":{"repo_path":"/absolute/allowed/repository"}}
```

Memory 在上游参数之外增加必填 `namespace`。例如：

```json
{"node":"scott-mac","service_id":"memory","method":"memory.create_entities","params":{"namespace":"project-a","entities":[{"name":"deploy-plan","entityType":"plan","observations":["Staging smoke test passed."]}]}}
```

Sequential Thinking 增加必填 `session_id`，完整方法名按 inspect 返回值调用：

```json
{"node":"scott-mac","service_id":"sequential-thinking","method":"thinking.sequentialthinking","params":{"session_id":"project-a-task-123","thought":"Next action: verify the staging endpoint.","thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":false}}
```

## 状态与访问范围

- Memory 按 namespace 保存独立 JSONL 文件。默认目录为包内 `.local/base-mcp/memory`，可用 --data-dir 指定。每个 namespace 的并发写调用串行执行，防止上游读改写导致丢数据。命名空间用于项目分隔，未实现调用方身份鉴权。
- 思考状态仅保存在对应 session_id 的子进程内，闲置 5 分钟会释放。上游思考正文日志被关闭；提交简洁的任务计划与结论即可。
- Memory 和思考各最多 8 个活动 namespace/session，闲置进程自动回收，Memory 文件保留。
- Git 只允许访问 --root 范围内的仓库，校验真实路径、worktree、gitdir 与 common dir。只读模式隐藏并拒绝写方法。git_add 还检查文件路径及符号链接边界。这些是适配层边界，不是操作系统级隔离。
- Fetch 只抓取公网 HTTP/HTTPS 的 80/443。所有请求（含 robots.txt 和重定向）经过本机代理，解析后连接已验证的公网 IP，拒绝回环、内网、Tailnet 和云元数据地址；TLS 仍由上游验证。本机代理 DNS 返回 198.18/15、2001:2/48 的 Fake-IP 时，按公网域名通过 Cloudflare DoH 查询真实公网 IP，仍不连接 Fake-IP 或私有 IP。遵循上游默认 robots.txt 行为，不提供认证 Cookie 或任意请求头。
- 时间服务默认本地时区 Asia/Shanghai；调用时可传任意有效 IANA 时区。没有定时执行功能。

HTTP 接口、完整 MCP 返回值、12 秒上游调用超时和错误检查规则与文件系统相同。Fetch 在调用上游之前先解析并验证目标域名，DoH 查询最多 10 秒；这样不会把首次公网 DNS 查询计入上游较短的 robots.txt 超时。写请求不自动重试。各服务附带 `base-mcp` 技能，可经能力网络 inspect 或下载。

## 一次性调用与验证

```sh
printf '%s' '{"method":"time.get_current_time","params":{"timezone":"UTC"}}' |
  node bin/base-mcp.mjs invoke --service time

node bin/base-mcp.mjs manifest --root /absolute/project
npm run check
npm test
npm pack
```

`npm test` 除原文件系统测试外，执行 Memory 持久化、并发与 namespace 隔离，思考会话隔离，Git 临时仓库操作和越界拦截，Time 转换以及 Fetch 代理策略。测试数据在临时目录生成，不读取实际项目内容。

Node 依赖由 package-lock.json 锁定；Python 顶层版本见 requirements.in，完整版本和哈希见 requirements.lock。服务使用上游包，不复制其实现。
