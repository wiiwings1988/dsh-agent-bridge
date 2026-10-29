/** Wire constants and payload shapes shared by the Host and browser halves. */

/** Settings namespace and `settings.plugin.item` card key. */
export const NAMESPACE = 'agent-bridge'

/** Main-panel key; also the identity of the panel the session rows open. */
export const PANEL_ID = 'agent-bridge'

/** Authenticated route listing the session rows. */
export const SESSIONS_PATH = '/api/agent-bridge/sessions'

/** Authenticated route returning one session's messages (`?id=`). */
export const SESSION_PATH = '/api/agent-bridge/session'

/** Authenticated Server-Sent Events route announcing writes to one session's file (`?id=`). */
export const WATCH_PATH = '/api/agent-bridge/watch'

/** Authenticated POST route starting a turn (`{id?, cwd?, text}`); a missing id creates a session. */
export const SEND_PATH = '/api/agent-bridge/send'

/** Authenticated POST route answering a pending permission or question. */
export const ANSWER_PATH = '/api/agent-bridge/answer'

/** Authenticated POST route interrupting the running turn (`{id}`). */
export const INTERRUPT_PATH = '/api/agent-bridge/interrupt'

/** Authenticated POST route managing a stored session (`{id, action, title?}`). */
export const MANAGE_PATH = '/api/agent-bridge/manage'

/** Authenticated route returning the screen-control permission status. */
export const SCREEN_STATUS_PATH = '/api/agent-bridge/screen-status'

/** Authenticated Server-Sent Events route of one session's live turn events (`?id=`). */
export const LIVE_PATH = '/api/agent-bridge/live'

/** Row id of the draft entry that opens an empty composer for a new Claude session. */
export const NEW_SESSION_ID = 'claude:new'

/** Id prefix of Claude Code sessions inside the external id space. */
export const CLAUDE_ID_PREFIX = 'claude:'

/** Id prefix of Codex sessions inside the external id space. */
export const CODEX_ID_PREFIX = 'codex:'

/** Row id of the draft entry that opens an empty composer for a new Codex session. */
export const NEW_CODEX_SESSION_ID = 'codex:new'

/** One session row as the Host publishes it. */
export interface SessionRowWire {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly updatedAt: number
}

/** One content block of a transcript message. */
export type BlockWire =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | {
    readonly type: 'tool_use'
    readonly name: string
    /** Input as JSON text, capped for one-line summaries. */
    readonly input: string
    /** Tool call id the matching result refers to with `forId`. */
    readonly id?: string
    /** Parsed input with every long string capped, for the structured cards. */
    readonly args?: Readonly<Record<string, unknown>>
    readonly todos?: readonly TodoWire[]
  }
  | {
    readonly type: 'tool_result'
    readonly text: string
    readonly images?: readonly string[]
    /** Id of the tool call this result answers. */
    readonly forId?: string
    readonly isError?: boolean
  }

/** One item of a TodoWrite checklist. */
export interface TodoWire {
  readonly content: string
  readonly status: string
}

/** One transcript message. */
export interface MessageWire {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly BlockWire[]
}

/** Active /goal of a session. */
export interface GoalWire {
  readonly condition: string
  /** Turns evaluated (Claude). */
  readonly iterations?: number
  /** Tokens used so far (Codex). */
  readonly tokensUsed?: number
  readonly reason?: string
}

/** Response of the session route. */
export interface SessionWire {
  readonly messages: readonly MessageWire[]
  /** Present while a goal is set and not yet met. */
  readonly goal?: GoalWire
  /** Token totals of the whole session; absent when the engine does not record them. */
  readonly usage?: UsageWire
  /** Number of recent turns read when older turns were left out; absent when the whole session is included. */
  readonly recentTurns?: number
}

/** Token totals. */
export interface UsageWire { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }

/** Event of the watch route: the session file changed after the stream opened. */
export interface WatchEventWire {
  readonly changed: true
  readonly size: number
}

/** One question of an AskUserQuestion request. */
export interface QuestionWire {
  readonly question: string
  readonly header: string
  readonly multiSelect: boolean
  readonly options: readonly { readonly label: string; readonly description: string }[]
}

/** A tool call waiting for the user's decision. */
export interface PermissionWire {
  readonly requestId: string
  readonly tool: string
  readonly title: string
  readonly input: string
  /** Plan text when the tool is ExitPlanMode. */
  readonly plan?: string
  /** Questions when the tool is AskUserQuestion. */
  readonly questions?: readonly QuestionWire[]
}

/** Event of the live route. */
export type LiveEventWire =
  | { readonly kind: 'idle' }
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'message' }
  | { readonly kind: 'permission'; readonly permission: PermissionWire }
  | { readonly kind: 'permission_done'; readonly requestId: string }
  | { readonly kind: 'ended'; readonly status: 'ok' | 'error' | 'interrupted'; readonly error?: string }

/** Body of the send route. */
export interface SendBodyWire {
  /** Engine of a new session; ignored when `id` is set. */
  readonly engine?: 'claude' | 'codex'
  readonly id?: string
  readonly cwd?: string
  readonly text: string
  /** Model and reasoning effort for this turn; empty uses the engine default. */
  readonly model?: string
  readonly effort?: string
  /** Files attached to the message. */
  readonly attachments?: readonly AttachmentWire[]
}

/** One attached file, base64-encoded. */
export interface AttachmentWire { readonly name: string; readonly mime: string; readonly base64: string }

/** Body of the answer route. */
export interface AnswerBodyWire {
  readonly id: string
  readonly requestId: string
  readonly behavior: 'allow' | 'deny'
  /** AskUserQuestion answers keyed by question text. */
  readonly answers?: Readonly<Record<string, string>>
  /** Keep the approval for the rest of the session (Codex). */
  readonly remember?: boolean
}

/** Body of the manage route. */
export interface ManageBodyWire {
  readonly id: string
  readonly action: 'fork' | 'rename' | 'delete'
  /** New title for `rename`. */
  readonly title?: string
}

/** Authenticated routes of the workbench (terminal, files, git); every request carries the session's `cwd`. */
export const TERM_OPEN_PATH = '/api/agent-bridge/term/open'
/** Server-Sent Events of one terminal (`?tid=`): replay of recent output, then live `{data}` and a final `{exit}`. */
export const TERM_STREAM_PATH = '/api/agent-bridge/term/stream'
export const TERM_INPUT_PATH = '/api/agent-bridge/term/input'
export const TERM_RESIZE_PATH = '/api/agent-bridge/term/resize'
export const TERM_CLOSE_PATH = '/api/agent-bridge/term/close'
export const FS_LIST_PATH = '/api/agent-bridge/fs/list'
export const FS_READ_PATH = '/api/agent-bridge/fs/read'
export const FS_WRITE_PATH = '/api/agent-bridge/fs/write'
export const GIT_STATUS_PATH = '/api/agent-bridge/git/status'
export const GIT_DIFF_PATH = '/api/agent-bridge/git/diff'
export const GIT_LOG_PATH = '/api/agent-bridge/git/log'
export const GIT_BRANCHES_PATH = '/api/agent-bridge/git/branches'
export const GIT_ACTION_PATH = '/api/agent-bridge/git/action'

/** One terminal output event. */
export type TermEventWire = { readonly data: string } | { readonly exit: number }

/** One directory entry. */
export interface FsEntryWire { readonly name: string; readonly dir: boolean; readonly size: number }

/** A text file read; `mtimeMs` guards the write-back against edits made elsewhere. */
export interface FsFileWire { readonly content: string; readonly mtimeMs: number }

/** One changed path of `git status`; `index` and `worktree` are the two porcelain status letters (space = unchanged). */
export interface GitChangeWire { readonly path: string; readonly index: string; readonly worktree: string }

/** Result of `git status`. */
export interface GitStatusWire { readonly isRepo: boolean; readonly branch: string; readonly changes: readonly GitChangeWire[] }

/** One commit of the log. */
export interface GitCommitWire { readonly hash: string; readonly subject: string; readonly author: string; readonly date: string }

/** Body of the git action route. */
export type GitActionWire =
  | { readonly cwd: string; readonly action: 'stage' | 'unstage' | 'discard'; readonly paths: readonly string[] }
  | { readonly cwd: string; readonly action: 'commit'; readonly message: string }
  | { readonly cwd: string; readonly action: 'checkout'; readonly branch: string; readonly create?: boolean }
  | { readonly cwd: string; readonly action: 'deleteBranch'; readonly branch: string; readonly force?: boolean }
  | { readonly cwd: string; readonly action: 'fetch' | 'pull' | 'push' | 'publish' | 'init' | 'initialCommit' | 'undoLastCommit' }

/** Remote state of the current branch. */
export interface GitRemoteWire {
  readonly remotes: readonly string[]
  readonly upstream: string | undefined
  readonly ahead: number
  readonly behind: number
}

/** Files and unified diff of a commit or a branch comparison. */
export interface GitRangeDiffWire { readonly files: readonly string[]; readonly diff: string }

export const GIT_REMOTE_PATH = '/api/agent-bridge/git/remote'
export const GIT_SHOW_PATH = '/api/agent-bridge/git/show'
export const GIT_COMPARE_PATH = '/api/agent-bridge/git/compare'
export const GIT_MESSAGE_PATH = '/api/agent-bridge/git/message'

export const FS_ACTION_PATH = '/api/agent-bridge/fs/action'
export const FS_IMAGE_PATH = '/api/agent-bridge/fs/image'
export const FS_BROWSE_PATH = '/api/agent-bridge/fs/browse'

/** Body of the file action route; every path is relative to `cwd`. */
export type FsActionWire =
  | { readonly cwd: string; readonly action: 'create'; readonly path: string; readonly kind: 'file' | 'dir' }
  | { readonly cwd: string; readonly action: 'rename'; readonly path: string; readonly to: string }
  | { readonly cwd: string; readonly action: 'delete'; readonly path: string }
  | { readonly cwd: string; readonly action: 'upload'; readonly path: string; readonly name: string; readonly base64: string }

/** Model and effort used for an engine's messages; an empty string leaves the choice to the engine. */
export interface ChoiceWire { readonly model: string; readonly effort: string }

/** One image read for preview. */
export interface FsImageWire { readonly mime: string; readonly base64: string }

/** Directories under one path, for choosing a working directory. */
export interface FsBrowseWire { readonly path: string; readonly parent: string | undefined; readonly dirs: readonly string[] }

export const INFO_PATH = '/api/agent-bridge/info'
export const SEARCH_PATH = '/api/agent-bridge/search'
export const DRAFT_PATH = '/api/agent-bridge/draft'
export const CHOICE_PATH = '/api/agent-bridge/choice'
export const ARCHIVE_PATH = '/api/agent-bridge/archive'
/** Authenticated POST route pinning or unpinning a session in the Workspace browser (`{id, pinned}`). */
export const PIN_PATH = '/api/agent-bridge/pin'
export const SKILLS_PATH = '/api/agent-bridge/skills'
export const MCP_PATH = '/api/agent-bridge/mcp'
export const GIT_CONFIG_PATH = '/api/agent-bridge/git/config'

/** One selectable model. */
export interface ModelWire { readonly value: string; readonly name: string; readonly description: string; readonly efforts: readonly string[]; readonly isDefault?: boolean }
/** One slash command. */
export interface CommandWire { readonly name: string; readonly description: string; readonly argumentHint: string }
/** One MCP server and its state. */
export interface McpWire { readonly name: string; readonly status: string; readonly scope?: string; readonly error?: string; readonly tools?: number }
/** One skill. */
export interface SkillWire { readonly name: string; readonly scope: 'user' | 'project'; readonly description: string }
/** What an engine offers for a working directory. */
export interface InfoWire {
  readonly models: readonly ModelWire[]
  readonly commands: readonly CommandWire[]
  readonly mcp: readonly McpWire[]
  readonly account?: { readonly email?: string; readonly plan?: string; readonly provider?: string; readonly loggedIn: boolean }
  /** Names of the model and effort the engine uses when none is picked; absent when the engine does not say. */
  readonly defaults?: { readonly model?: string; readonly effort?: string }
}
/** One search hit. */
export interface SearchHitWire { readonly id: string; readonly title: string; readonly snippet: string; readonly cwd: string }
/** Body of the MCP route. */
export type McpBodyWire =
  | { readonly cwd: string; readonly action: 'add'; readonly name: string; readonly scope: 'user' | 'project' | 'local'; readonly config: Record<string, unknown> }
  | { readonly cwd: string; readonly action: 'remove'; readonly name: string; readonly scope: 'user' | 'project' | 'local' }
/** Body of the skills route. */
export type SkillBodyWire =
  | { readonly cwd: string; readonly action: 'add'; readonly name: string; readonly scope: 'user' | 'project'; readonly description: string; readonly body: string }
  | { readonly cwd: string; readonly action: 'remove'; readonly name: string; readonly scope: 'user' | 'project' }

export const GIT_WORKTREES_PATH = '/api/agent-bridge/git/worktrees'
export const CLONE_PATH = '/api/agent-bridge/clone'

/** One git worktree of the repository. */
export interface WorktreeWire { readonly path: string; readonly branch: string; readonly head: string; readonly main: boolean; readonly locked: boolean }

/** Body of the worktree route. */
export type WorktreeBodyWire =
  | { readonly cwd: string; readonly action: 'create'; readonly branch: string; readonly path?: string }
  | { readonly cwd: string; readonly action: 'remove'; readonly path: string; readonly force?: boolean }
  | { readonly cwd: string; readonly action: 'merge'; readonly branch: string }

export const SCHEDULE_PATH = '/api/agent-bridge/schedule'

/** One scheduled message as the browser sees it. */
export interface ScheduledWire {
  readonly id: string
  readonly sessionId: string
  readonly text: string
  readonly at: number
  readonly status: 'pending' | 'sent' | 'failed'
  readonly error?: string
}

/** Body of the schedule route. */
export type ScheduleBodyWire =
  | { readonly action: 'add'; readonly sessionId: string; readonly cwd: string; readonly text: string; readonly at: number; readonly model?: string; readonly effort?: string }
  | { readonly action: 'cancel'; readonly id: string }

export const TASKS_PATH = '/api/agent-bridge/tasks'

/** One TaskMaster task or subtask. */
export interface TaskWire {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly status: string
  readonly priority: string
  readonly dependencies: readonly string[]
  readonly subtasks: readonly TaskWire[]
}

/** The TaskMaster state of a project. */
export interface TasksWire {
  readonly initialized: boolean
  readonly tags: readonly string[]
  readonly tag: string
  readonly tasks: readonly TaskWire[]
  readonly prds: readonly string[]
}

/** Body of the tasks route. */
export type TasksBodyWire =
  | { readonly cwd: string; readonly action: 'init' }
  | { readonly cwd: string; readonly action: 'status'; readonly id: string; readonly status: string; readonly tag?: string }
  | { readonly cwd: string; readonly action: 'add'; readonly prompt: string; readonly tag?: string }
  | { readonly cwd: string; readonly action: 'update'; readonly id: string; readonly prompt: string; readonly tag?: string }
  | { readonly cwd: string; readonly action: 'parse'; readonly file: string; readonly tag?: string }
  | { readonly cwd: string; readonly action: 'prd-read'; readonly file: string }
  | { readonly cwd: string; readonly action: 'prd-write'; readonly file: string; readonly content: string }
  | { readonly cwd: string; readonly action: 'prd-delete'; readonly file: string }

export const VOICE_PATH = '/api/agent-bridge/voice'

/** Body of the voice route: `transcribe` turns a recording into text, `speak` turns text into audio. */
export type VoiceBodyWire =
  | { readonly action: 'transcribe'; readonly base64: string; readonly mime: string }
  | { readonly action: 'speak'; readonly text: string }

/** Whether a speech backend is configured. */
export interface VoiceStatusWire { readonly enabled: boolean }
