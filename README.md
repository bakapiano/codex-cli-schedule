# codex-cli-schedule

**English** | [简体中文](README.zh-CN.md)

A local Codex CLI scheduler written in TypeScript. Schedule one-time, fixed-interval, or cron jobs and manage them through a CLI or MCP tools.

## How it works

- **Existing sessions receive queued prompts**: the scheduler uses App Server's `thread/queue/add`, keeping execution ownership with the original terminal.
- **New sessions are initialized and released**: a short-lived App Server creates the session and persists a clearly labeled `[codex-cli-schedule]` initialization record. It then exits to release the writer lock. A separate connection queues the prompt for the user's terminal to consume.
- **`queued` means accepted for delivery**: the target session's Codex CLI consumes the prompt and executes it. Closed sessions retain pending messages until the user opens them.
- **Independent daemon**: multiple MCP and CLI clients share one scheduler, which continues running after clients close.
- **On-demand startup**: management commands and the MCP entry point check for the daemon and start it when needed. Users manage any optional login-startup configuration themselves.
- SQLite stores schedules, delivery records, and the single-instance lease. Clients using the same `--home` share the same schedules.

The scheduler uses a narrow set of App Server methods, including `initialize`, `thread/start`, `thread/read`, `thread/inject_items`, and `thread/queue/add`. Initialization records are appended only to sessions created by the scheduler; existing sessions use the queue-only delivery path.

## Requirements

- Node.js 24+
- Codex CLI 0.154.0+ with `thread/queue/add` and the experimental `thread/inject_items` method
- An authenticated Codex CLI available on PATH; alternatively, specify its executable with `start --codex <absolute-path>`

The scheduler starts short-lived App Server subprocesses over stdio using the local Codex configuration and authentication. It closes the subprocesses it creates. Empty sessions in Codex 0.154 require explicit persistence: `thread/inject_items` writes the attributed initialization record to history, and the actual task prompt is queued separately after the creating process exits.

## Installation and one-command MCP setup

With Node.js 24+ and an authenticated Codex CLI ready, install from the public npm registry and register the MCP server:

```powershell
npm install -g @bakapiano/codex-cli-schedule --registry=https://registry.npmjs.org/
codex-schedule setup
```

Open a new Codex CLI session and use `/mcp` to check the `codex_schedule` connection. See [Adding the Codex MCP server](#adding-the-codex-mcp-server) for setup options.

For a one-off invocation:

```powershell
npx --yes --registry=https://registry.npmjs.org/ @bakapiano/codex-cli-schedule --help
```

### From source

```powershell
git clone https://github.com/bakapiano/codex-cli-schedule.git
cd codex-cli-schedule
npm ci
npm test
npm install -g .
```

You can also run directly from source:

```powershell
npm run build
node dist/src/cli.js --help
```

## Managing the daemon

```powershell
codex-schedule start
codex-schedule status
codex-schedule stop

# Choose a shared data directory and Codex executable
codex-schedule --home D:\codex-scheduler-data start --codex C:\path\to\codex.exe

# Run in the foreground for debugging
codex-schedule --home D:\codex-scheduler-data serve --port 47632
```

The default data directory is `%LOCALAPPDATA%\codex-cli-schedule` on Windows and `~/.local/share/codex-cli-schedule` on other systems. You can also set `CODEX_SCHEDULE_HOME`. To change the port or Codex executable, stop the existing daemon and start it with the new options.

Initial configuration generates a random token. The internal management API listens only on `127.0.0.1` and requires Bearer authentication. CLI and MCP clients read the local configuration automatically. Keep the data directory accessible only to trusted local users: `config.json` contains the token.

## CLI examples

Replace `<session-id>` with the session ID shown by Codex's `/status` command.

```powershell
# Deliver once at a specific time, including its UTC offset
codex-schedule create --name check-deployment --session <session-id> --at "2099-09-21T18:00:00+08:00" --prompt "Check deployment status and report back"

# Deliver every five minutes
codex-schedule create --name poll --session <session-id> --every 5m --prompt "Check task progress"

# Create a new session and queue a prompt every day at 09:00 in Shanghai
codex-schedule create --name daily --new --cwd D:\code\my-project --cron "0 9 * * *" --timezone Asia/Shanghai --prompt "Generate today's status summary"

codex-schedule list
codex-schedule get <schedule-id>
codex-schedule update <schedule-id> --pause
codex-schedule update <schedule-id> --prompt "Updated task instructions"
codex-schedule update <schedule-id> --every 10m --enable
codex-schedule runs <schedule-id>
codex-schedule delete <schedule-id>
```

For longer prompts, use `--prompt-file prompt.txt`. Both `create` and `update` accept `--json @schedule.json`, using the same data structure as the MCP inputs. Use `update --version N` for optimistic concurrency checks.

For a newly created session, find its `sessionId` in `runs`. Open it in a terminal with `codex resume <session-id>` to consume the queue. New sessions initially use read-only permissions and on-request approvals; the terminal user can adjust these as needed.

## Adding the Codex MCP server

Register the installed package with one command:

```powershell
codex-schedule setup
```

`setup` uses the official `codex mcp add` command and verifies the saved registration. It records the absolute paths of the current Node.js executable, this installation's JavaScript entry point, and the scheduler data directory. It works with Windows npm launchers and with macOS/Linux executables.

Repeated setup preserves a matching registration. An existing, different configuration with the same name is protected; choose a new name or explicitly replace it with `--force`. Other MCP server entries are preserved by the Codex CLI. After moving the installation or changing the Node.js executable, run `codex-schedule setup --force` to update the registered paths.

```powershell
# Preview the registration:
codex-schedule setup --dry-run

# With a specific shared data directory:
codex-schedule --home D:\codex-scheduler-data setup

# Choose a server name or a Codex CLI executable for registration:
codex-schedule setup --name my_scheduler --codex C:\path\to\codex.exe

# Explicitly replace a different registration under the same name:
codex-schedule setup --force

codex mcp list
```

Open a new Codex CLI session and use `/mcp` to inspect the connection, then create and manage schedules using natural language. Each CLI's MCP process is a lightweight client; the scheduler continues running in its own process. Registration itself updates only the MCP configuration; the daemon starts when the server or another management command is first used. Install the package globally before setup so the registered path remains available.

### MCP tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `schedule_create` | `name`, `prompt`, `trigger`, `target`, `enabled?` | Create a schedule |
| `schedule_list` | `{}` | List all schedules, including paused and completed ones |
| `schedule_get` | `id` | Read a schedule and its version |
| `schedule_update` | `id`, `patch`, `expectedVersion?` | Modify, pause, or re-enable a schedule |
| `schedule_delete` | `id` | Delete future scheduling while retaining delivery records |
| `schedule_runs` | `scheduleId?`, `limit?` | Inspect delivery results |
| `scheduler_status` | `{}` | Inspect daemon status |

```json
{
  "name": "check-status",
  "prompt": "Check deployment status and report back",
  "trigger": { "type": "every", "seconds": 300 },
  "target": { "type": "existing", "sessionId": "00000000-0000-4000-8000-000000000001" }
}
```

Other triggers: `{"type":"at","at":"2099-09-21T18:00:00+08:00"}` and `{"type":"cron","expression":"0 9 * * *","timezone":"Asia/Shanghai"}`.

A new-session target: `{"type":"new","cwd":"D:\\code\\my-project","model":"optional-model-name"}`.

## Delivery and recovery semantics

- The daemon checks for due schedules every 500 ms and dispatches them serially.
- After sleep or downtime, overdue one-time schedules fire once. Missed recurring occurrences are coalesced into one delivery before the next future occurrence is calculated.
- Updates and deletions affect future dispatches. Messages already delivered remain under the target session's queue management.
- Before dispatch, a transaction creates a run and advances the next scheduled time. Each run has a stable `clientUserMessageId`.
- If connection setup fails before dispatch is claimed, the schedule stays due for a later attempt.
- Explicit rejection is recorded as `failed`; an uncertain request outcome or interrupted dispatch is recorded as `unknown`. After inspecting the target queue, you can update the schedule time to arrange another delivery.
- `queued` records App Server acceptance. Model execution progress and replies are available in the target Codex session.
- If a later step fails after a new session has been created, its ID is retained in the run for troubleshooting.

Data files include `schedules.sqlite`, `config.json`, and `daemon.log`. Treat them as sensitive local data: they contain prompts, session IDs, and the management token.

## Development and testing

```powershell
npm ci
npm test
```

Automated tests cover timing and timezones, CRUD operations, persistence, single-instance ownership, recovery, the queue-only protocol, writer release for new sessions, and a real MCP stdio subprocess communicating with the daemon.

See [docs/e2e.md](docs/e2e.md) for the live Codex CLI test procedure (Chinese). Model calls use the current Codex authentication, and test prompts are limited to text acknowledgements.

## Publishing

Maintainers publish stable versions by creating a GitHub Release tagged `v<package-version>`. The publish workflow checks the version, runs tests on Windows and Linux, and publishes the built package to npm using trusted publishing. See [docs/publishing.md](docs/publishing.md) for first-release setup and the release checklist.
