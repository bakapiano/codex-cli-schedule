# 实现细节

[English](implementation.md) · **简体中文** · [返回 README](../README.zh-CN.md)

本文面向维护者与希望了解原理的用户，记录内部约定和源码行为。安装与日常使用请从 README 开始。

## 架构与进程生命周期

CLI 和 MCP 客户端通过带身份验证的本地 HTTP API 访问同一个 daemon。daemon 负责调度、SQLite 存储以及短时 Codex App Server 连接。

- MCP 进程是轻量 stdio 客户端，断开后 daemon 继续运行。
- `start`、任务管理命令和 MCP 入口会按需启动 daemon；`status` 用于查询当前状态。
- 使用相同 `--home` 或 `CODEX_SCHEDULE_HOME` 的客户端，共享配置与任务数据。
- 登录自启动由用户自行管理。

daemon 调用本机安装的 Codex，并使用现有配置与登录态。可通过 `start --codex <绝对路径>` 指定实际投递时使用的可执行文件。

## 会话所有权与投递约定

### 已有会话

通过 `thread/read` 读取会话元数据，再用 `thread/queue/add` 投递提示词。执行权保持在原 Codex 终端。

### 新会话

1. 短时 App Server 调用 `thread/start` 创建持久化会话。
2. `thread/inject_items` 向新会话历史写入带有 `[codex-cli-schedule]` 标识的初始化记录。
3. 创建会话的 App Server 退出，释放该会话的 writer。
4. 另一个连接通过 `thread/queue/add` 投递真正的提示词。
5. 用户运行 `codex resume <session-id>` 打开会话，由该终端消费队列。

项目采用的 Codex 0.154 协议需要这条初始化记录来落盘空会话。协议调用范围限定为初始化、元数据读取、新会话创建、带来源标识的初始化记录以及队列投递。

所选的 Codex 可执行文件须提供 `thread/queue/add` 与实验性的 `thread/inject_items` 接口。

新会话初始设置为 `sandbox: read-only` 和 `approvalPolicy: on-request`，用户可在打开会话的终端中调整权限。

### 投递确认

`queued` 表示 App Server 已接受提示词。模型执行进度和回复在目标 Codex 会话中查看；已关闭的会话会保留待处理队列。

## 调度、持久化与恢复

- daemon 每 500 ms 检查到期任务，串行投递。
- 每次投递前，事务会认领到期任务、创建 run，并推进下次执行时间。
- 每个 run 使用稳定的 `clientUserMessageId` 发起队列请求。
- 过期的一次性任务补发一次；周期任务将错过的次数合并投递一次，再计算未来时间。
- 修改或删除计划影响未来投递；已经送达的提示词由目标会话管理。
- 连接预检失败时，任务保持到期状态，等待后续尝试。
- 明确的 RPC 拒绝记录为 `failed`；传输结果不确定或投递被中断时，记录为 `unknown`。
- daemon 启动时，将遗留的 `dispatching` 记录更新为 `unknown`。再次安排投递前，应先核对目标会话队列。
- 若新会话创建成功后发生后续错误，run 中会保留已取得的 `sessionId`，方便排查。

## 单实例锁与升级

本节对应 `0.1.2` 源码中的锁实现；`0.1.0` 与 `0.1.1` 使用基于 PID 的所有权检查。

存储层解析数据库的规范路径，单独打开 `schedules.sqlite.lock` 数据库，并在连接整个生命周期中保持独占事务。任务与投递记录仍通过主数据库独立读写。

持有者退出或被强制结束时，操作系统会释放锁。`daemon_lease` 表中的 PID 和 owner 用于记录诊断信息，新版 owner 使用 `sqlite-lock:` 前缀。新 daemon 取得系统锁后即可接管遗留的新版记录，包括旧 PID 已被复用的情况。

升级时，对旧版记录采取保守处理：

1. 切换版本前，先停止仍在运行的旧 daemon。
2. 旧记录对应的进程已退出时，可在启动过程中迁移。
3. 旧记录引用仍存活的 PID 时，需要核对该进程的实际身份。
4. 恢复已确认失效的记录前，先备份数据库；只处理对应的锁记录，保留任务及投递历史。

回归测试覆盖多连接与多进程竞争、强制终止、PID 复用、存储关闭、申请锁失败、旧版所有权以及监听端口失败后的资源释放。

## 本地文件与安全边界

| 文件 | 用途 |
| --- | --- |
| `schedules.sqlite` | 任务、投递记录和锁的诊断元数据 |
| `schedules.sqlite.lock` | daemon 的系统级单实例锁 |
| `config.json` | 本地 API 令牌、监听端口和 Codex 可执行文件 |
| `daemon.log` | daemon 启动及运行日志 |

内部 API 绑定 `127.0.0.1`，请求须携带随机生成的 Bearer token，使用预期的回环 Host 与端口，并省略 `Origin` 请求头。请求体上限为 1 MiB。

默认数据目录：Windows 为 `%LOCALAPPDATA%\codex-cli-schedule`，其他系统为 `~/.local/share/codex-cli-schedule`。目录与备份应仅向可信的本机用户开放，其中包含提示词、会话 ID 和服务凭据。

修改端口或 Codex 路径时，先停止 daemon，再选择新的启动方式：

```powershell
codex-schedule --home D:\codex-scheduler-data start --codex C:\path\to\codex.exe
codex-schedule --home D:\codex-scheduler-data serve --port 47632
```

`start` 用于后台运行，`serve` 用于前台调试，每次选择其中一种模式。

## MCP 注册方式

`setup` 通过官方 `codex mcp get` 和 `codex mcp add` 命令管理注册，记录以下信息：

- 当前 Node.js 可执行文件的绝对路径。
- 已安装包的 `dist/src/cli.js` 入口。
- 显式解析后的 `--home` 路径，以及 `mcp` 子命令。

保存后会回读校验。已有匹配配置会保留；同名冲突需要指定新的 `--name` 或明确使用 `--force`。`--dry-run` 用于输出配置预览。注册步骤更新 MCP 配置，实际服务启动发生在 MCP 进程启动时。

Windows npm 启动器通过 `cross-spawn` 调用。其他 MCP 条目由 Codex CLI 维护。

## MCP 工具与参数

| 工具 | 入参 | 用途 |
| --- | --- | --- |
| `schedule_create` | `name`、`prompt`、`trigger`、`target`、`enabled?` | 创建计划 |
| `schedule_list` | `{}` | 列出全部计划，包括已暂停或已完成的计划 |
| `schedule_get` | `id` | 获取计划及其版本 |
| `schedule_update` | `id`、`patch`、`expectedVersion?` | 修改、暂停或恢复计划 |
| `schedule_delete` | `id` | 删除未来调度并保留投递记录 |
| `schedule_runs` | `scheduleId?`、`limit?` | 查询投递记录 |
| `scheduler_status` | `{}` | 查看 daemon 状态与任务数量 |

`schedule_create` 参数示例：

```json
{
  "name": "check-status",
  "prompt": "检查部署状态并汇报",
  "trigger": { "type": "every", "seconds": 300 },
  "target": {
    "type": "existing",
    "sessionId": "00000000-0000-4000-8000-000000000001"
  }
}
```

其他触发器格式：

```json
{ "type": "at", "at": "2099-09-21T18:00:00+08:00" }
```

```json
{ "type": "cron", "expression": "0 9 * * *", "timezone": "Asia/Shanghai" }
```

新会话目标接受项目的绝对路径，以及可选的模型名称：

```json
{ "type": "new", "cwd": "D:\\code\\my-project", "model": "optional-model-name" }
```

CLI 的 `create` 和 `update` 也支持 `--json @schedule.json`。`update --version N` 用于乐观并发检查；`--prompt-file prompt.txt` 可从文件加载长提示词。

## 源码开发与验证

```powershell
git clone https://github.com/bakapiano/codex-cli-schedule.git
cd codex-cli-schedule
npm ci --registry=https://registry.npmjs.org/
npm test
npm install -g .
```

直接运行源码构建产物：

```powershell
npm run build
node dist/src/cli.js --help
```

自动测试覆盖时间与时区、CRUD、持久化、单实例、异常恢复、队列投递、新会话 writer 释放、MCP 注册，以及真实 stdio MCP 子进程。

真实验证请使用独立数据目录和独立会话，步骤见 [Codex E2E 测试](e2e.md)。模型调用使用当前 Codex 账号。原始诊断日志保存在 git 忽略的 `artifacts/` 目录。

npm 发包和 GitHub Actions 配置见[发布指南](publishing.md)。
