> Levantamento feito em 17/10/2026 por um agente de pesquisa, a partir da documentação oficial do Claude Code.
> Itens marcados **VERIFY** não foram confirmados e precisam ser validados na prática antes de virar premissa do design.
> Caminhos da máquina do usuário foram trocados por marcadores genéricos: `%USERPROFILE%` ou `~` (pasta pessoal), `<repo>` (caminho do repositório, que fica dentro do OneDrive), `<project>` e `<outro-projeto>` (pastas de projeto em `~/.claude/projects/`), `<session-id>` e `<agent-id>`.

# Agent Quest: Claude Code hooks, subagents, and telemetry (checked 2026-10-17)

Field names are taken from the docs pages listed at the end. Items marked **VERIFY** are not confirmed word for word by the docs, or may depend on the build. Part of the long hooks reference was read through a summarizing fetch, so those details are flagged too.

## Bottom line

1. **Attribution works in hooks.** Tool events from inside a subagent carry `agent_id` (one per subagent instance) and `agent_type` (the agent's frontmatter `name`, e.g. `arquiteto`). The docs say these appear "when relevant" and show no PreToolUse example. **VERIFY** with the test in section 10.
2. **The spawn link is the PostToolUse of the Agent call:** `tool_response.agentId`, matched by `tool_use_id`. SubagentStart and SubagentStop carry no `tool_use_id`. Child tool events carry their own `tool_use_id`, so `agent_id` is the bridge.
3. **No hook reports a user approving or denying a prompt** in default mode. Use OTel `claude_code.tool_decision` (`decision`, `source`), or infer from the event sequence (section 4).
4. **Forwarding (my recommendation):** `"type": "http"` with `"timeout": 1` or `2` and a `204` reply has the least overhead. SessionStart and Setup do not support http, so use `"type": "command"` with `"async": true` there.
5. **Usage:** status line JSON (documented fields) gives the main session's context and cost. OTel `api_request` gives per-request tokens and cost. The transcript's `message.usage` exists, but the docs call the transcript format internal.

## 1. Hook events (33)

| Event | Fires when | Can change behavior |
|---|---|---|
| SessionStart | session starts or resumes; `source` = startup, resume, clear, compact, fork | context only; `command` and `mcp_tool` only |
| Setup | `claude --init-only`, or `--init` / `--maintenance` with `-p` | no |
| UserPromptSubmit | prompt submitted, before processing; also scheduled tasks, `/loop` iterations, background subagent reports, messages from other sessions | block |
| UserPromptExpansion | a typed command expands into a prompt | block |
| PreToolUse | before a tool call, and before any permission-mode check | allow / deny / ask / defer; `updatedInput` |
| PermissionRequest | a call needs a permission decision (about to prompt) | allow / deny via `decision` |
| PermissionDenied | auto mode denies a call | retry only |
| PostToolUse | after a tool call succeeds | feedback only; cannot undo |
| PostToolUseFailure | after a tool call fails (not when cancelled) | feedback only |
| PostToolBatch | after a batch of parallel tool calls resolves, before the next model call | block / continue |
| Notification | Claude Code sends a notification (`notification_type`) | no |
| MessageDisplay | assistant text is displayed (synchronous, 10 s default timeout) | display only |
| SubagentStart | a subagent starts (also on resume) | context only |
| SubagentStop | a subagent finishes | continues it |
| TaskCreated | a task is created | block |
| TaskCompleted | a task is marked completed | block |
| Stop | Claude finishes responding (does not fire on user interrupts) | continue |
| StopFailure | turn ends on an API error | no |
| TeammateIdle | agent-team teammate about to go idle | continue / stop |
| InstructionsLoaded | CLAUDE.md or `.claude/rules/*.md` loaded | no |
| ConfigChange | settings or skill file changes | block (not for policy_settings) |
| CwdChanged | working directory changes | no |
| DirectoryAdded | `/add-dir` or SDK `register_repo_root` | no |
| FileChanged | watched file changes on disk | no |
| WorktreeCreate | worktree created | replaces default creation |
| WorktreeRemove | hook-created worktree removed | no |
| PreCompact | before compaction (manual or auto) | block |
| PostCompact | after compaction | no |
| PreModelSwitch | before a requested model switch (v2.1.251+) | block |
| PostModelSwitch | after the model changes (v2.1.251+) | context only |
| Elicitation | MCP server asks for user input | can answer it |
| ElicitationResult | after the user answers an MCP elicitation | can modify it |
| SessionEnd | session ends (`reason`) | no; 1.5 s shared budget |

Cadence: SessionStart and SessionEnd once per session; UserPromptSubmit, Stop, StopFailure once per turn; PreToolUse and PostToolUse on every tool call (except EndConversation).

## 2. Stdin payload

**Common fields (every event; http hooks receive the same JSON as the POST body):**
- `session_id`
- `prompt_id`: UUID of the current prompt; equals `prompt.id` on OTel events; absent before the first input
- `transcript_path`: written asynchronously, so it can lag the current turn
- `cwd`
- `scratchpad_dir` (v2.1.257+; may be absent)
- `permission_mode`: `default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions` (manual arrives as `default`; not every event has it)
- `effort`: `{"level": "low"|"medium"|"high"|"xhigh"|"max"}` on tool events, Stop, SubagentStop when the model supports it
- `hook_event_name`
- `agent_id`, `agent_type`: only when relevant (section 3)

**Per-event fields (beyond the common ones):**

| Event | Fields |
|---|---|
| SessionStart | `source`, `model` (may be absent), `agent_type`, `session_title`; on resume/fork with a prior response (v2.1.251+): `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` |
| Setup | `trigger` (`init` / `maintenance`) |
| UserPromptSubmit | `prompt`, `session_title` (only with a custom title) |
| UserPromptExpansion | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id`; `mcp_server` {`name`, `source`} for MCP tools |
| PermissionRequest | `tool_name`, `tool_input`, `permission_suggestions` (optional), `mcp_server` (MCP only). **No `tool_use_id`** |
| PermissionDenied | `tool_name`, `tool_input`, `tool_use_id`, `reason`, `mcp_server` |
| PostToolUse | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` (optional), `mcp_server` |
| PostToolUseFailure | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt` (optional), `duration_ms` (optional), `mcp_server` |
| PostToolBatch | `tool_calls[]`, each with `tool_name`, `tool_input`, `tool_use_id`, `tool_response` |
| Notification | `message`, `title` (optional), `notification_type` |
| SubagentStart | `agent_id`, `agent_type` |
| SubagentStop | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]` |
| Stop | `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]` |
| StopFailure | `error` (rate_limit, overloaded, authentication_failed, ..., unknown), `error_details`, `last_assistant_message` (holds the API error text) |
| TaskCreated / TaskCompleted | `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name` (deprecated), `agent_id` (v2.1.290+, may be absent) |
| TeammateIdle | `teammate_name`, `team_name` |
| InstructionsLoaded | `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path`, `parent_file_path` |
| ConfigChange | `source` (`user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`), `file_path` |
| CwdChanged | `old_cwd`, `new_cwd` |
| DirectoryAdded | `directory`, `source` |
| FileChanged | `file_path`, `event` (`change`, `add`, `unlink`) |
| WorktreeCreate / WorktreeRemove | `name` / `worktree_path` |
| PreCompact / PostCompact | `trigger` (`manual` / `auto`); `custom_instructions` / `compact_summary` |
| PreModelSwitch / PostModelSwitch | `from_model`, `to_model`, `requested_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing` |
| Elicitation / ElicitationResult | `mcp_server_name`, `message`, `mode`, `url`, `elicitation_id`, `requested_schema` / `action`, `content` |
| SessionEnd | `reason` (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`) |

**`tool_input`** by tool: Bash/PowerShell `command`, `description`, `timeout`, `run_in_background`; Write `file_path`, `content`; Edit `file_path`, `old_string`, `new_string`, `replace_all`; Read `file_path`, `offset`, `limit`; Agent `prompt`, `description`, `subagent_type`, `model`. On Windows, `file_path` is absolute with backslashes.

**`tool_response`** (PostToolUse): Bash `stdout`, `stderr`, `interrupted`, `isImage`. Agent in foreground: `status: "completed"`, `agentId`, `content`, `resolvedModel`, `modelsUsed`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage` {`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`}. Agent in background: `status: "async_launched"`, `agentId`, `description`, `prompt`, `outputFile`, `resolvedModel`. Note camelCase `agentId` inside `tool_response` versus snake_case `agent_id` at the top level.

**`notification_type` values:** permission_prompt, idle_prompt, auth_success, elicitation_dialog, elicitation_url_dialog, elicitation_complete, elicitation_response, agent_needs_input, agent_completed, quota_auto_resume_fired, quota_auto_resume_stale, quota_auto_resume_disabled. The meaning of the last few is not described on the pages I read.

## 3. Subagent attribution

**a. Identity.** Subagents are Markdown files in `.claude/agents/` (project) or `~/.claude/agents/` (user). The frontmatter `name` becomes `agent_type`. Your five files in `<repo>\.claude\agents\` (arquiteto, dev-backend, dev-frontend, tester, documentador) each have a `name` equal to the file name, so `agent_type` will be exactly those strings. Built-in types include `general-purpose`, `Explore`, `Plan`. The main session has no `agent_id`, and it has an `agent_type` only when started with `--agent`.

**b. Coverage.** Hooks from settings files, managed policy, and plugins also fire inside subagents. PreToolUse and PostToolUse fire for subagent tool calls the same way they do in the main conversation. So one global hook in `~/.claude/settings.json` sees every subagent's tool calls without per-agent config. Frontmatter `hooks` run only while their subagent runs. SubagentStart and SubagentStop are configured in settings files, not in frontmatter.

**c. Identification.** Subagent events carry `agent_id` (unique per subagent; also the basename of its transcript file) and `agent_type`. Treat "no `agent_id`" as the orchestrator. Do not use `agent_type` for that test, because it is also set for `--agent` sessions. **VERIFY** that PreToolUse and PostToolUse include `agent_id` in practice.

**d. SubagentStart / SubagentStop.**
- SubagentStart: `agent_id`, `agent_type`. Fires at spawn, on resume, and for each new message to an in-process teammate. Cannot block.
- SubagentStop: `agent_id`, `agent_type`, `agent_transcript_path` (`~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`), `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]`. `transcript_path` still points to the main session's transcript.
- Internal agents (prompt suggestions, `/btw`) also fire SubagentStop, with `agent_type` set to the session agent's name or `""`. Filter these out.

**e. Linking an Agent call to its subagent.**
1. PreToolUse with `tool_name: "Agent"` (named `Task` before v2.1.63; settings aliases still work) gives `tool_use_id` X and `tool_input.subagent_type` / `description`.
2. PostToolUse with the same `tool_use_id` X gives `tool_response.agentId` = A. For a foreground subagent it arrives when the subagent finishes. For a background one (`status: "async_launched"`) it arrives at launch, so you learn A immediately.
3. Every later event with `agent_id` = A belongs to that subagent.

Before step 2, you can only match heuristically. SubagentStart gives `agent_id` and `agent_type` but no `tool_use_id`, so match it to the pending Agent call with the same `subagent_type` and the nearest time. That is ambiguous when two subagents of the same type start together. PostToolBatch's `tool_calls[]` lists every `tool_use_id` and its `tool_response` for a parallel batch, which resolves several Agent calls at once. Outside hooks, stream-json output carries `parent_tool_use_id` on subagent messages (section 9.4), and transcripts name subagent files by `agentId` (section 8).

**f. Parallel and background.**
- Key all state by `agent_id`. Parallel hooks interleave, and hook payloads have no sequence number, so stamp arrival time on your server.
- Matching hooks run in parallel, so ordering across hooks is not guaranteed.
- Background subagents surface their permission prompts in the main session, naming the subagent asking. They keep MCP tools plus a fixed built-in list: Read, Grep, Glob, LSP, Bash, PowerShell, Edit, Write, NotebookEdit, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch, EnterWorktree, ExitWorktree, Monitor, TaskStop, SendMessage, Artifact.
- The main session's Stop can fire while background subagents still run. Stop and SubagentStop list them in `background_tasks[]` (`id`, `type`, `status`, `description`, and `agent_type` for subagents).
- A background subagent's report comes back as a new turn, so UserPromptSubmit fires. Do not count it as user input.
- Limits: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20); `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3, v2.1.219+).

**g. Not documented (treat as unknown):** whether a nested subagent's events name its parent; whether SubagentStart carries the spawning `tool_use_id`; whether `background_tasks[].id` equals `agentId`.

## 4. Permission prompts

- **Waiting for permission:** the hook that fires when the prompt is about to be shown is **PermissionRequest**. Its input is `tool_name`, `tool_input`, `permission_suggestions` (optional), and `mcp_server` (MCP only). It has no `tool_use_id`. The user-facing notice is **Notification** with `notification_type: "permission_prompt"**, which fires about six seconds after the prompt appears if you have not typed (reference text; **VERIFY**). `idle_prompt` fires about 60 seconds after Claude finishes, if you have not typed and no background agent is running.
- **Observer rule:** PermissionRequest decisions are `hookSpecificOutput.decision.behavior` = `allow` or `deny`. Exit 2 changes nothing here. Your observer must print nothing, because any decision changes the outcome. Supported types: command, http, mcp_tool, prompt (not agent).
- **Sequence for a call that needs approval:** PreToolUse (has `tool_use_id`), then PermissionRequest, then the user decides, then PostToolUse (ran) or PostToolUseFailure (ran and failed). PreToolUse fires before any permission-mode check, in every mode including `dontAsk`. So you can match PermissionRequest to its PreToolUse by `tool_name` plus `tool_input` (heuristic).
- **Approve or deny:** no dedicated event in default mode.
  - PermissionDenied fires only for auto-mode denials.
  - A rejected call never runs, so no PostToolUse follows. Whether a rejection also fires PostToolUseFailure is not documented; test it.
  - OTel `claude_code.tool_decision` has `decision` (`accept` / `reject`), `source`, `tool_name`, `tool_use_id`, and `tool_source`. `source` values: `config` (automatic: rules, flags, permission mode, or a session grant), `hook`, `user_temporary` ("Yes"), `user_permanent` ("Yes, and don't ask again"), `user_reject` ("No"), `user_abort` (dismissed). In the interactive CLI, `user_*` appears only for that one choice; later matching calls show `config`.
- Background subagents: whether their PermissionRequest includes `agent_id` is not documented.

## 5. Hook types, timeouts, exit codes, async, forwarding

| type | What it does | Default timeout | Async | Events |
|---|---|---|---|---|
| command | runs a command; JSON on stdin | 600 s | `async`, `asyncRewake` | all 33 |
| http | POSTs the same JSON to `url` | 600 s | no | all except SessionStart, Setup |
| mcp_tool | calls a tool on a configured MCP server | 600 s | no | all |
| prompt | one model call returning `{ok, reason}` | 30 s | no | subset |
| agent | subagent verifier (experimental) | 60 s | no | subset |

`timeout` is in seconds. Defaults drop to 30 s on UserPromptSubmit, PreModelSwitch, and PostModelSwitch, and to 10 s on MessageDisplay. SessionEnd hooks share a 1.5 s budget, which rises to match a per-hook `timeout` (up to 60 s).

**Exit codes (command hooks):**
- **0:** success. Stdout is parsed as JSON only if the whole output is one JSON object. Plain stdout becomes model context only on UserPromptSubmit, UserPromptExpansion, SessionStart, and PostModelSwitch.
- **2:** blocking on PreToolUse, UserPromptSubmit, UserPromptExpansion, PostToolBatch, Stop, SubagentStop, TeammateIdle, TaskCreated, TaskCompleted, ConfigChange (not policy_settings), PreCompact, PreModelSwitch, Elicitation, ElicitationResult. Stderr goes to Claude as the reason. No effect on PermissionRequest. On PostToolUse the tool has already run.
- **Any other code:** non-blocking error, shown as `<hook name> hook error`. The action proceeds unless `"onFailure": "block"` is set (v2.1.295+; command and http only).

**What blocks the agent:** synchronous hooks. The hooks guide says, "By default, hooks block Claude's execution until they complete." A slow command or http hook holds the event until it exits or replies, up to its timeout. A timed-out PreToolUse hook does not block the call unless `onFailure` is `block`.

**Async (command only):** `"async": true` returns at once. No timeout is enforced. Decision fields are ignored. `additionalContext` and `systemMessage` reach Claude on a later turn. Each run is a separate process. In `-p` mode, still-running async hooks are killed at exit. If a hook prints JSON and then starts background work, redirect that work's stdout and stderr, or Claude Code blocks the call ("refusing to honor the suspect capture").

**HTTP hooks:** the body is the stdin JSON with `Content-Type: application/json`. `headers` resolve `$VAR` or `${VAR}` only for names listed in `allowedEnvVars`. `onFailure` is supported. A 2xx response with a JSON body is parsed like command output. Any other status, or a failed request, is a non-blocking error. The reference text says a 2xx with an empty body counts as success (exit 0 equivalent); **VERIFY**. `allowedHttpHookUrls` restricts URLs once it is defined at any settings level. `httpHookAllowedEnvVars` restricts header variables.

**Parallelism:** all hooks matching an event run in parallel, and results merge after all finish. For PreToolUse the most restrictive answer wins (deny, defer, ask, allow).

**Recommended forwarder (my recommendation from these semantics; the docs do not prescribe one):**
- Use **http** for every event except SessionStart and Setup. There is no process per event and no shell or quoting. Set `timeout` to 1 or 2 seconds. The handler replies `204` immediately and queues work in memory. Leave `onFailure` unset. Each tool call costs two loopback requests (Pre and Post).
  - If the server is down, each event becomes a non-blocking error, which may appear in the transcript.
  - If the server accepts connections but never replies, each event waits up to `timeout`.
- **SessionStart:** `command` in exec form with `async: true`. The script POSTs with a short timeout, swallows errors, prints nothing, and exits 0.
- Never print JSON or exit 2 from the observer. On UserPromptSubmit and SessionStart, stdout becomes model context.
- SessionEnd: a 2-second per-hook timeout raises the shared budget to 2 seconds, so exit can wait that long. Use 1 second if you want exit faster.

Sample `~/.claude/settings.json` (you write `forward.mjs`; `%USERPROFILE%` stands for the absolute path of your home folder, written out in full, because exec form runs no shell):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node", "args": ["%USERPROFILE%/.claude/agent-quest/forward.mjs"], "async": true } ] }
    ],
    "PreToolUse": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:7777/hooks", "timeout": 2 } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:7777/hooks", "timeout": 2 } ] }
    ]
  }
}
```

Repeat the http entry for SubagentStart, SubagentStop, Stop, StopFailure, PostToolUseFailure, PermissionRequest, Notification, UserPromptSubmit, PreCompact, PostCompact, and SessionEnd. Omitting `matcher` means every occurrence.

## 6. Windows

- **Shell:** `"shell": "bash"` is the default, meaning Git Bash. `"shell": "powershell"` uses `pwsh.exe` if present, otherwise `powershell.exe` (5.1). `shell` is ignored when `args` is set. The reference text says the default falls back to PowerShell when Git Bash is missing, but it also documents a failure: "blocking because Git Bash wasn't found..." for a shell-form PreToolUse or PermissionRequest hook. Exec form avoids both, because it spawns the program directly with no shell.
- **Exec form:** `command` must be a real executable. `node` is fine. npm `.cmd` shims such as `npx` cannot be spawned, so run scripts through `node`. Use the absolute path to `node.exe` if your terminal's PATH differs from the one that launches Claude Code.
- **Environment:** `CLAUDE_PROJECT_DIR` (the root where the session started; stays fixed in a worktree), `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`. Both forms export them, and the `${...}` placeholders work in both forms.
- **PowerShell shell form:** write `${CLAUDE_PROJECT_DIR}` or `$env:CLAUDE_PROJECT_DIR`. A bare `$CLAUDE_PROJECT_DIR` is parsed as an undefined variable and becomes `$null`. Single quotes block expansion.
- **Git Bash shell form:** `"$CLAUDE_PROJECT_DIR/..."` works because the variable is exported. Keep the double quotes.
- **Global hooks:** `${CLAUDE_PROJECT_DIR}` is the project where each session started, so a user-level observer needs an absolute path. Use forward slashes in JSON (`C:/Users/...`) to avoid escaping.
- There is no `/dev/tty` on Windows; use `terminalSequence` for terminal output.

**Your command** `node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-quest.mjs"` works as shell form under Git Bash, but it depends on Git Bash and only works per project. For a project-level hook, use exec form:

```json
{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-quest.mjs"], "async": true }
```

My suggestion: your repo sits under OneDrive (`%USERPROFILE%\OneDrive\...`). Keep the observer script outside OneDrive, for example in `%USERPROFILE%\.claude\agent-quest\`, so it is not an online-only file that stalls on first run.

## 7. Where hooks live

| Location | Scope | Shared |
|---|---|---|
| `~/.claude/settings.json` | every project | no |
| `.claude/settings.json` | this project | yes (committed) |
| `.claude/settings.local.json` | this project | no (gitignored when Claude Code saves to it) |
| Managed policy settings | organization | admin-controlled |
| Plugin `hooks/hooks.json` | while the plugin is enabled | yes |
| Skill frontmatter | rest of the session after the skill runs | yes |
| Subagent frontmatter | while that subagent runs | yes |

- **Any project:** `~/.claude/settings.json`. It fires in every project, including inside all subagents. Two limits: in interactive sessions Claude Code holds back hooks from every settings file, including this one, until you accept the workspace trust dialog for that folder; and `--bare` skips hook discovery entirely. `-p` and SDK sessions have no trust dialog.
- **This project only:** `.claude/settings.json` (shared) or `.claude/settings.local.json` (personal).
- **Distribution:** a plugin with `hooks/hooks.json` and `${CLAUDE_PLUGIN_ROOT}`.
- **Not suitable for global monitoring:** subagent frontmatter (repeated per agent; plugin subagents ignore it). SubagentStart and SubagentStop must live in settings.
- `/hooks` lists all configured hooks. `"disableAllHooks": true` in any settings file turns off hooks and the status line. Edits are picked up by the file watcher without a restart.
- **Current state here:** `~/.claude/settings.json` has no `hooks`, `statusLine`, or telemetry keys, and `<repo>\.claude\` has no `settings.json`.

## 8. Transcripts

- **Path:** `~/.claude/projects/<project>/<session-id>.jsonl`. `<project>` is the working directory with non-alphanumeric characters replaced by `-` (over 200 characters: truncated plus a hash). On this machine: `%USERPROFILE%\.claude\projects\<project>\<session-id>.jsonl`, where `<project>` is the repo path with `:` and `\` turned into `-` (it starts with `c--Users-` and includes the OneDrive folder). The drive-letter case differs between your projects (`c--` and `C--`), so take `transcript_path` from the payloads rather than rebuilding it.
- **Subagents:** `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`. Example here: `%USERPROFILE%\.claude\projects\<project>\<session-id>\subagents\agent-<agent-id>.jsonl`. SubagentStop's `agent_transcript_path` gives the exact path.
- **Format:** one JSON object per line. The sessions page says the entry format "is internal to Claude Code and changes between versions." In a subagent file on this machine, from another project (`%USERPROFILE%\.claude\projects\<outro-projeto>\<session-id>\subagents\agent-<agent-id>.jsonl`), I observed these keys, which are not documented: `type`, `uuid`, `parentUuid`, `sessionId` (the parent session's id), `agentId`, `isSidechain: true`, `timestamp`, `version` (2.1.278). Assistant entries carry `message.model` and `message.usage` with `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `cache_creation` {`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`}.
- **Usage:** `message.usage` per assistant entry is where token counts sit in the file. The docs do not promise that. Documented alternatives are in section 9.
- The monitoring page says assistant entries carry `requestId`, which matches OTel `request_id`, and warns that joins on these fields can break between releases.
- Writes are asynchronous. Read the file lazily, not inside a hook.
- Retention: `cleanupPeriodDays`, 30 days by default. Subagent files are removed with their session.

## 9. Alternatives and complements

**9.1 OpenTelemetry** (monitoring page). A local OTLP endpoint is supported.
- **Enable:** `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp` (events export only when this is set), `OTEL_EXPORTER_OTLP_PROTOCOL` (`grpc`, `http/json`, or `http/protobuf`; no default), and `OTEL_EXPORTER_OTLP_ENDPOINT` (the docs use localhost examples; `http://127.0.0.1:4318` should also work). Set them in `~/.claude/settings.json` (its `env` key) or in your shell. The docs say `.claude/settings.json` and `.claude/settings.local.json` are ignored for exporter variables.
- **Intervals:** events 5 s (`OTEL_LOGS_EXPORT_INTERVAL`), metrics 60 s (`OTEL_METRIC_EXPORT_INTERVAL`), traces 5 s. Export runs inside the CLI process, not in the hook path.
- **Events** (each logged when it happens):
  - `claude_code.api_request`: `model`, `cost_usd`, `duration_ms`, `input_tokens` (excludes cache), `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`, `speed`, `query_source` (`main`, `subagent`, `auxiliary`), `effort`.
  - `claude_code.tool_result`: `tool_name`, `tool_use_id`, `success`, `duration_ms`, `decision_source`, `tool_input_size_bytes`, `tool_result_size_bytes`. Not emitted for rejected calls.
  - `claude_code.tool_decision`: see section 4.
  - `claude_code.subagent_completed`: `agent_type`, `agent.source`, `is_async`, `total_tokens` (final request only, per the docs), `total_tool_uses`, `duration_ms`, `model`, `final_model`, `model_swapped`.
  - `claude_code.hook_execution_start` and `claude_code.hook_execution_complete`: `hook_event`, `hook_name`, `num_hooks`, `num_success`, `num_blocking`, `num_non_blocking_error`, `num_cancelled`, `total_duration_ms`. Use these to prove the observer adds no latency.
  - `claude_code.hook_registered`: `hook_event`, `hook_type`, `hook_source`.
  - Also: `claude_code.user_prompt`, `claude_code.compaction`, `claude_code.api_error`, `claude_code.permission_mode_changed`.
- **Metrics:** `claude_code.cost.usage` (USD) and `claude_code.token.usage` (`type`: `input`, `output`, `cacheRead`, `cacheCreation`), both split by `model` and `query_source`; also `claude_code.session.count`, `claude_code.active_time.total`, `claude_code.code_edit_tool.decision`.
- **Identifiers:** `session.id`, `prompt.id` (events only), `organization.id`, `user.account_uuid`, `tool_use_id`, `request_id`, `query_source`. Events do not carry `agent_id`. It appears only on beta trace spans (`claude_code.llm_request`, `claude_code.tool`). So OTel alone cannot tell two subagents of the same type apart. Hooks can.
- **Names:** agent names appear as `custom` for user-defined agents unless `OTEL_LOG_TOOL_DETAILS=1`, which also logs tool parameters and Bash commands. Hooks show real names regardless.

**9.2 Status line** (statusline page). A `statusLine` setting `{"type": "command", "command": "...", "padding": 0, "refreshInterval": N}` runs your command with JSON on stdin. It runs locally and uses no API tokens. Fields: `session_id`, `session_name`, `prompt_id`, `transcript_path`, `cwd`, `model.id`, `model.display_name`, `workspace.project_dir`, `version`, `cost.total_cost_usd` (list-price estimate unless `modelPricing` is set), `cost.total_duration_ms`, `cost.total_api_duration_ms`, `context_window.context_window_size` (200000, or 1000000 for extended context), `context_window.total_input_tokens`, `context_window.total_output_tokens`, `context_window.used_percentage` (input side only: input + cache creation + cache read), `context_window.remaining_percentage`, `context_window.current_usage` (`null` before the first call and after `/compact`), `exceeds_200k_tokens`, `effort.level`, `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage`, `prompt_cache`, `agent.name` (with `--agent`). It runs at session start, after each assistant message, after `/compact`, on permission-mode change, and on `refreshInterval`. Updates are debounced by 300 ms, and a new trigger cancels the running script. The page does not say whether `context_window` also reflects subagent API calls (**VERIFY**). `prompt_cache` is documented for the main conversation.

**9.3 subagentStatusLine** (statusline page, "Subagent status lines"). This command runs once per refresh tick and receives all visible subagent rows as one JSON object (`columns`, `tasks[]`). Each task has `id`, `name`, `type` (`local_agent`), `agentType` (v2.1.293+; the same value as hook `agent_type`), `status` (`running`, `completed`, `failed`, `killed`), `description`, `label`, `startTime` (ms epoch), `model`, `effort`, `contextWindowSize`, `tokenCount` (running count), `tokenSamples` (last 16 readings), and `cwd`. It is a display feature limited to visible rows. How `id` relates to `agent_id` is not documented.

**9.4 Headless stream-json** (headless page). With `claude -p --output-format stream-json`, each subagent message carries `parent_tool_use_id` set to the Agent `tool_use` id; main-conversation messages carry `null`. Tool use and results are forwarded by default. `--forward-subagent-text` (or `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`, v2.1.211+) adds text and thinking. Nested subagents are included from v2.1.219+. This is the cleanest link, but it applies only to non-interactive runs.

**9.5 Totals on the Agent result.** A foreground Agent PostToolUse carries `tool_response.totalTokens`, `totalDurationMs`, `totalToolUseCount`, and `usage` (section 2).

**Join keys:**

| Source | Key | Matches |
|---|---|---|
| hooks | `session_id` | OTel `session.id`; status line `session_id` |
| hooks | `prompt_id` | OTel `prompt.id`; status line `prompt_id` |
| hooks Pre/PostToolUse | `tool_use_id` | OTel `tool_result` and `tool_decision` `tool_use_id` |
| OTel `api_request` | `request_id` | transcript `requestId` (internal format) |
| hooks | `agent_id` | transcript `agentId` in subagent files (observed); no OTel event carries it |

**Suggested combination:** hooks for live state and attribution; status line for the main session's context and cost; OTel for per-request tokens and cost, approvals, and hook latency; transcripts only if you accept an internal format.

## 10. Unverified or version-dependent, and how to check

**Not confirmed by the docs, or may vary:**
1. `agent_id` and `agent_type` on PreToolUse and PostToolUse inside subagents (documented as "when relevant").
2. Whether a rejected call fires PostToolUseFailure.
3. Whether PermissionRequest and Notification carry `agent_id` for background subagent prompts.
4. Whether SubagentStart carries a `tool_use_id`, and whether nested subagents identify their parent.
5. Whether `background_tasks[].id` and subagentStatusLine task `id` equal `agentId`.
6. Whether a 2xx with an empty body counts as success for http hooks (the reference text says so).
7. The Notification timings (about 6 s and 60 s) come from the reference text.
8. The Windows default shell: the docs read two ways. Exec form avoids the question.
9. Ordering across parallel hook deliveries (no sequence number documented).
10. Transcript fields (observed, not a stable contract).
11. Whether the status line `context_window` reflects subagent API calls.
12. **Versions.** Your subagent transcripts were written by Claude Code 2.1.278 (2026-09-22). Run `claude --version`. Features above that need newer builds: `onFailure` and multi-line async JSON (2.1.295), hook timing log lines (2.1.296), subagentStatusLine `agentType` (2.1.293), TaskCreated `agent_id` (2.1.290), SubagentHandback (2.1.271), `scratchpad_dir` (2.1.257), PreModelSwitch and PostModelSwitch (2.1.251), hook telemetry `stdout_chars` (2.1.280).

**Test (about 5 minutes):** add a dump hook for PreToolUse, PostToolUse, PermissionRequest, SubagentStart, SubagentStop, and Stop in `~/.claude/settings.json`:

```json
{ "type": "command", "command": "node", "args": ["%USERPROFILE%/.claude/agent-quest/dump.mjs"], "async": true }
```

`dump.mjs`:

```js
import { appendFileSync } from "node:fs";
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  appendFileSync("%USERPROFILE%/.claude/agent-quest/events.jsonl", // use the absolute path
    JSON.stringify({ received: Date.now(), ...JSON.parse(raw) }) + "\n");
});
```

Accept the workspace trust dialog if asked. Then have `dev-backend` run a Bash command, and reject one permission prompt. In `events.jsonl`, check for `agent_id` on subagent tool events, `tool_response.agentId` on the Agent PostToolUse, and which events fire after the rejection. If `agent_id` is missing from tool events on your build, report it with `/feedback`. Use `claude --debug-file <path>` to see hook timing, and `/hooks` to confirm what is registered.

## Docs used

- Hooks reference: https://code.claude.com/docs/en/hooks (event list, common and per-event fields, timeouts, exit codes, Windows, subagent fields)
- Hooks guide: https://code.claude.com/docs/en/hooks-guide (configure hook location, matchers, combining results, async, HTTP hooks, workspace trust, permission modes, Windows PowerShell)
- Subagents: https://code.claude.com/docs/en/sub-agents (definitions, Agent tool, foreground and background, transcript storage, frontmatter hooks, SubagentStart/Stop)
- Settings reference: https://code.claude.com/docs/en/settings-reference (hook-related settings, `disableAllHooks`, `allowedHttpHookUrls`, `env`)
- Status line: https://code.claude.com/docs/en/statusline (available data, update triggers, subagent status lines)
- Monitoring and OpenTelemetry: https://code.claude.com/docs/en/monitoring-usage (metrics, events, attributes, exporter variables)
- Sessions and transcripts: https://code.claude.com/docs/en/sessions (transcript path, project directory naming, retention)
- Headless / stream-json: https://code.claude.com/docs/en/headless (`parent_tool_use_id`, `--bare`, background tasks)
- Docs map and index: https://code.claude.com/docs/en/claude_code_docs_map.md and https://code.claude.com/docs/llms.txt

The Agent SDK pages were not needed for CLI hooks.

## Local files checked

- `~/.claude/settings.json`: no `hooks`, `statusLine`, or telemetry keys.
- `<repo>\.claude\agents\` (arquiteto.md, dev-backend.md, dev-frontend.md, tester.md, documentador.md): each `name` matches its file name, and none sets frontmatter `hooks`.
- Subagent transcript examples are listed in section 8.
