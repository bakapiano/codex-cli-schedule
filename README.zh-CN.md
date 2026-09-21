# codex-cli-schedule

[English](README.md) | **简体中文**

一个 TypeScript 编写的本地 Codex CLI 调度器。支持一次性、固定间隔、cron 任务，提供 CLI 和 MCP 两种管理入口。

## 核心约定

- **已有 session 只入队**：使用 App Server 的 `thread/queue/add`，执行权保持在原终端。
- **新 session 初始化后释放**：短时 App Server 创建会话，追加一条明确标注 `[codex-cli-schedule]` 的初始化记录完成落盘，退出释放 writer，再用独立连接入队，等待用户终端消费。
- **queued = 投递成功**：目标会话的 Codex CLI 消费消息并执行。关闭的会话保留待处理队列，用户打开后消费。
- **独立 daemon**：多个 MCP/CLI 客户端共用一个调度器；关闭客户端后调度继续。
- **按需启动**：首次调用管理命令或 MCP 时检查并启动 daemon。登录自启动由用户自行管理。
- SQLite 保存任务、投递记录和单实例 lease。所有客户端使用同一个 `--home` 即可看到同一组任务。

调度器操作范围仅包含 `initialize`、`thread/start`、`thread/read`、`thread/inject_items`、`thread/queue/add` 等必要接口。初始化记录只追加到调度器新建的会话，已有 session 的投递路径保持队列模式。

## 要求

- Node.js 24+
- Codex CLI 0.154.0+，并具有 `thread/queue/add` 与实验性的 `thread/inject_items` 接口
- Codex 已完成登录，且命令可从 PATH 调用；也可用 `start --codex <绝对路径>` 指定可执行文件

App Server 使用本机 Codex 的配置与登录态，通过 stdio 启动短时子进程。调度器负责关闭自己创建的子进程。Codex 0.154 的空会话需显式落盘；带来源标识的初始化记录通过 `thread/inject_items` 写入会话历史，真正的任务 prompt 在创建进程退出后单独入队。

## 安装

```powershell
git clone https://github.com/bakapiano/codex-cli-schedule.git
cd codex-cli-schedule
npm ci
npm test
npm pack
npm install -g ./bakapiano-codex-cli-schedule-0.1.0.tgz
```

从源代码运行也可以：

```powershell
npm run build
node dist/src/cli.js --help
```

## 管理 daemon

```powershell
codex-schedule start
codex-schedule status
codex-schedule stop

# 指定共享数据目录与 Codex 路径
codex-schedule --home D:\codex-scheduler-data start --codex C:\path\to\codex.exe

# 前台调试
codex-schedule --home D:\codex-scheduler-data serve --port 47632
```

默认数据目录：Windows 为 `%LOCALAPPDATA%\codex-cli-schedule`，其他系统为 `~/.local/share/codex-cli-schedule`。也可设置 `CODEX_SCHEDULE_HOME`。修改默认端口或 Codex 路径时，先停止已有 daemon，再带新参数启动。

首次配置产生随机令牌，内部管理 API 只监听 `127.0.0.1`，请求要求 Bearer token。CLI 和 MCP 自动读取本地配置。`config.json` 包含令牌，请保持该目录仅供可信本机用户访问。

## CLI 示例

以下将 `<session-id>` 替换成 Codex `/status` 中显示的 session ID。

```powershell
# 指定时间投递；时间包含时区
codex-schedule create --name check-deployment --session <session-id> --at "2099-09-21T18:00:00+08:00" --prompt "检查部署状态并汇报"

# 每 5 分钟投递
codex-schedule create --name poll --session <session-id> --every 5m --prompt "检查任务进度"

# 上海时间，每天早上 9 点，新建会话并排队
codex-schedule create --name daily --new --cwd D:\code\my-project --cron "0 9 * * *" --timezone Asia/Shanghai --prompt "生成今日状态摘要"

codex-schedule list
codex-schedule get <schedule-id>
codex-schedule update <schedule-id> --pause
codex-schedule update <schedule-id> --prompt "更新后的任务说明"
codex-schedule update <schedule-id> --every 10m --enable
codex-schedule runs <schedule-id>
codex-schedule delete <schedule-id>
```

较长的 prompt 使用 `--prompt-file prompt.txt`。`create` 和 `update` 还支持 `--json @schedule.json`；JSON 数据结构与 MCP 入参相同。`update --version N` 提供乐观并发检查。

新建会话的 ID 位于 `runs` 中的 `sessionId`。由用户在终端使用 `codex resume <session-id>` 打开它，随后消费队列。新会话初始权限为只读、按请求审批，终端用户可以按需要调整。

## 安装为 Codex MCP

推荐将全局安装后的 JS 入口配置为 stdio MCP，避免 Windows `.cmd` 启动器差异：

```powershell
$root = npm root -g
$entry = Join-Path $root '@bakapiano\codex-cli-schedule\dist\src\cli.js'
codex mcp add codex_schedule -- node $entry mcp

# 指定共享数据目录时：
codex mcp add codex_schedule -- node $entry --home D:\codex-scheduler-data mcp
```

新开 Codex CLI 会话后，可自然语言创建和管理调度任务。每个 CLI 的 MCP 进程是轻量客户端，调度器在独立进程中继续运行。

### MCP 工具

| 工具 | 入参 | 用途 |
| --- | --- | --- |
| `schedule_create` | `name`, `prompt`, `trigger`, `target`, `enabled?` | 新建任务 |
| `schedule_list` | `{}` | 列出所有任务，含暂停与已完成任务 |
| `schedule_get` | `id` | 读取任务与版本 |
| `schedule_update` | `id`, `patch`, `expectedVersion?` | 修改、暂停、恢复 |
| `schedule_delete` | `id` | 删除未来调度，保留投递记录 |
| `schedule_runs` | `scheduleId?`, `limit?` | 查看投递结果 |
| `scheduler_status` | `{}` | 查看 daemon 状态 |

```json
{
  "name": "check-status",
  "prompt": "检查部署状态并汇报",
  "trigger": { "type": "every", "seconds": 300 },
  "target": { "type": "existing", "sessionId": "00000000-0000-4000-8000-000000000001" }
}
```

其他触发器：`{"type":"at","at":"2099-09-21T18:00:00+08:00"}`、`{"type":"cron","expression":"0 9 * * *","timezone":"Asia/Shanghai"}`。

新会话目标：`{"type":"new","cwd":"D:\\code\\my-project","model":"optional-model-name"}`。

## 执行与恢复语义

- daemon 每 500 ms 检查到期任务，串行投递。
- 休眠/停机后，一次性任务补发一次；重复任务把错过的触发合并为一次，然后计算未来时间。
- 修改或删除影响后续触发；已投递消息由目标会话队列管理。
- 投递前以事务生成 run，推进下一次时间；每次 run 有稳定的 `clientUserMessageId`。
- 连接在投递前失败：任务继续保持到期状态，稍后检查。
- 明确拒绝：记录 `failed`；请求结果不确定或中途崩溃：记录 `unknown`。确认目标队列后，可通过修改任务时间重新投递。
- `queued` 表示 App Server 已接受消息；模型执行进度和回复在目标 Codex 会话中查看。
- 创建新会话后若后续步骤失败，已获得的 session ID 会写进 run，便于排查。

数据文件包括 `schedules.sqlite`、`config.json` 和 `daemon.log`。其中包含 prompt、会话 ID 和管理令牌，请按本地敏感数据保存。

## 开发与测试

```powershell
npm ci
npm test
```

自动测试覆盖时间/时区、CRUD、持久化、单实例、异常恢复、队列专用协议、新会话 writer 释放，以及真实 MCP stdio 子进程访问 daemon。

真实 Codex CLI 测试流程见 [docs/e2e.md](docs/e2e.md)。模型调用使用当前 Codex 登录态，测试 prompt 限定为文本确认。
