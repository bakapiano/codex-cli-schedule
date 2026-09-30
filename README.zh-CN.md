<div align="center">

# codex-cli-schedule

**给 Codex 会话加上定时任务。**

一次提醒、周期跟进、每日例行。<br>一条命令完成配置，在 Codex 中用自然语言管理，也可以直接使用命令行。

[![npm 版本](https://img.shields.io/npm/v/%40bakapiano%2Fcodex-cli-schedule?logo=npm&color=cb3837)](https://www.npmjs.com/package/@bakapiano/codex-cli-schedule) [![测试状态](https://github.com/bakapiano/codex-cli-schedule/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/bakapiano/codex-cli-schedule/actions/workflows/test.yml) [![MIT 许可证](https://img.shields.io/github/license/bakapiano/codex-cli-schedule?color=2563eb)](LICENSE)

[English](README.md) · **简体中文**

[快速开始](#快速开始) · [在 Codex 中使用](#在-codex-中使用) · [命令行](#命令行使用) · [常见问题](#常见问题) · [Star 趋势](#star-趋势)

</div>

## 可以用它做什么

- **定时跟进**：在指定时间向某个会话发送提示词。
- **周期检查**：每隔几分钟提醒一次，或按 cron 设置固定日程。
- **安排项目例行任务**：每次到点为项目创建新会话并投递提示词。
- **直接在 Codex 中管理**：用自然语言创建、查看、暂停、恢复和删除计划。

## 快速开始

准备好 **Node.js 24+** 和已登录的 **Codex CLI 0.154.0+**，确保终端可以调用 `codex`。

### 1. 安装并配置

```powershell
npm install -g @bakapiano/codex-cli-schedule --registry=https://registry.npmjs.org/
codex-schedule setup
```

### 2. 打开 Codex

新开一个 Codex CLI 会话，输入 `/mcp`，确认 `codex_schedule` 已连接。

### 3. 创建第一个计划

通过 `/status` 获取目标会话 ID，然后对 Codex 说：

> 为会话 `<session-id>` 创建一个名为 progress-check 的计划，每 5 分钟投递一次，提示词是“检查项目进度并简短汇报”。

首次使用 MCP 或管理任务时，本地调度服务会自动启动。到点后，提示词进入目标会话的队列，由该会话的 Codex 终端处理。

## 在 Codex 中使用

连接后，可以直接用自然语言管理计划：

```text
列出我的定时任务，标出哪些已经暂停。

暂停 progress-check 这个计划。

把 progress-check 改成每 10 分钟一次。

查看 progress-check 最近的投递记录。
```

也可以为项目安排新会话：

> 每天上海时间早上 9 点，为当前项目创建一个新会话，并投递“生成今天的项目日报”。

从投递记录中获取新会话 ID，使用 `codex resume <session-id>` 打开它，即可处理排队的提示词。

## 命令行使用

习惯终端操作的话，可以直接使用 `codex-schedule` 管理相同的计划。

<details>
<summary><strong>展开查看定时示例和常用命令</strong></summary>

以下示例使用 PowerShell。请将 `<session-id>` 替换为 Codex `/status` 中显示的会话 ID。

```powershell
# 十分钟后投递一次
$when = (Get-Date).AddMinutes(10).ToString("o")
codex-schedule create --name follow-up --session "<session-id>" --at $when --prompt "检查项目进度并汇报"

# 每五分钟投递一次
codex-schedule create --name progress-check --session "<session-id>" --every 5m --prompt "检查项目进度并汇报"

# 每天早上九点，为当前目录创建新会话并投递
codex-schedule create --name daily-summary --new --cwd "$PWD" --cron "0 9 * * *" --timezone Asia/Shanghai --prompt "生成今天的项目日报"
```

使用 `create` 或 `list` 返回的计划 ID 管理任务：

```powershell
codex-schedule list
codex-schedule get "<schedule-id>"
codex-schedule update "<schedule-id>" --pause
codex-schedule update "<schedule-id>" --enable
codex-schedule update "<schedule-id>" --every 10m
codex-schedule runs "<schedule-id>"
codex-schedule delete "<schedule-id>"
```

长提示词可使用 `--prompt-file prompt.txt`。更多选项见 `codex-schedule --help` 和 `codex-schedule create --help`。

</details>

## 个性化配置

默认会注册名为 `codex_schedule` 的 MCP 服务。重复运行 setup 可以安全检查已有的匹配配置。

<details>
<summary><strong>展开查看自定义名称、数据目录和服务管理</strong></summary>

```powershell
# 预览配置
codex-schedule setup --dry-run

# 自定义 MCP 名称
codex-schedule setup --name my_scheduler

# 让 MCP 和命令行共用指定数据目录
codex-schedule --home D:\codex-scheduler-data setup
codex-schedule --home D:\codex-scheduler-data list

# 指定用于注册的 Codex 可执行文件
codex-schedule setup --codex C:\path\to\codex.exe

# 移动 Node.js 或安装目录后，更新注册路径
codex-schedule setup --force

# 查看 MCP 配置和本地服务状态
codex mcp list
codex-schedule status
codex-schedule start
codex-schedule stop
```

`--force` 会替换所选的 MCP 配置；希望保留其他同名配置时，可通过 `--name` 指定新名称。

需要更换实际投递时调用的 Codex 路径，可先停止服务，再执行 `codex-schedule start --codex C:\path\to\codex.exe`。共享同一组任务的命令应使用相同的 `--home`。

</details>

## 常见问题

### 任务显示 `queued` 是什么意思？

表示提示词已经送达目标 Codex 会话的队列。打开对应会话即可查看处理进度和回复；已关闭的会话会保留待处理消息，重新打开后继续处理。

### 电脑需要一直开着吗？

定时检查在本机运行。MCP 客户端关闭后，后台服务会继续运行；电脑和服务保持运行时，才会处理到期任务。电脑重启或唤醒后，过期的一次性任务会补发一次，错过的周期投递会合并补发一次。

### 任务数据保存在哪里？

Windows 默认为 `%LOCALAPPDATA%\codex-cli-schedule`，其他系统默认为 `~/.local/share/codex-cli-schedule`。可通过 `--home` 或 `CODEX_SCHEDULE_HOME` 选择其他位置。备份请妥善保管，目录中包含提示词、会话 ID 和本地服务凭据。

### 如何升级，或排查 MCP 连接问题？

升级前先运行 `codex-schedule stop`，再执行安装命令。通过 `codex-schedule setup` 检查注册；路径发生变化时，用 `setup --force` 更新。最后新开 Codex 会话，通过 `/mcp` 查看连接状态。

遇到启动问题，可以查看 `codex-schedule status` 以及数据目录中的 `daemon.log`。旧版锁的恢复步骤见[实现细节](docs/implementation.zh-CN.md#单实例锁与升级)。

## 更多文档

- [实现细节](docs/implementation.zh-CN.md)：架构、投递行为、数据存储、MCP 接口与源码开发。
- [真实 Codex E2E 验证](docs/e2e.md)：在实际 Codex 会话中验证定时投递。
- [发布指南（英文）](docs/publishing.md)：npm 发包与 GitHub Actions 配置。

## Star 趋势

<a href="https://star-history.com/#bakapiano/codex-cli-schedule&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=bakapiano/codex-cli-schedule&amp;type=Date&amp;theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=bakapiano/codex-cli-schedule&amp;type=Date">
    <img alt="codex-cli-schedule 的 GitHub Star 趋势" src="https://api.star-history.com/svg?repos=bakapiano/codex-cli-schedule&amp;type=Date" width="100%">
  </picture>
</a>

## 许可证

[MIT](LICENSE)
