# Implementation details

**English** · [简体中文](implementation.zh-CN.md) · [Back to README](../README.md)

This document covers the scheduler's internal contracts and source-level behavior. For installation and everyday use, start with the README.

## Architecture and process lifetime

CLI commands and MCP clients communicate with a shared local daemon over an authenticated loopback HTTP API. The daemon owns the scheduler, SQLite storage, and short-lived Codex App Server connections.

- The MCP process is a lightweight stdio client. Its disconnection leaves the daemon running.
- `start`, task-management commands, and the MCP entry point start the daemon on demand. `status` reports the current state.
- All clients with the same `--home` or `CODEX_SCHEDULE_HOME` use the same configuration and task data.
- Optional login/startup automation is managed by the user.

The daemon uses the locally installed Codex executable and its existing configuration and authentication. Use `start --codex <absolute-path>` to select the executable used for deliveries.

## Session ownership and delivery

### Existing sessions

The scheduler reads session metadata with `thread/read` and submits the prompt using `thread/queue/add`. Execution ownership stays with the original Codex terminal.

### New sessions

1. A short-lived App Server creates a persistent session with `thread/start`.
2. `thread/inject_items` writes a clearly attributed `[codex-cli-schedule]` initialization message to the new session's history.
3. The creating App Server exits and releases the session's writer.
4. A separate connection submits the actual prompt with `thread/queue/add`.
5. The user opens the session with `codex resume <session-id>` and its terminal consumes the queue.

This initialization record is needed to persist empty sessions with the Codex 0.154 protocol used by this project. The protocol surface is limited to initialization, metadata reads, session creation, the attributed initialization record, and queue insertion.

The selected Codex executable must expose `thread/queue/add` and the experimental `thread/inject_items` interface.

New sessions start with `sandbox: read-only` and `approvalPolicy: on-request`. The user can adjust these from the terminal that opens the session.

### Delivery acknowledgement

`queued` records App Server acceptance of the prompt. Model execution progress and replies are observed in the target Codex session. Closed sessions retain their pending queue entries.

## Scheduling, persistence, and recovery

- The daemon checks for due schedules every 500 ms and dispatches serially.
- A transaction claims each due occurrence, creates its run, and advances the next due time before dispatch.
- Each run has a stable `clientUserMessageId` for the queue request.
- Overdue one-time schedules are delivered once. Missed recurring occurrences are coalesced into one catch-up delivery before calculating the next future time.
- Updating or deleting a schedule changes future deliveries. The target session manages prompts it has already received.
- A failed connection preflight leaves the schedule due for a later attempt.
- Explicit RPC rejection records `failed`. Uncertain transport results and interrupted dispatches record `unknown`.
- On daemon startup, persisted `dispatching` runs become `unknown`. Inspect the target queue before explicitly arranging another delivery.
- If session creation succeeds before a later failure, the run retains its `sessionId` for diagnosis.

## Single-instance lock and upgrades

The lock described here is implemented in the `0.1.2` source. Versions `0.1.0` and `0.1.1` used PID-only ownership checks.

The store resolves the canonical database path and opens a separate `schedules.sqlite.lock` database. An exclusive transaction stays open on that connection for the owner's lifetime. Task and run writes use the main database independently.

The operating system releases the lock when the owner exits, including forced termination. The `daemon_lease` row retains diagnostic PID and owner metadata; modern owner values use the `sqlite-lock:` prefix. A new daemon reclaims an orphaned modern record after acquiring the OS-backed lock, including when its recorded PID has been reused.

Legacy records receive conservative handling during an upgrade:

1. Stop a running old-version daemon before switching versions.
2. A record for a dead process can be migrated during startup.
3. A legacy record referring to a live PID requires checking the process's actual identity.
4. Back up the database before recovering a verified stale record. Target only that exact lease and preserve schedules and delivery history.

Regression tests cover competing connections and processes, forced termination, PID reuse, store closure, failed acquisition, legacy ownership, and cleanup after a listening-port failure.

## Local files and security

| File | Purpose |
| --- | --- |
| `schedules.sqlite` | Schedules, delivery records, and lease metadata |
| `schedules.sqlite.lock` | The daemon's OS-backed single-instance lock |
| `config.json` | Local API token, listening port, and Codex executable |
| `daemon.log` | Daemon startup and runtime diagnostics |

The API binds to `127.0.0.1` and requires a generated Bearer token. Requests must use the expected loopback host and port, with the `Origin` header omitted. Request bodies are limited to 1 MiB.

The default data directory is `%LOCALAPPDATA%\codex-cli-schedule` on Windows and `~/.local/share/codex-cli-schedule` elsewhere. Keep this directory and its backups accessible only to trusted local users: prompts, session IDs, and service credentials are sensitive.

To change the listening port or Codex executable, stop the daemon and restart it with the new options:

```powershell
codex-schedule --home D:\codex-scheduler-data start --codex C:\path\to\codex.exe
codex-schedule --home D:\codex-scheduler-data serve --port 47632
```

Use `start` for a background daemon or `serve` for foreground debugging, selecting one mode at a time.

## MCP registration

`setup` delegates configuration to the official `codex mcp get` and `codex mcp add` commands. It registers:

- The absolute path of the current Node.js executable.
- The installed `dist/src/cli.js` entry point.
- An explicit, resolved `--home` path followed by `mcp`.

The saved registration is read back and checked. Matching configurations are preserved; a conflicting name requires a new `--name` or an explicit `--force`. `--dry-run` produces the registration plan. Registration itself updates configuration, while service startup occurs when the MCP process is launched.

Windows npm launchers are invoked through `cross-spawn`. Other MCP entries are maintained by the Codex CLI.

## MCP tool reference

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `schedule_create` | `name`, `prompt`, `trigger`, `target`, `enabled?` | Create a schedule |
| `schedule_list` | `{}` | List all schedules, including paused and completed ones |
| `schedule_get` | `id` | Read a schedule and its version |
| `schedule_update` | `id`, `patch`, `expectedVersion?` | Modify, pause, or re-enable a schedule |
| `schedule_delete` | `id` | Delete future scheduling and retain delivery records |
| `schedule_runs` | `scheduleId?`, `limit?` | Inspect delivery records |
| `scheduler_status` | `{}` | Read daemon status and schedule counts |

Example `schedule_create` arguments:

```json
{
  "name": "check-status",
  "prompt": "Check deployment status and report back",
  "trigger": { "type": "every", "seconds": 300 },
  "target": {
    "type": "existing",
    "sessionId": "00000000-0000-4000-8000-000000000001"
  }
}
```

Other trigger forms:

```json
{ "type": "at", "at": "2099-09-21T18:00:00+08:00" }
```

```json
{ "type": "cron", "expression": "0 9 * * *", "timezone": "Asia/Shanghai" }
```

A new-session target accepts an absolute project directory and an optional model:

```json
{ "type": "new", "cwd": "D:\\code\\my-project", "model": "optional-model-name" }
```

CLI `create` and `update` also accept `--json @schedule.json`. `update --version N` supplies an optimistic-concurrency check. Long prompts can be loaded with `--prompt-file prompt.txt`.

## Development and verification

```powershell
git clone https://github.com/bakapiano/codex-cli-schedule.git
cd codex-cli-schedule
npm ci --registry=https://registry.npmjs.org/
npm test
npm install -g .
```

To run directly from source:

```powershell
npm run build
node dist/src/cli.js --help
```

Tests cover timing and timezones, CRUD operations, persistence, single-instance ownership, recovery, queue-only delivery, writer release for new sessions, MCP setup, and real stdio MCP subprocesses.

Use an isolated data directory and independent sessions for live checks. The [Codex E2E procedure](e2e.md) describes the process in Chinese; model calls use the current Codex account. Keep raw diagnostic output under the ignored `artifacts/` directory.

See the [publishing guide](publishing.md) for npm releases and GitHub Actions trusted publishing.
