<div align="center">

# codex-cli-schedule

**Schedule prompts for your Codex sessions.**

One-time reminders, recurring check-ins, and daily routines.<br>Set up in one command. Manage schedules from Codex or your terminal.

[![npm version](https://img.shields.io/npm/v/%40bakapiano%2Fcodex-cli-schedule?logo=npm&color=cb3837)](https://www.npmjs.com/package/@bakapiano/codex-cli-schedule) [![Tests](https://github.com/bakapiano/codex-cli-schedule/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/bakapiano/codex-cli-schedule/actions/workflows/test.yml) [![MIT License](https://img.shields.io/github/license/bakapiano/codex-cli-schedule?color=2563eb)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [Use with Codex](#use-with-codex) · [CLI](#command-line) · [FAQ](#faq) · [Star History](#star-history)

</div>

## What you can do

- **Send a prompt later** — arrange a one-time follow-up for a specific session.
- **Check in regularly** — send prompts every few minutes or on a cron schedule.
- **Plan project routines** — create a new session for each scheduled delivery.
- **Manage everything from Codex** — create, inspect, pause, resume, and delete schedules through MCP.

## Quick start

Have **Node.js 24+** and an authenticated **Codex CLI 0.154.0+** ready. The `codex` command should be available in your terminal.

### 1. Install and connect

```powershell
npm install -g @bakapiano/codex-cli-schedule --registry=https://registry.npmjs.org/
codex-schedule setup
```

### 2. Open Codex

Start a new Codex CLI session and enter `/mcp`. Check that `codex_schedule` is connected.

### 3. Create your first schedule

Get the target session ID from `/status`, then ask Codex:

> Create a schedule named progress-check for session `<session-id>`, every five minutes. The prompt should be “Check project progress and give me a short update.”

The local scheduling service starts when you use MCP or manage tasks. Scheduled prompts are delivered to the target session's queue and processed in its Codex terminal.

## Use with Codex

Once connected, you can manage schedules in natural language:

```text
List my schedules and show which ones are paused.

Pause the progress-check schedule.

Change progress-check to run every ten minutes.

Show the recent delivery records for progress-check.
```

You can also schedule a new session for a project:

> Every day at 09:00 in Asia/Shanghai, create a new session for the current project and queue “Generate today's project summary.”

Find the new session ID in the delivery records, then open it with `codex resume <session-id>` to process the queued prompt.

## Command line

Prefer the terminal? The same scheduling features are available through `codex-schedule`.

<details>
<summary><strong>Scheduling examples and everyday commands</strong></summary>

These examples use PowerShell. Replace `<session-id>` with the value from Codex's `/status`.

```powershell
# Once, ten minutes from now
$when = (Get-Date).AddMinutes(10).ToString("o")
codex-schedule create --name follow-up --session "<session-id>" --at $when --prompt "Check project progress and report back"

# Every five minutes
codex-schedule create --name progress-check --session "<session-id>" --every 5m --prompt "Check project progress and report back"

# Every day at 09:00, in a new session for the current directory
codex-schedule create --name daily-summary --new --cwd "$PWD" --cron "0 9 * * *" --timezone Asia/Shanghai --prompt "Generate today's project summary"
```

Use the schedule ID returned by `create` or `list` to manage it:

```powershell
codex-schedule list
codex-schedule get "<schedule-id>"
codex-schedule update "<schedule-id>" --pause
codex-schedule update "<schedule-id>" --enable
codex-schedule update "<schedule-id>" --every 10m
codex-schedule runs "<schedule-id>"
codex-schedule delete "<schedule-id>"
```

For longer prompts, use `--prompt-file prompt.txt`. Run `codex-schedule --help` or `codex-schedule create --help` to explore the options.

</details>

## Configuration

The default setup registers an MCP server named `codex_schedule`. Repeat setup safely to check an existing matching registration.

<details>
<summary><strong>Custom names, data directories, and service controls</strong></summary>

```powershell
# Preview the registration
codex-schedule setup --dry-run

# Choose an MCP name
codex-schedule setup --name my_scheduler

# Use a shared data directory for MCP and CLI commands
codex-schedule --home D:\codex-scheduler-data setup
codex-schedule --home D:\codex-scheduler-data list

# Choose the Codex executable used for registration
codex-schedule setup --codex C:\path\to\codex.exe

# Update registered paths after moving Node.js or the package
codex-schedule setup --force

# Inspect MCP registration and the local service
codex mcp list
codex-schedule status
codex-schedule start
codex-schedule stop
```

`--force` replaces the selected MCP registration. Choose `--name` to keep a different same-name configuration.

To change the executable used for scheduled deliveries, stop the service and start it with `codex-schedule start --codex C:\path\to\codex.exe`. Use the same `--home` for commands that should share schedules.

</details>

## FAQ

### What does `queued` mean?

The prompt has reached the target Codex session's queue. Open that session to view its progress and replies. Closed sessions keep their pending prompts for the next time they are opened.

### Does the computer need to stay on?

Scheduling runs on your computer. The background service continues after MCP clients close; your computer and the service need to be running to process due schedules. After a restart or wake-up, overdue one-time tasks are delivered once and missed recurring deliveries are combined into one catch-up delivery.

### Where are my schedules stored?

On Windows, the default directory is `%LOCALAPPDATA%\codex-cli-schedule`. On other systems, it is `~/.local/share/codex-cli-schedule`. Choose `--home` or set `CODEX_SCHEDULE_HOME` to use another directory. Keep backups private: the directory contains prompts, session IDs, and credentials for the local service.

### How do I update or troubleshoot the connection?

Use `codex-schedule stop` before an upgrade, then run the installation command again. Use `codex-schedule setup` to check registration, or `setup --force` to update changed paths. Start a new Codex session and check `/mcp`.

For startup problems, check `codex-schedule status` and `daemon.log` in the data directory. See the [implementation notes](docs/implementation.md#single-instance-lock-and-upgrades) for legacy lock recovery.

## Documentation

- [Implementation details](docs/implementation.md) — architecture, delivery behavior, storage, MCP schemas, and source development.
- [Live Codex E2E checks (中文)](docs/e2e.md) — validate scheduling with an actual Codex session.
- [Publishing guide](docs/publishing.md) — npm releases and GitHub Actions setup.

## Star History

<a href="https://star-history.com/#bakapiano/codex-cli-schedule&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=bakapiano/codex-cli-schedule&amp;type=Date&amp;theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=bakapiano/codex-cli-schedule&amp;type=Date">
    <img alt="Star history of codex-cli-schedule" src="https://api.star-history.com/svg?repos=bakapiano/codex-cli-schedule&amp;type=Date" width="100%">
  </picture>
</a>

## License

[MIT](LICENSE)
