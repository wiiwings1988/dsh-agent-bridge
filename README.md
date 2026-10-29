# dsh-agent-bridge

English | [中文](README.zh.md)

Use your **Claude Code** and **Codex** sessions inside **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (DSH). They appear in the DSH Workspace browser next to your DSH sessions, grouped under the same project folders. You can open them, keep talking, and pin, rename or archive them there.

> Unofficial community plugin. Not affiliated with DeepSeek, Anthropic or OpenAI.

## Features

- **One sidebar for all your agents.** Claude Code and Codex sessions are listed in the stock DSH Workspace browser under their project folder, with a small Claude or Codex mark on each row.
- **The stock row menu works on them.** Pin, Rename and Archive use DSH's own menu items, pin indicator and rename dialog. Pins and archives survive restarts.
- **Continue any session.** Opening a row shows the full transcript. You can send messages, stop a turn, answer permission prompts and questions, pick the model and reasoning effort, and attach images. Claude runs through the Claude Agent SDK and Codex through `codex app-server`, so the sessions stay compatible with the CLIs.
- **Start new sessions** in any folder, or clone a repository first.
- **Search the contents of every session.**
- **Workbench tabs** next to each conversation:
  - Terminal.
  - Files: browse, edit and upload.
  - Git: status, diff, branches, worktrees, and drafting commit messages.
  - Extensions: Claude MCP servers, skills and your global git identity.
  - Tasks: [TaskMaster](https://github.com/eyaltoledano/claude-task-master).
- **Scheduled follow-ups.** Send a message to a session at a set time.
- **Optional tools:**
  - Screen control through [Peekaboo](https://github.com/steipete/Peekaboo) (macOS).
  - A browser through [Playwright MCP](https://github.com/microsoft/playwright-mcp).
  - Voice dictation and read-aloud through any OpenAI-compatible speech endpoint.
  - Desktop notifications when a turn ends.
- **Safe fallback.** If a future DSH release changes the sidebar so the plugin cannot join it, the sessions move to a standalone "Claude / Codex" page instead of breaking the sidebar.

## Requirements

- DeepSeek Harness 0.2.x, desktop app or `dsh web`. It is tested with 0.2.1.
- Node.js 22.19 or newer. DSH ships its own Node.js.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and logged in.
- [Codex CLI](https://github.com/openai/codex) is optional. Without it, only Claude sessions are listed.
- Developed and tested on macOS. Linux should work; Windows is untested.

## Install

Choose the DSH profile you run. The desktop app uses `desktop`; `dsh web` uses `web`.

```sh
dsh plugin --profile desktop add github:wiiwings1988/dsh-agent-bridge
```

Restart DSH. The desktop app ships the `dsh` command at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` on macOS.

To uninstall, run `dsh plugin --profile desktop remove dsh-agent-bridge` and restart DSH.

## Configuration

Every option has a default, so no configuration is required. To change one, add an entry to your profile's `cordis.patch.yml`, for example `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: agent-bridge
  config:
    claudeExecutable: /path/to/claude
    codexEnabled: false
```

| Option | Default | Meaning |
|---|---|---|
| `claudeExecutable` | `claude` | Claude Code command or path. A bare name is looked up on `PATH`, then in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. |
| `codexEnabled` | `true` | List and run Codex sessions. |
| `codexExecutable` | `codex` | Codex command or path, looked up the same way. |
| `codexApprovalPolicy` | `untrusted` | `untrusted` or `on-request`. |
| `codexSandbox` | `workspace-write` | `read-only` or `workspace-write`. |
| `codexHistoryTurns` | `20` | How many recent Codex turns to load when a session is opened. |
| `permissionMode` | `default` | Claude permission mode: `default`, `acceptEdits` or `plan`. |
| `allowedTools` | `[]` | Claude tools that run without asking. |
| `sessionLimit` | `100` | Most recent sessions listed per engine. |
| `defaultCwd` | home folder | Folder for new sessions when none is chosen. |
| `memoryFile` | empty | A file appended to the system prompt of new Claude sessions, for example the `MEMORY.md` of a DSH memory plugin. |
| `computerUse` | `true` | Give Claude screen control through Peekaboo, if Peekaboo is installed. |
| `peekabooCommand` | `peekaboo` | Peekaboo command or path. |
| `browserUse` | `true` | Give Claude a Playwright browser. |
| `browserHeaded` | `false` | Show the browser window. |
| `voiceBaseUrl` | empty | OpenAI-compatible speech endpoint. Empty turns voice off. |
| `voiceApiKeyEnv` | `VOICE_API_KEY` | Name of the environment variable that holds the speech API key. |
| `voiceSttModel`, `voiceTtsModel`, `voiceTtsVoice` | `whisper-1`, `tts-1`, `alloy` | Speech models and voice. |
| `taskmasterCommand` | `npx` | Command used to run TaskMaster. |
| `watchIntervalMs` | `500` | How often an open transcript is checked for changes. |

## Data and privacy

- The plugin reads sessions where the CLIs keep them: `~/.claude` (or `CLAUDE_CONFIG_DIR`) and `~/.codex`. It never uploads them.
- Rename, fork and delete change the CLI's own session files, so the CLIs see the same result.
- Pins, archives, drafts and scheduled messages are stored in `~/.dsh/agent-bridge/state.json`.
- The terminal, file and git tabs act on your machine with your user's rights. They are served only to the DSH UI, behind DSH's own login token.
- Voice sends audio and text only to the speech endpoint you configure.

## Development

The build reuses the DSH client bundle preset and type definitions, so it needs a DeepSeek Harness source checkout. Clone this repository three folder levels below the checkout root:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh
cd dsh && pnpm install && pnpm run build:artifacts
git clone https://github.com/wiiwings1988/dsh-agent-bridge.git local/plugins/dsh-agent-bridge
cd local/plugins/dsh-agent-bridge && pnpm install
pnpm run typecheck && pnpm run build
```

- **Run your build:** `dsh plugin --profile web add link:$PWD` installs the working copy into a profile.
- **Unit tests:** run one file at a time, for example `node --import tsx/esm --test tests/graft.test.mjs`.
- **End-to-end tests:** `tests/e2e*.mjs` drive a running `dsh web` instance with Playwright. Pass the instance through `DEV_BASE` (URL) and `DEV_HOME` (its `DSH_HOME`). `tests/fixtures` holds stand-ins for the Claude and Codex executables.

`lib/` is committed, so installing from GitHub needs no build step. Rebuild it before committing source changes.

## License

[MIT](LICENSE)
