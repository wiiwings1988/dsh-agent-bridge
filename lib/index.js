import { createRequire } from "node:module";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { promisify } from "node:util";
import Schema from "@deepseek-ai/schemastery";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { deleteSession, forkSession, getSessionMessages, listSessions, query, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
//#region src/protocol.ts
/** Authenticated route listing the session rows. */
const SESSIONS_PATH = "/api/agent-bridge/sessions";
/** Authenticated route returning one session's messages (`?id=`). */
const SESSION_PATH = "/api/agent-bridge/session";
/** Authenticated Server-Sent Events route announcing writes to one session's file (`?id=`). */
const WATCH_PATH = "/api/agent-bridge/watch";
/** Authenticated POST route starting a turn (`{id?, cwd?, text}`); a missing id creates a session. */
const SEND_PATH = "/api/agent-bridge/send";
/** Authenticated POST route answering a pending permission or question. */
const ANSWER_PATH = "/api/agent-bridge/answer";
/** Authenticated POST route interrupting the running turn (`{id}`). */
const INTERRUPT_PATH = "/api/agent-bridge/interrupt";
/** Authenticated POST route managing a stored session (`{id, action, title?}`). */
const MANAGE_PATH = "/api/agent-bridge/manage";
/** Authenticated route returning the screen-control permission status. */
const SCREEN_STATUS_PATH = "/api/agent-bridge/screen-status";
/** Authenticated Server-Sent Events route of one session's live turn events (`?id=`). */
const LIVE_PATH = "/api/agent-bridge/live";
/** Id prefix of Claude Code sessions inside the external id space. */
const CLAUDE_ID_PREFIX = "claude:";
/** Id prefix of Codex sessions inside the external id space. */
const CODEX_ID_PREFIX = "codex:";
/** Authenticated routes of the workbench (terminal, files, git); every request carries the session's `cwd`. */
const TERM_OPEN_PATH = "/api/agent-bridge/term/open";
/** Server-Sent Events of one terminal (`?tid=`): replay of recent output, then live `{data}` and a final `{exit}`. */
const TERM_STREAM_PATH = "/api/agent-bridge/term/stream";
const TERM_INPUT_PATH = "/api/agent-bridge/term/input";
const TERM_RESIZE_PATH = "/api/agent-bridge/term/resize";
const TERM_CLOSE_PATH = "/api/agent-bridge/term/close";
const FS_LIST_PATH = "/api/agent-bridge/fs/list";
const FS_READ_PATH = "/api/agent-bridge/fs/read";
const FS_WRITE_PATH = "/api/agent-bridge/fs/write";
const GIT_STATUS_PATH = "/api/agent-bridge/git/status";
const GIT_DIFF_PATH = "/api/agent-bridge/git/diff";
const GIT_LOG_PATH = "/api/agent-bridge/git/log";
const GIT_BRANCHES_PATH = "/api/agent-bridge/git/branches";
const GIT_ACTION_PATH = "/api/agent-bridge/git/action";
const GIT_REMOTE_PATH = "/api/agent-bridge/git/remote";
const GIT_SHOW_PATH = "/api/agent-bridge/git/show";
const GIT_COMPARE_PATH = "/api/agent-bridge/git/compare";
const GIT_MESSAGE_PATH = "/api/agent-bridge/git/message";
const FS_ACTION_PATH = "/api/agent-bridge/fs/action";
const FS_IMAGE_PATH = "/api/agent-bridge/fs/image";
const FS_BROWSE_PATH = "/api/agent-bridge/fs/browse";
const INFO_PATH = "/api/agent-bridge/info";
const SEARCH_PATH = "/api/agent-bridge/search";
const DRAFT_PATH = "/api/agent-bridge/draft";
const CHOICE_PATH = "/api/agent-bridge/choice";
const ARCHIVE_PATH = "/api/agent-bridge/archive";
/** Authenticated POST route pinning or unpinning a session in the Workspace browser (`{id, pinned}`). */
const PIN_PATH = "/api/agent-bridge/pin";
const SKILLS_PATH = "/api/agent-bridge/skills";
const MCP_PATH = "/api/agent-bridge/mcp";
const GIT_CONFIG_PATH = "/api/agent-bridge/git/config";
const GIT_WORKTREES_PATH = "/api/agent-bridge/git/worktrees";
const CLONE_PATH = "/api/agent-bridge/clone";
const SCHEDULE_PATH = "/api/agent-bridge/schedule";
const TASKS_PATH = "/api/agent-bridge/tasks";
const VOICE_PATH = "/api/agent-bridge/voice";
//#endregion
//#region src/claude.ts
/**
* Read-only access to Claude Code sessions stored by the local `claude` CLI. Listing and transcript
* parsing go through the Claude Agent SDK; the SDK honors `CLAUDE_CONFIG_DIR`.
*/
/** @returns the Claude Code configuration directory the SDK reads. */
function claudeConfigDir() {
	const configured = process.env["CLAUDE_CONFIG_DIR"];
	return configured === void 0 || configured === "" ? join(homedir(), ".claude") : configured;
}
/**
* List sessions, newest first.
* @param limit - maximum number of rows.
* @returns rows whose ids carry the Claude prefix.
*/
async function listClaudeRows(limit) {
	return (await listSessions({ limit })).map((info) => ({
		id: `${CLAUDE_ID_PREFIX}${info.sessionId}`,
		title: info.customTitle ?? info.summary ?? info.firstPrompt ?? info.sessionId,
		cwd: info.cwd ?? "",
		updatedAt: info.lastModified
	}));
}
function summarizeInput(input) {
	const text = JSON.stringify(input);
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
/** Longest string kept in structured tool arguments. */
const ARG_STRING_LIMIT = 2e4;
function capStrings(value) {
	if (typeof value === "string") return value.length > ARG_STRING_LIMIT ? `${value.slice(0, ARG_STRING_LIMIT)}…` : value;
	if (Array.isArray(value)) return value.map(capStrings);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item)]));
	return value;
}
function todosOf(name, input) {
	const items = input.todos;
	if (name !== "TodoWrite" || !Array.isArray(items)) return void 0;
	return items.map((item) => ({
		content: String(item.content ?? ""),
		status: String(item.status ?? "")
	}));
}
function resultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part.type !== "image").map((part) => part.type === "text" ? part.text ?? "" : `[${part.type ?? "unknown"}]`).join("\n");
}
function resultImages(content) {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => part.type === "image" && part.source?.type === "base64" ? [`data:${part.source.media_type ?? "image/png"};base64,${part.source.data ?? ""}`] : []);
}
function toBlocks(content) {
	if (typeof content === "string") return [{
		type: "text",
		text: content
	}];
	if (!Array.isArray(content)) return [];
	const blocks = [];
	for (const part of content) switch (part["type"]) {
		case "text":
			blocks.push({
				type: "text",
				text: String(part["text"] ?? "")
			});
			break;
		case "thinking":
			blocks.push({
				type: "thinking",
				text: String(part["thinking"] ?? "")
			});
			break;
		case "tool_use":
			{
				const name = String(part["name"] ?? "");
				const todos = todosOf(name, part["input"]);
				const args = capStrings(part["input"]);
				blocks.push({
					type: "tool_use",
					name,
					input: summarizeInput(part["input"]),
					...typeof part["id"] === "string" ? { id: part["id"] } : {},
					...args !== null && typeof args === "object" && !Array.isArray(args) ? { args } : {},
					...todos === void 0 ? {} : { todos }
				});
			}
			break;
		case "tool_result":
			{
				const images = resultImages(part["content"]);
				blocks.push({
					type: "tool_result",
					text: resultText(part["content"]),
					...images.length === 0 ? {} : { images },
					...typeof part["tool_use_id"] === "string" ? { forId: part["tool_use_id"] } : {},
					...part["is_error"] === true ? { isError: true } : {}
				});
			}
			break;
		default: blocks.push({
			type: "text",
			text: `[${String(part["type"])}]`
		});
	}
	return blocks;
}
/**
* Read one session's transcript.
* @param sessionId - Claude session UUID (no prefix).
* @returns user and assistant messages in file order.
*/
async function readClaudeMessages(sessionId) {
	return (await getSessionMessages(sessionId)).flatMap((entry) => {
		if (entry.type !== "user" && entry.type !== "assistant") return [];
		const body = entry.message;
		return [{
			id: entry.uuid,
			role: entry.type,
			blocks: toBlocks(body.content)
		}];
	});
}
/**
* Locate a session's transcript file.
* @param sessionId - Claude session UUID (no prefix).
* @returns absolute path, or undefined when no project folder holds it.
*/
async function findClaudeFile(sessionId) {
	if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return void 0;
	const projects = join(claudeConfigDir(), "projects");
	const folders = await readdir(projects);
	for (const folder of folders) {
		const candidate = join(projects, folder, `${sessionId}.jsonl`);
		if (await stat(candidate).then(() => true, () => false)) return candidate;
	}
}
const GOAL_CLEAR = /^(clear|stop|off|reset|none|cancel)$/i;
/**
* Read the goal state of a session from its transcript file: the last `goal_status` record decides
* (not met = active), and a later `/goal clear` command removes it.
* @param sessionId - Claude session UUID (no prefix).
* @returns the active goal, or undefined when none is set or it was met or cleared.
*/
async function readClaudeGoal(sessionId) {
	const file = await findClaudeFile(sessionId);
	if (file === void 0) return void 0;
	let goal;
	for (const line of (await readFile(file, "utf8")).split("\n")) {
		if (!line.includes("goal_status") && !line.includes("\"command\":\"goal\"")) continue;
		const record = JSON.parse(line);
		const status = record.attachment;
		if (status?.type === "goal_status") goal = status.met === true ? void 0 : {
			condition: status.condition ?? "",
			iterations: status.iterations ?? 0,
			...status.reason === void 0 ? {} : { reason: status.reason }
		};
		else if (record.commandRun?.command === "goal" && GOAL_CLEAR.test((record.commandRun.args ?? "").trim())) goal = void 0;
	}
	return goal;
}
/**
* Fork a session into a new one with the full transcript.
* @param sessionId - source session UUID (no prefix).
* @returns the new session UUID.
*/
async function forkClaudeSession(sessionId) {
	return (await forkSession(sessionId)).sessionId;
}
/**
* Set a session's custom title.
* @param sessionId - session UUID (no prefix).
* @param title - new title.
*/
async function renameClaudeSession(sessionId, title) {
	await renameSession(sessionId, title);
}
/**
* Delete a session's transcript file.
* @param sessionId - session UUID (no prefix).
*/
async function deleteClaudeSession(sessionId) {
	await deleteSession(sessionId);
}
/**
* Sum the token usage recorded in a session file.
* @param sessionId - Claude session UUID (no prefix).
* @returns the totals, or undefined when the file has no usage records.
*/
async function readClaudeUsage(sessionId) {
	const file = await findClaudeFile(sessionId);
	if (file === void 0) return void 0;
	const total = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	};
	let seen = false;
	const counted = /* @__PURE__ */ new Set();
	for (const line of (await readFile(file, "utf8")).split("\n")) {
		if (!line.includes("\"usage\"")) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const usage = record.message?.usage;
		if (record.type !== "assistant" || usage === void 0) continue;
		const key = record.message?.id;
		if (key !== void 0) {
			if (counted.has(key)) continue;
			counted.add(key);
		}
		seen = true;
		total.input += usage["input_tokens"] ?? 0;
		total.output += usage["output_tokens"] ?? 0;
		total.cacheRead += usage["cache_read_input_tokens"] ?? 0;
		total.cacheWrite += usage["cache_creation_input_tokens"] ?? 0;
	}
	return seen ? total : void 0;
}
/**
* Find sessions whose conversation text contains `term` (case-insensitive).
* @param rows - the sessions to look through.
* @param term - text to find.
* @param limit - maximum number of hits.
* @returns one hit per session with the first matching passage.
*/
async function searchClaude(rows, term, limit) {
	const needle = term.toLowerCase();
	const hits = [];
	for (const row of rows) {
		if (hits.length >= limit) break;
		const file = await findClaudeFile(row.id.slice(7));
		if (file === void 0) continue;
		let snippet;
		for (const line of (await readFile(file, "utf8")).split("\n")) {
			if (!line.toLowerCase().includes(needle)) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record.type !== "user" && record.type !== "assistant") continue;
			const text = toBlocks(record.message?.content).flatMap((block) => block.type === "text" || block.type === "thinking" ? [block.text] : []).join("\n");
			const at = text.toLowerCase().indexOf(needle);
			if (at < 0) continue;
			snippet = text.slice(Math.max(0, at - 40), at + needle.length + 80).replace(/\s+/g, " ");
			break;
		}
		if (snippet !== void 0) hits.push({
			id: row.id,
			title: row.title,
			snippet,
			cwd: row.cwd
		});
	}
	return hits;
}
//#endregion
//#region src/defaults.ts
/** Names for what an engine uses when the user leaves the model and effort to it. */
const slug = (name) => name.toLowerCase().replace(/[\s.]+/g, "-");
/**
* Display name of a model id.
* @param id - model id the engine reports, such as `claude-opus-5-5`.
* @param models - the engine's model list.
* @returns the name of the entry with this value, else of the entry whose name in id form is the longest part of the id, else the id.
*/
function modelLabel(id, models) {
	const exact = models.find((model) => model.value === id);
	if (exact !== void 0) return exact.name;
	const lower = id.toLowerCase();
	return models.filter((model) => lower.includes(slug(model.name))).sort((a, b) => slug(b.name).length - slug(a.name).length)[0]?.name ?? id;
}
/**
* The `effortLevel` of the user's Claude Code settings.
* @param configDir - Claude Code configuration directory.
* @returns the level, or undefined when the file or the field is missing or unreadable.
*/
function readClaudeEffortSetting(configDir) {
	let settings;
	try {
		settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
	} catch {
		return;
	}
	return typeof settings.effortLevel === "string" && settings.effortLevel !== "" ? settings.effortLevel : void 0;
}
//#endregion
//#region src/lines.ts
/**
* Newline splitting of a child process's output stream.
* @module dsh-agent-bridge/lines
*/
/**
* Collects stream chunks and hands back each completed line. Only the newly arrived chunk is
* searched for a newline, so a line of many megabytes arriving in thousands of chunks costs time
* in proportion to its length (the Codex app-server answers a thread read with one such line).
*/
var LineSplitter = class {
	constructor() {
		this.pending = [];
	}
	/**
	* Add one chunk.
	* @param chunk - text as it arrived.
	* @returns the lines this chunk completed, without their newlines.
	*/
	push(chunk) {
		const lines = [];
		let start = 0;
		let index = chunk.indexOf("\n");
		while (index >= 0) {
			this.pending.push(chunk.slice(start, index));
			lines.push(this.pending.join(""));
			this.pending = [];
			start = index + 1;
			index = chunk.indexOf("\n", start);
		}
		if (start < chunk.length) this.pending.push(chunk.slice(start));
		return lines;
	}
	/** Drop the unfinished line, for example when the process exits. */
	reset() {
		this.pending = [];
	}
};
//#endregion
//#region src/live.ts
/** Buffers the events of each running turn so late subscribers can catch up. */
var LiveHub = class {
	constructor() {
		this.active = /* @__PURE__ */ new Map();
		this.subscribers = /* @__PURE__ */ new Map();
	}
	/**
	* Mark a session as running.
	* @param sessionId - session id.
	*/
	begin(sessionId) {
		this.active.set(sessionId, {
			events: [],
			partial: ""
		});
	}
	/**
	* Record an event of the running turn and deliver it to the subscribers.
	* @param sessionId - session id.
	* @param event - the event.
	*/
	emit(sessionId, event) {
		const turn = this.active.get(sessionId);
		if (turn !== void 0) if (event.kind === "delta") turn.partial += event.text;
		else {
			if (event.kind === "message") turn.partial = "";
			turn.events.push(event);
		}
		for (const subscriber of this.subscribers.get(sessionId) ?? []) subscriber(event);
	}
	/**
	* Mark a session as no longer running; later subscribers see `idle`.
	* @param sessionId - session id.
	*/
	end(sessionId) {
		this.active.delete(sessionId);
	}
	/**
	* Subscribe to one session; a running turn's events are replayed first, then the accumulated text.
	* @param sessionId - session id.
	* @param subscriber - event callback.
	* @returns the unsubscribe function.
	*/
	subscribe(sessionId, subscriber) {
		const turn = this.active.get(sessionId);
		if (turn === void 0) subscriber({ kind: "idle" });
		else {
			for (const event of turn.events) subscriber(event);
			subscriber({
				kind: "delta",
				text: turn.partial
			});
		}
		const set = this.subscribers.get(sessionId) ?? /* @__PURE__ */ new Set();
		set.add(subscriber);
		this.subscribers.set(sessionId, set);
		return () => {
			set.delete(subscriber);
		};
	}
};
//#endregion
//#region src/codex.ts
/**
* Codex sessions through `codex app-server` (JSON-RPC over stdio, one shared child process). Mirrors the
* Claude driver: list, transcript, goal, live turns with approvals, interrupt, and session management.
*/
var CodexRpc = class {
	constructor(executable, onMessage) {
		this.executable = executable;
		this.onMessage = onMessage;
		this.lines = new LineSplitter();
		this.nextId = 1;
		this.pending = /* @__PURE__ */ new Map();
	}
	send(payload) {
		this.child?.stdin?.write(`${JSON.stringify({
			jsonrpc: "2.0",
			...payload
		})}\n`);
	}
	raw(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject
			});
			this.send({
				id,
				method,
				params
			});
		});
	}
	ensure() {
		if (this.ready !== void 0) return this.ready;
		const name = userInfo().username;
		const child = spawn(this.executable, ["app-server"], {
			stdio: [
				"pipe",
				"pipe",
				"ignore"
			],
			env: {
				...process.env,
				USER: process.env["USER"] ?? name,
				LOGNAME: process.env["LOGNAME"] ?? name
			}
		});
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			for (const line of this.lines.push(chunk)) if (line.trim() !== "") this.dispatch(JSON.parse(line));
		});
		child.on("exit", () => {
			for (const waiter of this.pending.values()) waiter.reject(/* @__PURE__ */ new Error("codex app-server exited"));
			this.pending.clear();
			this.child = void 0;
			this.ready = void 0;
			this.lines.reset();
		});
		this.ready = this.raw("initialize", {
			clientInfo: {
				name: "dsh-agent-bridge",
				title: "dsh agent bridge",
				version: "0.1"
			},
			capabilities: { experimentalApi: true }
		}).then(() => {
			this.send({ method: "initialized" });
		});
		return this.ready;
	}
	dispatch(message) {
		if (message.method === void 0 && typeof message.id === "number") {
			const waiter = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error !== void 0) waiter?.reject(new Error(message.error.message ?? "codex error"));
			else waiter?.resolve(message.result ?? {});
		} else this.onMessage(message);
	}
	/**
	* Call a JSON-RPC method, starting the app-server on first use.
	* @param method - method name.
	* @param params - parameters.
	* @returns the result object.
	*/
	async call(method, params) {
		await this.ensure();
		return await this.raw(method, params);
	}
	/**
	* Answer a server request.
	* @param id - request id.
	* @param result - result payload.
	*/
	respond(id, result) {
		this.send({
			id,
			result
		});
	}
	/**
	* Reject a server request.
	* @param id - request id.
	* @param message - error text.
	*/
	respondError(id, message) {
		this.send({
			id,
			error: {
				code: -32601,
				message
			}
		});
	}
	/** Stop the child process. */
	close() {
		this.child?.kill();
	}
};
function seconds(value) {
	const number = Number(value);
	return number < 0xe8d4a51000 ? number * 1e3 : number;
}
function textOfContent(content) {
	if (!Array.isArray(content)) return "";
	return content.map((part) => part["type"] === "text" ? String(part["text"] ?? "") : `[${String(part["type"])}]`).join("\n");
}
/** Tool output longer than this is cut, so one noisy command cannot make a session too large to send. */
const TOOL_OUTPUT_LIMIT = 2e4;
const capped = (text) => text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…` : text;
function toMessages(item) {
	const id = String(item["id"]);
	switch (item["type"]) {
		case "userMessage": return [{
			id,
			role: "user",
			blocks: [{
				type: "text",
				text: textOfContent(item["content"])
			}]
		}];
		case "agentMessage": return [{
			id,
			role: "assistant",
			blocks: [{
				type: "text",
				text: String(item["text"] ?? "")
			}]
		}];
		case "plan": return [{
			id,
			role: "assistant",
			blocks: [{
				type: "text",
				text: String(item["text"] ?? "")
			}]
		}];
		case "reasoning": {
			const text = [...item["summary"] ?? [], ...item["content"] ?? []].map(String).join("\n");
			return text === "" ? [] : [{
				id,
				role: "assistant",
				blocks: [{
					type: "thinking",
					text
				}]
			}];
		}
		case "commandExecution": return [{
			id: `${id}:use`,
			role: "assistant",
			blocks: [{
				type: "tool_use",
				name: "command",
				input: String(item["command"] ?? ""),
				id,
				args: {
					command: String(item["command"] ?? ""),
					...typeof item["cwd"] === "string" ? { cwd: item["cwd"] } : {}
				}
			}]
		}, {
			id: `${id}:result`,
			role: "user",
			blocks: [{
				type: "tool_result",
				text: capped(String(item["aggregatedOutput"] ?? "")),
				forId: id,
				...typeof item["exitCode"] === "number" && item["exitCode"] !== 0 ? { isError: true } : {}
			}]
		}];
		case "fileChange": {
			const changes = item["changes"] ?? [];
			const diff = changes.map((change) => `${String(change["path"])}\n${String(change["diff"] ?? "")}`).join("\n");
			return [{
				id: `${id}:use`,
				role: "assistant",
				blocks: [{
					type: "tool_use",
					name: "fileChange",
					input: changes.map((change) => String(change["path"])).join(", "),
					id,
					args: { paths: changes.map((change) => String(change["path"])) }
				}]
			}, {
				id: `${id}:result`,
				role: "user",
				blocks: [{
					type: "tool_result",
					text: capped(diff),
					forId: id
				}]
			}];
		}
		case "mcpToolCall":
		case "dynamicToolCall": {
			const text = JSON.stringify(item);
			return [{
				id,
				role: "assistant",
				blocks: [{
					type: "tool_use",
					name: String(item["tool"] ?? item["type"]),
					input: text.length > 400 ? `${text.slice(0, 400)}…` : text,
					id
				}]
			}];
		}
		default: return [];
	}
}
/** Codex sessions: reading, live turns, and management over one app-server process. */
var CodexEngine = class {
	/**
	* @param executable - path of the `codex` executable.
	*/
	constructor(executable) {
		this.hub = new LiveHub();
		this.runs = /* @__PURE__ */ new Map();
		this.loaded = /* @__PURE__ */ new Set();
		this.items = /* @__PURE__ */ new Map();
		this.rpc = new CodexRpc(executable, (message) => {
			this.onMessage(message);
		});
	}
	/**
	* @param limit - maximum number of rows.
	* @returns thread rows, newest first, with Codex-prefixed ids.
	*/
	async listRows(limit) {
		return (await this.rpc.call("thread/list", {
			limit,
			sortKey: "updated_at"
		}))["data"].map((thread) => ({
			id: `${CODEX_ID_PREFIX}${String(thread["id"])}`,
			title: String(thread["name"] ?? thread["preview"] ?? thread["id"]),
			cwd: String(thread["cwd"] ?? ""),
			updatedAt: seconds(thread["updatedAt"])
		}));
	}
	/** @returns the models Codex offers to this account. */
	async listModels() {
		return (await this.rpc.call("model/list", { limit: 100 }))["data"].filter((model) => model["hidden"] !== true).map((model) => ({
			value: String(model["model"] ?? model["id"]),
			name: String(model["displayName"] ?? model["model"]),
			description: String(model["description"] ?? ""),
			efforts: (model["supportedReasoningEfforts"] ?? []).map((item) => String(item["reasoningEffort"] ?? item)),
			...model["isDefault"] === true ? { isDefault: true } : {}
		}));
	}
	/**
	* @param models - the listed models, to name the configured one.
	* @returns names of the model and effort Codex's own configuration sets for a new thread.
	*/
	async readDefaults(models) {
		const config = (await this.rpc.call("config/read", {}))["config"];
		const model = typeof config?.["model"] === "string" ? modelLabel(config["model"], models) : models.find((entry) => entry.isDefault === true)?.name;
		const effort = config?.["model_reasoning_effort"];
		return {
			...model === void 0 ? {} : { model },
			...typeof effort === "string" ? { effort } : {}
		};
	}
	/** @returns the signed-in account, when Codex reports one. */
	async readAccount() {
		const account = (await this.rpc.call("account/read", { refreshToken: false }))["account"];
		if (account === null || account === void 0) return { loggedIn: false };
		return {
			loggedIn: true,
			...typeof account["email"] === "string" ? { email: account["email"] } : {},
			...typeof account["planType"] === "string" ? { plan: account["planType"] } : {},
			provider: String(account["type"] ?? "codex")
		};
	}
	/**
	* @param term - text to look for in thread titles and content.
	* @param limit - maximum number of threads.
	* @returns matching thread rows.
	*/
	async search(term, limit) {
		return (await this.rpc.call("thread/list", {
			limit,
			sortKey: "updated_at",
			searchTerm: term
		}))["data"].map((thread) => ({
			id: `${CODEX_ID_PREFIX}${String(thread["id"])}`,
			title: String(thread["name"] ?? thread["preview"] ?? thread["id"]),
			cwd: String(thread["cwd"] ?? ""),
			updatedAt: seconds(thread["updatedAt"])
		}));
	}
	/**
	* Read the most recent turns. A whole thread can hold hundreds of megabytes of tool output, which the
	* app-server would send back as a single line, so only one page of turns is requested.
	* @param threadId - thread id (no prefix).
	* @param turnLimit - most turns to read, newest first.
	* @returns the transcript messages in order, and whether older turns were left out.
	*/
	async readMessages(threadId, turnLimit) {
		const result = await this.rpc.call("thread/turns/list", {
			threadId,
			limit: turnLimit,
			sortDirection: "desc",
			itemsView: "full"
		});
		const turns = [...result["data"] ?? []].reverse();
		const nextCursor = result["nextCursor"];
		return {
			messages: turns.flatMap((turn) => turn["items"].flatMap(toMessages)),
			earlierOmitted: nextCursor !== null && nextCursor !== void 0
		};
	}
	/**
	* @param threadId - thread id (no prefix).
	* @returns the goal unless none exists or it is complete.
	*/
	async readGoal(threadId) {
		const goal = (await this.rpc.call("thread/goal/get", { threadId }))["goal"];
		if (goal === null || goal === void 0 || goal["status"] === "complete") return void 0;
		return {
			condition: String(goal["objective"]),
			tokensUsed: Number(goal["tokensUsed"] ?? 0),
			reason: String(goal["status"])
		};
	}
	/**
	* @param threadId - thread id (no prefix).
	* @returns the rollout file path, or undefined when unknown.
	*/
	async findFile(threadId) {
		return (await this.rpc.call("thread/read", {
			threadId,
			includeTurns: false
		}))["thread"]["path"] ?? void 0;
	}
	/**
	* Start a turn (creating or resuming the thread) or apply a `/goal` command.
	* @param options - turn options.
	* @returns the thread id.
	*/
	async start(options) {
		if (options.threadId !== void 0 && this.runs.has(options.threadId)) throw new Error("a turn is already running in this session");
		const settings = {
			approvalPolicy: options.approvalPolicy,
			sandbox: options.sandbox
		};
		let threadId = options.threadId;
		if (threadId === void 0) {
			threadId = String((await this.rpc.call("thread/start", {
				cwd: options.cwd,
				...settings
			}))["thread"]["id"]);
			this.loaded.add(threadId);
		} else if (!this.loaded.has(threadId)) {
			await this.rpc.call("thread/resume", {
				threadId,
				...settings
			});
			this.loaded.add(threadId);
		}
		const goal = /^\/goal\s+([\s\S]+)$/.exec(options.text.trim());
		if (goal !== null) {
			const condition = (goal[1] ?? "").trim();
			if (/^(clear|stop|off|reset|none|cancel)$/i.test(condition)) {
				await this.rpc.call("thread/goal/clear", { threadId });
				this.finishWithoutTurn(threadId);
			} else {
				await this.rpc.call("thread/goal/set", {
					threadId,
					objective: condition
				});
				await this.waitForTurnOrGiveUp(threadId);
			}
			return threadId;
		}
		const response = await this.rpc.call("turn/start", {
			threadId,
			input: [...(options.images ?? []).map((path) => ({
				type: "localImage",
				path
			})), {
				type: "text",
				text: options.text,
				text_elements: []
			}],
			...settings,
			...options.model === void 0 || options.model === "" ? {} : { model: options.model },
			...options.effort === void 0 || options.effort === "" ? {} : { effort: options.effort }
		});
		this.ensureRun(threadId).turnId = String(response["turn"]["id"]);
		return threadId;
	}
	finishWithoutTurn(threadId) {
		this.hub.begin(threadId);
		this.hub.emit(threadId, {
			kind: "ended",
			status: "ok"
		});
		this.hub.end(threadId);
	}
	async waitForTurnOrGiveUp(threadId) {
		for (let waited = 0; waited < 8e3; waited += 200) {
			if (this.runs.has(threadId)) return;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		this.finishWithoutTurn(threadId);
	}
	ensureRun(threadId) {
		let run = this.runs.get(threadId);
		if (run === void 0) {
			run = {
				pending: /* @__PURE__ */ new Map(),
				interrupted: false
			};
			this.runs.set(threadId, run);
			this.hub.begin(threadId);
		}
		return run;
	}
	onMessage(message) {
		const params = message.params ?? {};
		const threadId = typeof params["threadId"] === "string" ? params["threadId"] : void 0;
		if (message.id !== void 0) {
			this.onRequest(message.id, message.method ?? "", params);
			return;
		}
		if (threadId === void 0) return;
		switch (message.method) {
			case "turn/started":
				this.ensureRun(threadId).turnId = String(params["turn"]["id"]);
				break;
			case "item/started":
				this.items.set(String(params["item"]["id"]), params["item"]);
				break;
			case "item/agentMessage/delta":
				this.ensureRun(threadId);
				this.hub.emit(threadId, {
					kind: "delta",
					text: String(params["delta"] ?? "")
				});
				break;
			case "item/completed":
				this.ensureRun(threadId);
				this.hub.emit(threadId, { kind: "message" });
				break;
			case "error":
				this.ensureRun(threadId).error = String(params["error"]?.["message"] ?? "error");
				break;
			case "turn/completed": {
				const run = this.ensureRun(threadId);
				const turn = params["turn"];
				const status = run.interrupted || turn["status"] === "interrupted" ? "interrupted" : turn["status"] === "failed" ? "error" : "ok";
				const error = status === "error" ? String(turn["error"]?.["message"] ?? run.error ?? "turn failed") : void 0;
				for (const finish of [...run.pending.values()]) finish({ behavior: "deny" });
				this.hub.emit(threadId, error === void 0 ? {
					kind: "ended",
					status
				} : {
					kind: "ended",
					status,
					error
				});
				this.runs.delete(threadId);
				this.hub.end(threadId);
				this.release(threadId);
				break;
			}
			default: break;
		}
	}
	/** Unload a finished thread so another Codex client can write to it; the next turn resumes it. */
	release(threadId) {
		this.loaded.delete(threadId);
		this.rpc.call("thread/unsubscribe", { threadId }).catch(() => {});
	}
	onRequest(id, method, params) {
		const threadId = String(params["threadId"] ?? "");
		const run = this.ensureRun(threadId);
		const requestId = randomUUID();
		let permission;
		let reply;
		if (method === "item/commandExecution/requestApproval") {
			permission = {
				requestId,
				tool: "command",
				title: String(params["reason"] ?? "Run command"),
				input: String(params["command"] ?? "")
			};
			reply = (decision) => ({ decision: decision.behavior === "deny" ? "decline" : decision.remember === true ? "acceptForSession" : "accept" });
		} else if (method === "item/fileChange/requestApproval") {
			const input = (this.items.get(String(params["itemId"]))?.["changes"] ?? []).map((change) => `${String(change["path"])}\n${String(change["diff"] ?? "")}`).join("\n") || String(params["reason"] ?? "");
			permission = {
				requestId,
				tool: "fileChange",
				title: String(params["reason"] ?? "Apply file changes"),
				input: input.length > 2e3 ? `${input.slice(0, 2e3)}…` : input
			};
			reply = (decision) => ({ decision: decision.behavior === "deny" ? "decline" : decision.remember === true ? "acceptForSession" : "accept" });
		} else if (method === "item/tool/requestUserInput") {
			const raw = params["questions"] ?? [];
			permission = {
				requestId,
				tool: "requestUserInput",
				title: "Question",
				input: "",
				questions: raw.map((item) => ({
					question: String(item["question"]),
					header: String(item["header"] ?? ""),
					multiSelect: false,
					options: (item["options"] ?? []).map((option) => ({
						label: String(option["label"]),
						description: String(option["description"] ?? "")
					}))
				}))
			};
			reply = (decision) => {
				const answers = {};
				if (decision.behavior === "allow") for (const item of raw) {
					const value = decision.answers?.[String(item["question"])];
					if (value !== void 0) answers[String(item["id"])] = { answers: [value] };
				}
				return { answers };
			};
		} else {
			this.rpc.respondError(id, `unsupported request ${method}`);
			return;
		}
		run.pending.set(requestId, (decision) => {
			if (!run.pending.delete(requestId)) return;
			this.hub.emit(threadId, {
				kind: "permission_done",
				requestId
			});
			this.rpc.respond(id, reply(decision));
		});
		this.hub.emit(threadId, {
			kind: "permission",
			permission
		});
	}
	/**
	* @param threadId - thread id (no prefix).
	* @returns whether a turn is running.
	*/
	isRunning(threadId) {
		return this.runs.has(threadId);
	}
	/**
	* Resolve a pending approval or question.
	* @param threadId - thread id (no prefix).
	* @param requestId - request id from the permission event.
	* @param decision - the user's decision.
	* @returns false when nothing was pending under that id.
	*/
	answer(threadId, requestId, decision) {
		const finish = this.runs.get(threadId)?.pending.get(requestId);
		if (finish === void 0) return false;
		finish(decision);
		return true;
	}
	/**
	* @param threadId - thread id (no prefix).
	* @returns false when no turn is running.
	*/
	async interrupt(threadId) {
		const run = this.runs.get(threadId);
		if (run?.turnId === void 0) return false;
		run.interrupted = true;
		for (const finish of [...run.pending.values()]) finish({ behavior: "deny" });
		await this.rpc.call("turn/interrupt", {
			threadId,
			turnId: run.turnId
		});
		return true;
	}
	/**
	* @param threadId - thread id (no prefix).
	* @param subscriber - event callback.
	* @returns the unsubscribe function.
	*/
	subscribe(threadId, subscriber) {
		return this.hub.subscribe(threadId, subscriber);
	}
	/**
	* @param threadId - source thread id (no prefix).
	* @returns the new thread id.
	*/
	async fork(threadId) {
		const result = await this.rpc.call("thread/fork", { threadId });
		return String(result["thread"]["id"]);
	}
	/**
	* @param threadId - thread id (no prefix).
	* @param name - new name.
	*/
	async rename(threadId, name) {
		await this.rpc.call("thread/name/set", {
			threadId,
			name
		});
	}
	/**
	* @param threadId - thread id (no prefix).
	*/
	async delete(threadId) {
		await this.rpc.call("thread/delete", { threadId });
	}
	/** Interrupt running turns and stop the app-server (plugin teardown). */
	async closeAll() {
		await Promise.all([...this.runs.keys()].map((id) => this.interrupt(id)));
		this.rpc.close();
	}
};
//#endregion
//#region src/run.ts
/**
* Turns of Claude Code sessions run through the Claude Agent SDK. One `query()` per user message,
* resumed by session id, so a Host restart loses only the live turn; the transcript file stays the
* source of truth.
*/
/** MCP server name of the screen-control tools this plugin adds. */
const SCREEN_SERVER = "peekaboo-dsh";
/** MCP server name of the browser tools this plugin adds. */
const BROWSER_SERVER = "playwright-dsh";
/** Pinned so a new upstream release cannot change what runs on this machine. */
const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83";
/** Browser tools that only read the page and are approved without asking. */
const BROWSER_READ_ONLY = [
	"browser_snapshot",
	"browser_take_screenshot",
	"browser_console_messages",
	"browser_network_requests"
];
/** Read-only screen tools approved without asking; every other tool of the server asks each time. */
const SCREEN_READ_ONLY = [
	"see",
	"image",
	"capture",
	"inspect_ui",
	"verify_state",
	"permissions",
	"sleep"
];
/**
* Peekaboo tools that send screenshots to an external model (`analyze`, `agent`), plus the same tools of the
* user-level `peekaboo` server; they conflict with keeping screen content on this machine.
*/
const SCREEN_DISALLOWED = ["analyze", "agent"].flatMap((tool) => [`mcp__${SCREEN_SERVER}__${tool}`, `mcp__peekaboo__${tool}`]);
/** Environment of the Claude process; the macOS keychain lookup of the login needs USER, which a sanitized launcher drops. */
function childEnv() {
	const name = userInfo().username;
	return {
		...process.env,
		USER: process.env["USER"] ?? name,
		LOGNAME: process.env["LOGNAME"] ?? name
	};
}
function toQuestions(input) {
	return (Array.isArray(input["questions"]) ? input["questions"] : []).map((item) => ({
		question: String(item["question"] ?? ""),
		header: String(item["header"] ?? ""),
		multiSelect: item["multiSelect"] === true,
		options: (Array.isArray(item["options"]) ? item["options"] : []).map((option) => ({
			label: String(option["label"] ?? ""),
			description: String(option["description"] ?? "")
		}))
	}));
}
function baseOptions(options) {
	return {
		cwd: options.cwd,
		...options.sessionId === void 0 ? {} : { resume: options.sessionId },
		pathToClaudeCodeExecutable: options.executable,
		permissionMode: options.permissionMode,
		allowedTools: [
			...options.allowedTools,
			...options.computerUse ? SCREEN_READ_ONLY.map((tool) => `mcp__${SCREEN_SERVER}__${tool}`) : [],
			...options.browserUse === true ? BROWSER_READ_ONLY.map((tool) => `mcp__${BROWSER_SERVER}__${tool}`) : []
		],
		disallowedTools: SCREEN_DISALLOWED,
		...options.computerUse || options.browserUse === true ? { mcpServers: {
			...options.computerUse ? { [SCREEN_SERVER]: {
				type: "stdio",
				command: options.peekabooCommand,
				args: ["mcp", "--no-remote"]
			} } : {},
			...options.browserUse === true ? { [BROWSER_SERVER]: {
				type: "stdio",
				command: "npx",
				args: [
					"-y",
					PLAYWRIGHT_MCP,
					"--isolated",
					...options.browserHeaded === true ? [] : ["--headless"]
				]
			} } : {}
		} } : {},
		...options.memory === "" ? {} : { systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: `# Memory shared from dsh\n${options.memory}`
		} },
		...options.model === void 0 || options.model === "" ? {} : { model: options.model },
		...isEffort(options.effort) ? { effort: options.effort } : {},
		settingSources: [
			"user",
			"project",
			"local"
		],
		env: childEnv()
	};
}
const EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
const isEffort = (value) => EFFORTS.includes(value);
/** The prompt of a turn: plain text, or a one-message stream when images are attached. */
function promptOf(options) {
	if (options.images === void 0 || options.images.length === 0) return options.text;
	const content = [...options.images.map((image) => ({
		type: "image",
		source: {
			type: "base64",
			media_type: image.mime,
			data: image.base64
		}
	})), {
		type: "text",
		text: options.text
	}];
	return (async function* () {
		yield {
			type: "user",
			message: {
				role: "user",
				content
			},
			parent_tool_use_id: null
		};
	})();
}
/** What the Claude executable offers for a working directory. */
async function probeInfo(options) {
	const stream = query({
		prompt: "ok",
		options: {
			...baseOptions({
				...options,
				text: "ok"
			}),
			persistSession: false
		}
	});
	try {
		for await (const message of stream) {
			if (message.type !== "system" || message.subtype !== "init") continue;
			const [models, commands, mcp, account] = await Promise.all([
				stream.supportedModels(),
				stream.supportedCommands(),
				stream.mcpServerStatus(),
				stream.accountInfo().catch(() => void 0)
			]);
			const listed = models.map((model) => ({
				value: model.value,
				name: model.displayName,
				description: model.description,
				efforts: model.supportsEffort === true ? model.supportedEffortLevels ?? [] : []
			}));
			const effort = message.effort ?? readClaudeEffortSetting(claudeConfigDir());
			return {
				models: listed,
				defaults: {
					model: modelLabel(message.model, listed),
					...effort === void 0 || effort === null ? {} : { effort }
				},
				commands: commands.map((command) => ({
					name: command.name,
					description: command.description,
					argumentHint: command.argumentHint
				})),
				mcp: mcp.map((server) => ({
					name: server.name,
					status: server.status,
					...server.scope === void 0 ? {} : { scope: server.scope },
					...server.error === void 0 ? {} : { error: server.error },
					...server.tools === void 0 ? {} : { tools: server.tools.length }
				})),
				...account === void 0 ? {} : { account: {
					loggedIn: account.email !== void 0 || account.apiProvider !== void 0 || account.tokenSource !== void 0 || account.apiKeySource !== void 0,
					...account.email === void 0 ? {} : { email: account.email },
					...account.subscriptionType === void 0 ? {} : { plan: account.subscriptionType },
					...account.apiProvider === void 0 ? {} : { provider: account.apiProvider }
				} }
			};
		}
		throw new Error("no init message");
	} finally {
		stream.close();
	}
}
/**
* Start a throwaway turn, read the tools and MCP server states from its init message, and stop it.
* @param options - the options a real turn would use (the text is ignored).
* @returns the tool names and MCP server states.
*/
async function probeTools(options) {
	const stream = query({
		prompt: "ok",
		options: {
			...baseOptions({
				...options,
				text: "ok"
			}),
			persistSession: false
		}
	});
	try {
		for await (const message of stream) if (message.type === "system" && message.subtype === "init") return {
			tools: message.tools,
			mcpServers: message.mcp_servers.map((server) => ({
				name: server.name,
				status: server.status
			}))
		};
		throw new Error("no init message");
	} finally {
		stream.close();
	}
}
/** Owns the running turns and the subscribers watching them. */
var RunManager = class {
	constructor() {
		this.runs = /* @__PURE__ */ new Map();
		this.hub = new LiveHub();
	}
	/**
	* Start a turn. Resolves once the session id is known (immediately for a resumed session).
	* @param options - turn options.
	* @returns the session id.
	*/
	async start(options) {
		if (options.sessionId !== void 0 && this.runs.has(options.sessionId)) throw new Error("a turn is already running in this session");
		let current;
		let resolveId;
		let rejectId;
		const idPromise = new Promise((resolve, reject) => {
			resolveId = resolve;
			rejectId = reject;
		});
		const stream = query({
			prompt: promptOf(options),
			options: {
				...baseOptions(options),
				includePartialMessages: true,
				canUseTool: (tool, input, context) => this.ask(current, resolvedId(), tool, input, context.title ?? tool, context.signal)
			}
		});
		let sessionId = options.sessionId;
		const resolvedId = () => sessionId ?? "";
		current = {
			query: stream,
			pending: /* @__PURE__ */ new Map(),
			interrupted: false
		};
		if (sessionId !== void 0) {
			this.runs.set(sessionId, current);
			this.hub.begin(sessionId);
			resolveId(sessionId);
		}
		this.pump(current, stream, (id) => {
			sessionId = id;
			this.runs.set(id, current);
			this.hub.begin(id);
			resolveId(id);
		}, resolvedId, rejectId);
		return await idPromise;
	}
	async pump(run, stream, onId, idOf, fail) {
		let status = "ok";
		let error;
		try {
			for await (const message of stream) if (message.type === "system" && message.subtype === "init") {
				if (idOf() === "") onId(message.session_id);
			} else if (message.type === "stream_event") {
				const event = message.event;
				if (event.type === "content_block_delta" && event.delta?.type === "text_delta") this.hub.emit(idOf(), {
					kind: "delta",
					text: event.delta.text ?? ""
				});
			} else if (message.type === "assistant" || message.type === "user") this.hub.emit(idOf(), { kind: "message" });
			else if (message.type === "result" && message.is_error) {
				status = "error";
				error = "result" in message ? String(message.result) : message.subtype;
			}
		} catch (caught) {
			status = "error";
			error = caught instanceof Error ? caught.message : String(caught);
		}
		if (run.interrupted) status = "interrupted";
		const id = idOf();
		if (id === "") {
			fail(new Error(error ?? "the turn ended before the session started"));
			return;
		}
		this.hub.emit(id, error === void 0 ? {
			kind: "ended",
			status
		} : {
			kind: "ended",
			status,
			error
		});
		this.runs.delete(id);
		this.hub.end(id);
	}
	ask(run, sessionId, tool, input, title, signal) {
		if (run === void 0) return Promise.resolve({
			behavior: "deny",
			message: "no run"
		});
		const requestId = randomUUID();
		const questions = tool === "AskUserQuestion" ? toQuestions(input) : void 0;
		const plan = tool === "ExitPlanMode" && typeof input["plan"] === "string" ? input["plan"] : void 0;
		const text = JSON.stringify(input);
		const permission = {
			requestId,
			tool,
			title,
			input: text.length > 2e3 ? `${text.slice(0, 2e3)}…` : text,
			...plan === void 0 ? {} : { plan },
			...questions === void 0 ? {} : { questions }
		};
		return new Promise((resolve) => {
			const finish = (decision) => {
				if (!run.pending.delete(requestId)) return;
				this.hub.emit(sessionId, {
					kind: "permission_done",
					requestId
				});
				if (decision.behavior === "deny") resolve({
					behavior: "deny",
					message: "The user declined this request."
				});
				else resolve({
					behavior: "allow",
					...decision.answers === void 0 ? {} : { updatedInput: {
						...input,
						answers: decision.answers
					} }
				});
			};
			run.pending.set(requestId, finish);
			signal.addEventListener("abort", () => finish({ behavior: "deny" }), { once: true });
			this.hub.emit(sessionId, {
				kind: "permission",
				permission
			});
		});
	}
	/**
	* @param sessionId - session id.
	* @returns whether a turn is running in the session.
	*/
	isRunning(sessionId) {
		return this.runs.has(sessionId);
	}
	/**
	* Resolve a pending permission or question.
	* @param sessionId - session id.
	* @param requestId - request id from the permission event.
	* @param decision - the user's decision.
	* @returns false when nothing was pending under that id.
	*/
	answer(sessionId, requestId, decision) {
		const finish = this.runs.get(sessionId)?.pending.get(requestId);
		if (finish === void 0) return false;
		finish(decision);
		return true;
	}
	/**
	* Interrupt the running turn.
	* @param sessionId - session id.
	* @returns false when no turn is running.
	*/
	async interrupt(sessionId) {
		const run = this.runs.get(sessionId);
		if (run === void 0) return false;
		run.interrupted = true;
		for (const finish of [...run.pending.values()]) finish({ behavior: "deny" });
		await run.query.interrupt();
		return true;
	}
	/**
	* Subscribe to one session's live events; replays the running turn's events first.
	* @param sessionId - session id.
	* @param subscriber - event callback.
	* @returns the unsubscribe function.
	*/
	subscribe(sessionId, subscriber) {
		return this.hub.subscribe(sessionId, subscriber);
	}
	/** Interrupt every running turn (plugin teardown). */
	async closeAll() {
		await Promise.all([...this.runs.keys()].map((id) => this.interrupt(id)));
	}
};
//#endregion
//#region src/workbench.ts
/**
* Host half of the workbench: a shell terminal, a file tree with text editing, and git, all confined to the
* working directory of the selected session. Local use only, behind the same authenticated channel as the
* rest of the plugin.
* @module dsh-agent-bridge/workbench
*/
const exec$2 = promisify(execFile);
const FILE_LIMIT = 1e6;
/** Variables that look like credentials never reach the shell. */
const SECRET_ENV = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
/** Error carrying an HTTP status. */
var HttpError = class extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
/** @returns `target` resolved through symlinks when it stays inside `root`, otherwise throws 403. */
async function inside(root, target) {
	const base = await realpath(root);
	const within = (path) => path === base || path.startsWith(base + sep);
	let existing = resolve(target);
	const missing = [];
	for (;;) try {
		existing = await realpath(existing);
		break;
	} catch {
		const parent = dirname(existing);
		if (parent === existing) throw new HttpError(404, "no such path");
		missing.unshift(basename(existing));
		existing = parent;
	}
	const resolved = join(existing, ...missing);
	if (!within(resolved)) throw new HttpError(403, "path is outside the session directory");
	if (missing.length > 0 && existing === resolved) throw new HttpError(404, "no such path");
	return resolved;
}
/** Resolve a request's `cwd` and relative `path` to an absolute path inside the cwd. */
async function resolveIn(cwd, relative) {
	if (cwd === "") throw new HttpError(400, "cwd is required");
	return inside(cwd, join(cwd, relative));
}
/** List one directory; directories first, then files, each alphabetical. */
async function listDir(cwd, relative) {
	const dir = await resolveIn(cwd, relative);
	const entries = await readdir(dir, { withFileTypes: true });
	return (await Promise.all(entries.filter((entry) => entry.name !== ".git").map(async (entry) => {
		const info = await stat(join(dir, entry.name)).catch(() => void 0);
		return {
			name: entry.name,
			dir: info?.isDirectory() ?? entry.isDirectory(),
			size: info?.size ?? 0
		};
	}))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}
/** Read a text file; refuses large and binary files. */
async function readText(cwd, relative) {
	const path = await resolveIn(cwd, relative);
	const info = await stat(path);
	if (!info.isFile()) throw new HttpError(400, "not a file");
	if (info.size > FILE_LIMIT) throw new HttpError(413, `file is larger than ${FILE_LIMIT} bytes`);
	const buffer = await readFile(path);
	if (buffer.includes(0)) throw new HttpError(415, "binary file");
	return {
		content: buffer.toString("utf8"),
		mtimeMs: info.mtimeMs
	};
}
/** Write a text file; refuses when the file changed since `baseMtimeMs` was read. */
async function writeText(cwd, relative, content, baseMtimeMs) {
	const path = await resolveIn(cwd, relative);
	if (Buffer.byteLength(content) > FILE_LIMIT) throw new HttpError(413, `content is larger than ${FILE_LIMIT} bytes`);
	const existing = await stat(path).catch(() => void 0);
	if (existing !== void 0 && baseMtimeMs !== void 0 && Math.abs(existing.mtimeMs - baseMtimeMs) > 1) throw new HttpError(409, "the file changed on disk since it was opened");
	await writeFile(path, content, "utf8");
	return { mtimeMs: (await stat(path)).mtimeMs };
}
const IMAGE_MIME = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	ico: "image/x-icon"
};
const IMAGE_LIMIT = 1e7;
const UPLOAD_LIMIT = 2e7;
/** Read an image for preview. */
async function readImage(cwd, relative) {
	const path = await resolveIn(cwd, relative);
	const mime = IMAGE_MIME[path.split(".").pop()?.toLowerCase() ?? ""];
	if (mime === void 0) throw new HttpError(415, "not an image");
	if ((await stat(path)).size > IMAGE_LIMIT) throw new HttpError(413, "image is too large to preview");
	return {
		mime,
		base64: (await readFile(path)).toString("base64")
	};
}
/** Create, rename, delete or upload inside the session directory. */
async function fsAction(body) {
	const root = await realpath(body.cwd.length === 0 ? "/nonexistent" : body.cwd).catch(() => {
		throw new HttpError(400, "cwd is required");
	});
	const clean = (name) => {
		if (name === "" || name.includes("\0") || name.split("/").includes("..")) throw new HttpError(400, "invalid name");
		return name;
	};
	switch (body.action) {
		case "create": {
			const target = await resolveIn(body.cwd, clean(body.path));
			if (await stat(target).then(() => true, () => false)) throw new HttpError(409, "already exists");
			if (body.kind === "dir") await mkdir(target, { recursive: true });
			else {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, "", { flag: "wx" });
			}
			break;
		}
		case "rename": {
			const from = await resolveIn(body.cwd, clean(body.path));
			const to = await resolveIn(body.cwd, clean(body.to));
			if (from === root) throw new HttpError(400, "cannot rename the session directory");
			if (await stat(to).then(() => true, () => false)) throw new HttpError(409, "target already exists");
			await rename(from, to);
			break;
		}
		case "delete": {
			const target = await resolveIn(body.cwd, clean(body.path));
			if (target === root) throw new HttpError(400, "cannot delete the session directory");
			await rm(target, { recursive: true });
			break;
		}
		case "upload": {
			const dir = await resolveIn(body.cwd, body.path === "" ? "." : clean(body.path));
			if (body.name.includes("/") || body.name === "" || body.name === "..") throw new HttpError(400, "invalid name");
			const data = Buffer.from(body.base64, "base64");
			if (data.length > UPLOAD_LIMIT) throw new HttpError(413, "file is too large");
			const target = join(dir, body.name);
			if (await stat(target).then(() => true, () => false)) throw new HttpError(409, "already exists");
			await writeFile(target, data, { flag: "wx" });
			break;
		}
	}
	return { ok: true };
}
/** Directories under `path` (home when empty); used to pick a working directory. Not confined: the caller is the signed-in local user. */
async function browseDirs(path) {
	const base = await realpath(path === "" ? homedir() : path);
	const dirs = (await readdir(base, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
	const parent = dirname(base);
	return {
		path: base,
		parent: parent === base ? void 0 : parent,
		dirs
	};
}
async function git(cwd, args, allowExit1 = false) {
	try {
		const { stdout } = await exec$2("git", [
			"-C",
			cwd,
			...args
		], {
			maxBuffer: 2e7,
			timeout: 3e4,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0"
			}
		});
		return stdout;
	} catch (error) {
		const failure = error;
		if (allowExit1 && failure.code === 1) return failure.stdout ?? "";
		throw new HttpError(400, (failure.stderr ?? failure.message).trim() || failure.message);
	}
}
/** `git status` as structured rows. */
async function gitStatus(cwd) {
	await resolveIn(cwd, ".");
	if (!await git(cwd, ["rev-parse", "--is-inside-work-tree"]).then((out) => out.trim() === "true", () => false)) return {
		isRepo: false,
		branch: "",
		changes: []
	};
	const parts = (await git(cwd, [
		"status",
		"--porcelain=v1",
		"-z",
		"-b",
		"--untracked-files=all"
	])).split("\0").filter((part) => part !== "");
	const branch = (parts.shift() ?? "").replace(/^## /, "").replace(/^No commits yet on /, "").split("...")[0] ?? "";
	const changes = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i] ?? "";
		const index = entry[0] ?? " ";
		const worktree = entry[1] ?? " ";
		changes.push({
			path: entry.slice(3),
			index,
			worktree
		});
		if (index === "R" || index === "C") i++;
	}
	return {
		isRepo: true,
		branch,
		changes
	};
}
/** Diff of one path against the index (`staged` false) or HEAD (`staged` true); untracked files diff against nothing. */
async function gitDiff(cwd, path, staged, untracked) {
	const absolute = await resolveIn(cwd, path);
	if (untracked) return git(cwd, [
		"diff",
		"--no-color",
		"--no-index",
		"--",
		"/dev/null",
		absolute
	], true);
	return git(cwd, [
		"diff",
		"--no-color",
		...staged ? ["--cached"] : [],
		"--",
		path
	]);
}
/** The latest commits of the current branch. */
async function gitLog(cwd, limit = 30) {
	await resolveIn(cwd, ".");
	return (await git(cwd, [
		"log",
		`-${limit}`,
		"--format=%H%x1f%s%x1f%an%x1f%aI"
	]).catch(() => "")).split("\n").filter((line) => line !== "").map((line) => {
		const [hash = "", subject = "", author = "", date = ""] = line.split("");
		return {
			hash,
			subject,
			author,
			date
		};
	});
}
/** Local branches and the current one. */
async function gitBranches(cwd) {
	await resolveIn(cwd, ".");
	const rows = (await git(cwd, ["branch", "--format=%(refname:short)%09%(HEAD)"])).split("\n").filter((line) => line !== "").map((line) => line.split("	"));
	return {
		current: rows.find((row) => row[1] === "*")?.[0] ?? "",
		branches: rows.map((row) => row[0] ?? "")
	};
}
const REF = /^[A-Za-z0-9._\/-]+$/;
function checkRef(name) {
	if (name.startsWith("-") || !REF.test(name)) throw new HttpError(400, "invalid branch or commit name");
	return name;
}
/** Remotes, upstream and how far the current branch is ahead of or behind it. */
async function gitRemote(cwd) {
	await resolveIn(cwd, ".");
	const remotes = (await git(cwd, ["remote"]).catch(() => "")).split("\n").filter((line) => line !== "");
	const upstream = (await git(cwd, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{u}"
	]).catch(() => "")).trim() || void 0;
	let ahead = 0;
	let behind = 0;
	if (upstream !== void 0) {
		const [left = "0", right = "0"] = (await git(cwd, [
			"rev-list",
			"--left-right",
			"--count",
			`${upstream}...HEAD`
		]).catch(() => "0	0")).trim().split(/\s+/);
		behind = Number(left);
		ahead = Number(right);
	}
	return {
		remotes,
		upstream,
		ahead,
		behind
	};
}
/** Files and diff of one commit. */
async function gitShow(cwd, hash) {
	await resolveIn(cwd, ".");
	checkRef(hash);
	return {
		files: (await git(cwd, [
			"show",
			"--format=",
			"--name-only",
			hash
		])).split("\n").filter((line) => line !== ""),
		diff: await git(cwd, [
			"show",
			"--format=%h %s%n%an, %aI%n",
			"--no-color",
			hash
		])
	};
}
/** Files and diff of `head` against its merge base with `base`. */
async function gitCompare(cwd, base, head) {
	await resolveIn(cwd, ".");
	const range = `${checkRef(base)}...${checkRef(head)}`;
	return {
		files: (await git(cwd, [
			"diff",
			"--name-only",
			range
		])).split("\n").filter((line) => line !== ""),
		diff: await git(cwd, [
			"diff",
			"--no-color",
			range
		])
	};
}
/**
* Draft a commit message for the staged changes with the Claude executable (`-p`, diff on stdin).
* Runs only when the user presses the button; the diff goes to the user's own Claude.
*/
async function gitDraftMessage(cwd, executable) {
	await resolveIn(cwd, ".");
	const diff = await git(cwd, [
		"diff",
		"--cached",
		"--no-color"
	]);
	if (diff.trim() === "") throw new HttpError(400, "nothing is staged");
	const prompt = "Write a concise git commit message (an imperative subject line of at most 72 characters, optionally a blank line and a short body) for this staged diff. Reply with the message only.";
	return await new Promise((resolveMessage, reject) => {
		execFile(executable === "" ? "claude" : executable, ["-p", prompt], {
			cwd,
			timeout: 9e4,
			maxBuffer: 5e6
		}, (error, stdout, stderr) => {
			if (error !== null) reject(new HttpError(502, (stderr || error.message).trim()));
			else resolveMessage(stdout.trim().replace(/^```\w*\n?|\n?```$/g, "").trim());
		}).stdin?.end(diff.slice(0, 6e4));
	});
}
/** Run one git action. */
async function gitAction(body) {
	if (body.action === "init") {
		await resolveIn(body.cwd, ".");
		await git(body.cwd, [
			"init",
			"-q",
			"-b",
			"main"
		]);
		return { ok: true };
	}
	await resolveIn(body.cwd, ".");
	switch (body.action) {
		case "stage":
			await git(body.cwd, [
				"add",
				"--",
				...body.paths
			]);
			break;
		case "unstage":
			await git(body.cwd, [
				"reset",
				"-q",
				"HEAD",
				"--",
				...body.paths
			]).catch(() => git(body.cwd, [
				"rm",
				"--cached",
				"-q",
				"-r",
				"--",
				...body.paths
			]));
			break;
		case "discard": {
			const status = await gitStatus(body.cwd);
			const untracked = new Set(status.changes.filter((change) => change.index === "?").map((change) => change.path));
			const tracked = body.paths.filter((path) => !untracked.has(path));
			const fresh = body.paths.filter((path) => untracked.has(path));
			if (tracked.length > 0) {
				const added = status.changes.filter((change) => tracked.includes(change.path) && change.index === "A").map((change) => change.path);
				const restorable = tracked.filter((path) => !added.includes(path));
				if (added.length > 0) await git(body.cwd, [
					"rm",
					"-q",
					"-f",
					"--",
					...added
				]);
				if (restorable.length > 0) await git(body.cwd, [
					"restore",
					"--source=HEAD",
					"--staged",
					"--worktree",
					"--",
					...restorable
				]);
			}
			if (fresh.length > 0) await git(body.cwd, [
				"clean",
				"-f",
				"-q",
				"--",
				...fresh
			]);
			break;
		}
		case "commit":
			if (body.message.trim() === "") throw new HttpError(400, "commit message is empty");
			await git(body.cwd, [
				"commit",
				"-m",
				body.message
			]);
			break;
		case "checkout":
			if (body.branch.startsWith("-") || body.branch.trim() === "") throw new HttpError(400, "invalid branch name");
			await git(body.cwd, body.create === true ? [
				"checkout",
				"-b",
				body.branch
			] : ["checkout", body.branch]);
			break;
		case "deleteBranch":
			await git(body.cwd, [
				"branch",
				body.force === true ? "-D" : "-d",
				checkRef(body.branch)
			]);
			break;
		case "fetch":
			await git(body.cwd, ["fetch", "--prune"]);
			break;
		case "pull":
			await git(body.cwd, ["pull", "--ff-only"]);
			break;
		case "push":
			await git(body.cwd, ["push"]);
			break;
		case "publish": {
			const branch = (await git(body.cwd, ["branch", "--show-current"])).trim();
			const remote = (await git(body.cwd, ["remote"])).split("\n")[0]?.trim();
			if (remote === void 0 || remote === "") throw new HttpError(400, "this repository has no remote");
			await git(body.cwd, [
				"push",
				"-u",
				remote,
				branch
			]);
			break;
		}
		case "initialCommit":
			await git(body.cwd, ["add", "-A"]);
			await git(body.cwd, [
				"commit",
				"-m",
				"Initial commit"
			]);
			break;
		case "undoLastCommit":
			await git(body.cwd, [
				"reset",
				"--soft",
				"HEAD~1"
			]);
			break;
	}
	return { ok: true };
}
/** Shell sessions keyed by id; they outlive tab switches and are all killed with the plugin. */
var TerminalManager = class {
	#terminals = /* @__PURE__ */ new Map();
	open(cwd, cols, rows) {
		const pty = createRequire(import.meta.url)("@lydell/node-pty");
		const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== void 0 && !SECRET_ENV.test(key)));
		const shell = process.env["SHELL"] ?? "/bin/zsh";
		const process_ = pty.spawn(shell, ["-l"], {
			name: "xterm-256color",
			cols,
			rows,
			cwd: cwd === "" ? homedir() : cwd,
			env: {
				...env,
				TERM: "xterm-256color"
			}
		});
		const id = randomUUID();
		const terminal = {
			pty: process_,
			listeners: /* @__PURE__ */ new Set(),
			replay: "",
			exit: void 0
		};
		process_.onData((data) => {
			terminal.replay = (terminal.replay + data).slice(-2e5);
			for (const listener of terminal.listeners) listener({ data });
		});
		process_.onExit(({ exitCode }) => {
			terminal.exit = exitCode;
			for (const listener of terminal.listeners) listener({ exit: exitCode });
		});
		this.#terminals.set(id, terminal);
		return id;
	}
	#get(id) {
		const terminal = this.#terminals.get(id);
		if (terminal === void 0) throw new HttpError(404, "unknown terminal");
		return terminal;
	}
	subscribe(id, listener) {
		const terminal = this.#get(id);
		if (terminal.replay !== "") listener({ data: terminal.replay });
		if (terminal.exit !== void 0) listener({ exit: terminal.exit });
		terminal.listeners.add(listener);
		return () => {
			terminal.listeners.delete(listener);
		};
	}
	input(id, data) {
		const terminal = this.#get(id);
		if (terminal.exit === void 0) terminal.pty.write(data);
	}
	resize(id, cols, rows) {
		const terminal = this.#get(id);
		if (terminal.exit === void 0) terminal.pty.resize(Math.max(2, cols), Math.max(2, rows));
	}
	close(id) {
		const terminal = this.#terminals.get(id);
		if (terminal === void 0) return;
		if (terminal.exit === void 0) terminal.pty.kill();
		this.#terminals.delete(id);
	}
	closeAll() {
		for (const id of [...this.#terminals.keys()]) this.close(id);
	}
};
/** The worktrees of the repository, the first being the main one. */
async function gitWorktrees(cwd) {
	await resolveIn(cwd, ".");
	const out = await git(cwd, [
		"worktree",
		"list",
		"--porcelain"
	]);
	const result = [];
	for (const block of out.split("\n\n")) {
		const lines = block.split("\n").filter((line) => line !== "");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
		if (path === void 0) continue;
		result.push({
			path,
			branch: lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? "",
			head: (lines.find((line) => line.startsWith("HEAD ")) ?? "").slice(5, 12),
			main: result.length === 0,
			locked: lines.some((line) => line.startsWith("locked"))
		});
	}
	return result;
}
/** Create, remove or merge a worktree. New worktrees go to `<repo>-worktrees/<branch>` unless a path is given. */
async function gitWorktreeAction(body) {
	await resolveIn(body.cwd, ".");
	const list = await gitWorktrees(body.cwd);
	const main = list[0]?.path ?? body.cwd;
	switch (body.action) {
		case "create": {
			const branch = checkRef(body.branch);
			const path = body.path ?? join(`${main}-worktrees`, branch.replace(/\//g, "-"));
			await mkdir(dirname(path), { recursive: true });
			await git(main, [
				"worktree",
				"add",
				"-b",
				branch,
				path
			]);
			return {
				ok: true,
				path
			};
		}
		case "remove":
			if (!list.some((item) => item.path === body.path && !item.main)) throw new HttpError(400, "not a linked worktree of this repository");
			await git(main, [
				"worktree",
				"remove",
				...body.force === true ? ["--force"] : [],
				body.path
			]);
			return { ok: true };
		case "merge":
			await git(main, [
				"merge",
				"--no-ff",
				"--no-edit",
				checkRef(body.branch)
			]);
			return { ok: true };
	}
}
/** Clone a repository into a new folder under `parent`. */
async function gitClone(url, parent, name) {
	if (!/^(https?:\/\/|git@|ssh:\/\/|\/|file:\/\/)/.test(url) || url.startsWith("-")) throw new HttpError(400, "unsupported repository address");
	if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new HttpError(400, "invalid folder name");
	const target = join(await realpath(parent).catch(() => {
		throw new HttpError(400, "the parent folder does not exist");
	}), name);
	if (await stat(target).then(() => true, () => false)) throw new HttpError(409, "the folder already exists");
	try {
		await exec$2("git", [
			"clone",
			"--",
			url,
			target
		], {
			timeout: 6e5,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0"
			}
		});
	} catch (error) {
		const failure = error;
		throw new HttpError(400, (failure.stderr ?? failure.message).trim().split("\n").slice(-3).join(" "));
	}
	return { path: target };
}
//#endregion
//#region src/taskmaster.ts
/**
* TaskMaster support: reads and edits the `.taskmaster` folder of a project and runs the `task-master-ai`
* command for the operations that need a model (adding a task, updating one, parsing a PRD).
* @module dsh-agent-bridge/taskmaster
*/
const exec$1 = promisify(execFile);
/** Pinned so a new upstream release cannot change what runs on this machine. The package's own bin is its MCP server; the command line is `task-master`. */
const PACKAGE = "task-master-ai@0.43.0";
const STATUSES = new Set([
	"pending",
	"in-progress",
	"done",
	"review",
	"deferred",
	"cancelled",
	"blocked"
]);
const PRD_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.(md|txt)$/;
const folder = (cwd) => join(cwd, ".taskmaster");
const tasksFile = (cwd) => join(folder(cwd), "tasks", "tasks.json");
const docsDir = (cwd) => join(folder(cwd), "docs");
function toTask(raw, parent) {
	const id = parent === void 0 ? String(raw["id"]) : `${parent}.${String(raw["id"])}`;
	const subtasks = Array.isArray(raw["subtasks"]) ? raw["subtasks"].map((item) => toTask(item, id)) : [];
	return {
		id,
		title: String(raw["title"] ?? ""),
		description: String(raw["description"] ?? ""),
		status: String(raw["status"] ?? "pending"),
		priority: String(raw["priority"] ?? ""),
		dependencies: Array.isArray(raw["dependencies"]) ? raw["dependencies"].map(String) : [],
		subtasks
	};
}
/** Both layouts of tasks.json: `{ tasks: [] }` and tagged `{ master: { tasks: [] }, ... }`. */
function tagged(data) {
	if (Array.isArray(data["tasks"])) return { master: data["tasks"] };
	const result = {};
	for (const [tag, value] of Object.entries(data)) {
		const tasks = value?.["tasks"];
		if (Array.isArray(tasks)) result[tag] = tasks;
	}
	return result;
}
async function readData(cwd) {
	try {
		return JSON.parse(await readFile(tasksFile(cwd), "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw new HttpError(422, "tasks.json is not valid JSON");
	}
}
/** The tasks of one tag plus the PRD files of the project. */
async function readTasks(cwd, tag) {
	await resolveIn(cwd, ".");
	const prds = (await readdir(docsDir(cwd)).catch(() => [])).filter((name) => PRD_NAME.test(name)).sort();
	const initialized = await stat(folder(cwd)).then((info) => info.isDirectory(), () => false);
	const data = await readData(cwd);
	if (data === void 0) return {
		initialized,
		tags: [],
		tag: tag ?? "master",
		tasks: [],
		prds
	};
	const byTag = tagged(data);
	const tags = Object.keys(byTag);
	const chosen = tag !== void 0 && tag in byTag ? tag : tags.includes("master") ? "master" : tags[0] ?? "master";
	return {
		initialized,
		tags,
		tag: chosen,
		tasks: (byTag[chosen] ?? []).map((item) => toTask(item)),
		prds
	};
}
/** Set the status of a task (`3`) or subtask (`3.2`) directly in tasks.json. */
async function setStatus(cwd, id, status, tag) {
	if (!STATUSES.has(status)) throw new HttpError(400, `unknown status: ${status}`);
	await resolveIn(cwd, ".");
	const data = await readData(cwd);
	if (data === void 0) throw new HttpError(404, "no tasks.json in this project");
	const byTag = tagged(data);
	const chosen = tag !== void 0 && tag in byTag ? tag : "master" in byTag ? "master" : Object.keys(byTag)[0];
	const [taskId, subId] = id.split(".");
	const task = (chosen === void 0 ? [] : byTag[chosen] ?? []).find((item) => String(item["id"]) === taskId);
	if (task === void 0) throw new HttpError(404, `task ${id} not found`);
	if (subId === void 0) task["status"] = status;
	else {
		const sub = (Array.isArray(task["subtasks"]) ? task["subtasks"] : []).find((item) => String(item["id"]) === subId);
		if (sub === void 0) throw new HttpError(404, `subtask ${id} not found`);
		sub["status"] = status;
	}
	const temporary = `${tasksFile(cwd)}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
	await rename(temporary, tasksFile(cwd));
}
async function prdPath(cwd, file) {
	if (!PRD_NAME.test(file)) throw new HttpError(400, "a PRD file name is letters, digits, dot, dash or space, ending in .md or .txt");
	await resolveIn(cwd, ".");
	return join(docsDir(cwd), file);
}
/** Run `task-master-ai` in the project; `command` is replaceable for tests. */
async function runCli(command, cwd, args) {
	await resolveIn(cwd, ".");
	try {
		const { stdout } = await exec$1(command, command === "npx" ? [
			"-y",
			"-p",
			PACKAGE,
			"task-master",
			...args
		] : [...args], {
			cwd,
			timeout: 3e5,
			maxBuffer: 1e7,
			env: {
				...process.env,
				TASKMASTER_SKIP_AUTO_UPDATE: "1"
			}
		});
		return stdout;
	} catch (error) {
		const failure = error;
		throw new HttpError(502, (failure.stderr || failure.stdout || failure.message).trim().split("\n").slice(-6).join("\n"));
	}
}
/** Run one tasks action. */
async function tasksAction(body, command = "npx") {
	const tagArgs = (tag) => tag === void 0 || !/^[A-Za-z0-9_-]+$/.test(tag) ? [] : [`--tag=${tag}`];
	switch (body.action) {
		case "init": return {
			ok: true,
			output: await runCli(command, body.cwd, ["init", "--yes"])
		};
		case "status":
			await setStatus(body.cwd, body.id, body.status, body.tag);
			return { ok: true };
		case "add":
			if (body.prompt.trim() === "") throw new HttpError(400, "the prompt is empty");
			return {
				ok: true,
				output: await runCli(command, body.cwd, [
					"add-task",
					`--prompt=${body.prompt}`,
					...tagArgs(body.tag)
				])
			};
		case "update":
			if (!/^[0-9]+(\.[0-9]+)?$/.test(body.id) || body.prompt.trim() === "") throw new HttpError(400, "invalid task id or empty prompt");
			return {
				ok: true,
				output: await runCli(command, body.cwd, [
					"update-task",
					`--id=${body.id}`,
					`--prompt=${body.prompt}`,
					...tagArgs(body.tag)
				])
			};
		case "parse": {
			const path = await prdPath(body.cwd, body.file);
			if (!await stat(path).then(() => true, () => false)) throw new HttpError(404, "no such PRD file");
			return {
				ok: true,
				output: await runCli(command, body.cwd, [
					"parse-prd",
					path,
					...tagArgs(body.tag)
				])
			};
		}
		case "prd-read": return {
			ok: true,
			content: await readFile(await prdPath(body.cwd, body.file), "utf8").catch(() => {
				throw new HttpError(404, "no such PRD file");
			})
		};
		case "prd-write": {
			const path = await prdPath(body.cwd, body.file);
			await mkdir(docsDir(body.cwd), { recursive: true });
			await writeFile(path, body.content);
			return { ok: true };
		}
		case "prd-delete":
			await rm(await prdPath(body.cwd, body.file), { force: true });
			return { ok: true };
	}
}
//#endregion
//#region src/voice.ts
const AUDIO_LIMIT = 25e6;
const SPEECH_LIMIT = 4e3;
const EXTENSION = {
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav"
};
function endpoint(config, path) {
	if (config.baseUrl.trim() === "") throw new HttpError(404, "voice is not configured");
	const key = config.apiKeyEnv === "" ? void 0 : process.env[config.apiKeyEnv];
	return {
		url: `${config.baseUrl.replace(/\/$/, "")}${path}`,
		headers: key === void 0 || key === "" ? {} : { authorization: `Bearer ${key}` }
	};
}
/**
* Run one voice action.
* @param body - the request.
* @param config - backend settings.
* @param fetchImpl - replaceable in tests.
* @returns the transcript, or the spoken audio.
*/
async function voiceAction(body, config, fetchImpl = fetch) {
	if (body.action === "transcribe") {
		const { url, headers } = endpoint(config, "/v1/audio/transcriptions");
		const audio = Buffer.from(body.base64, "base64");
		if (audio.length === 0 || audio.length > AUDIO_LIMIT) throw new HttpError(413, "the recording is empty or too large");
		const form = new FormData();
		form.set("model", config.sttModel);
		form.set("file", new Blob([audio], { type: body.mime }), `speech.${EXTENSION[body.mime.split(";")[0] ?? ""] ?? "webm"}`);
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: form,
			redirect: "manual",
			signal: AbortSignal.timeout(3e5)
		});
		if (!response.ok) throw new HttpError(502, `speech backend: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
		return { text: (await response.json()).text ?? "" };
	}
	const { url, headers } = endpoint(config, "/v1/audio/speech");
	const text = body.text.slice(0, SPEECH_LIMIT);
	if (text.trim() === "") throw new HttpError(400, "nothing to speak");
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			...headers,
			"content-type": "application/json"
		},
		redirect: "manual",
		body: JSON.stringify({
			model: config.ttsModel,
			voice: config.ttsVoice,
			input: text,
			response_format: "mp3"
		}),
		signal: AbortSignal.timeout(3e5)
	});
	if (!response.ok) throw new HttpError(502, `speech backend: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
	return {
		mime: response.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg",
		base64: Buffer.from(await response.arrayBuffer()).toString("base64")
	};
}
//#endregion
//#region src/watch.ts
/**
* Server-sent stream that tells the page when a session file grew.
* @module dsh-agent-bridge/watch
*/
/**
* Stream a `changed` event whenever the file's size moves away from its size at open. The file may
* be missing: Codex compresses idle rollouts to `<path>.zst` and writes `<path>` again when the
* thread resumes, so a missing file counts as size 0 and its reappearance is reported.
* @param file - session file to watch.
* @param intervalMs - polling interval.
* @param signal - aborts the watch when the client goes away.
* @returns the event-stream response.
*/
function watchStream(file, intervalMs, signal) {
	const encoder = new TextEncoder();
	const baseline = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
	let release;
	const body = new ReadableStream({
		start(controller) {
			const listener = (current) => {
				if (current.size === baseline) return;
				const event = {
					changed: true,
					size: current.size
				};
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			watchFile(file, { interval: intervalMs }, listener);
			release = () => {
				unwatchFile(file, listener);
			};
			signal.addEventListener("abort", () => release?.(), { once: true });
			controller.enqueue(encoder.encode(": watching\n\n"));
		},
		cancel: () => release?.()
	});
	return new Response(body, { headers: {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		"x-accel-buffering": "no"
	} });
}
//#endregion
//#region src/commands.ts
/**
* Lookup of the command-line tools the plugin starts (Claude Code, Codex, Peekaboo).
* @module dsh-agent-bridge/commands
*/
/** Install directories searched after PATH: a desktop app launched from Finder or the Dock inherits a short PATH. */
const INSTALL_DIRS = [
	join(homedir(), ".local", "bin"),
	join(homedir(), ".claude", "local"),
	"/opt/homebrew/bin",
	"/usr/local/bin"
];
function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
	} catch {
		return false;
	}
	return statSync(path).isFile();
}
/**
* Turn a configured command into the path to start.
* @param command - a bare name such as `claude`, or a path; a value containing `/` is used as written.
* @param env - environment whose PATH is searched first.
* @param extraDirs - directories searched after PATH.
* @returns the first executable match, or `command` unchanged when nothing matches so the start error names it.
*/
function resolveCommand(command, env = process.env, extraDirs = INSTALL_DIRS) {
	if (command.includes("/")) return command;
	return [...(env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== ""), ...extraDirs].map((dir) => join(dir, command)).find(isExecutable) ?? command;
}
//#endregion
//#region src/extras.ts
/**
* Small host services around the sessions: persisted state (drafts, archive), attachments,
* MCP servers and skills of the Claude configuration, and the global git identity.
* @module dsh-agent-bridge/extras
*/
const exec = promisify(execFile);
/**
* Where the state file lives: next to the dsh home, never inside a session directory.
* @param plugin - directory name; `external-engines` is where releases before the rename wrote it.
* @returns the absolute state file path.
*/
function defaultStatePath(plugin = "agent-bridge") {
	return join(process.env["DSH_HOME"] ?? join(homedir(), ".dsh"), plugin, "state.json");
}
/**
* JSON file with whole-file atomic replacement. While `path` does not exist the store starts from `legacyPath`
* (the file of the plugin's previous name); the first `set` then writes everything to `path` and leaves the
* legacy file unchanged.
*/
var StateStore = class {
	constructor(path, legacyPath) {
		this.path = path;
		this.state = {
			drafts: {},
			choices: {},
			archived: [],
			pinned: [],
			scheduled: []
		};
		const source = legacyPath !== void 0 && !existsSync(path) ? legacyPath : path;
		try {
			this.state = {
				...this.state,
				...JSON.parse(readFileSync(source, "utf8"))
			};
		} catch {}
	}
	get(key) {
		return this.state[key];
	}
	set(key, value) {
		this.state = {
			...this.state,
			[key]: value
		};
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(this.state), { mode: 384 });
		renameSync(temporary, this.path);
	}
};
/** The Claude executable and the environment the CLI needs (the login lookup wants USER). */
function cliEnv() {
	const name = userInfo().username;
	return {
		...process.env,
		USER: process.env["USER"] ?? name,
		LOGNAME: process.env["LOGNAME"] ?? name
	};
}
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Run `claude mcp add-json` / `remove`; the CLI owns the configuration files. */
async function mcpChange(executable, body) {
	if (!SAFE_NAME.test(body.name)) throw new HttpError(400, "invalid server name");
	const args = body.action === "add" ? [
		"mcp",
		"add-json",
		"--scope",
		body.scope,
		body.name,
		JSON.stringify(body.config)
	] : [
		"mcp",
		"remove",
		"--scope",
		body.scope,
		body.name
	];
	try {
		await exec(executable === "" ? "claude" : executable, args, {
			cwd: statSync(body.cwd, { throwIfNoEntry: false })?.isDirectory() === true ? body.cwd : homedir(),
			env: cliEnv(),
			timeout: 3e4
		});
	} catch (error) {
		const failure = error;
		throw new HttpError(400, (failure.stderr ?? failure.stdout ?? failure.message).trim() || failure.message);
	}
	return { ok: true };
}
function skillDir(cwd, scope) {
	return scope === "user" ? join(claudeConfigDir(), "skills") : join(cwd, ".claude", "skills");
}
/** Skills stored as `<dir>/<name>/SKILL.md` in the user and project scopes. */
async function listSkills(cwd) {
	const result = [];
	for (const scope of ["user", "project"]) {
		if (scope === "project" && cwd === "") continue;
		const root = skillDir(cwd, scope);
		for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const text = await readFile(join(root, entry.name, "SKILL.md"), "utf8").catch(() => void 0);
			if (text === void 0) continue;
			const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
			result.push({
				name: entry.name,
				scope,
				description
			});
		}
	}
	return result;
}
/** Create or remove one skill folder. */
async function changeSkill(body) {
	if (!SAFE_NAME.test(body.name)) throw new HttpError(400, "invalid skill name");
	if (body.scope === "project" && body.cwd === "") throw new HttpError(400, "cwd is required for a project skill");
	const dir = join(skillDir(body.cwd, body.scope), body.name);
	if (body.action === "remove") {
		await rm(dir, {
			recursive: true,
			force: true
		});
		return { ok: true };
	}
	if (await readFile(join(dir, "SKILL.md"), "utf8").then(() => true, () => false)) throw new HttpError(409, "a skill with this name already exists");
	await mkdir(dir, { recursive: true });
	const description = body.description.replace(/\r?\n/g, " ").trim();
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${body.name}\ndescription: ${description}\n---\n\n${body.body}\n`);
	return { ok: true };
}
/** The global git identity (`user.name`, `user.email`). */
async function readGitConfig() {
	const read = async (key) => (await exec("git", [
		"config",
		"--global",
		"--get",
		key
	]).then((result) => result.stdout, () => "")).trim();
	return {
		name: await read("user.name"),
		email: await read("user.email")
	};
}
/** Set the global git identity. */
async function writeGitConfig(name, email) {
	if (/[\r\n]/.test(name + email)) throw new HttpError(400, "invalid value");
	if (name !== "") await exec("git", [
		"config",
		"--global",
		"user.name",
		name
	]);
	if (email !== "") await exec("git", [
		"config",
		"--global",
		"user.email",
		email
	]);
	return { ok: true };
}
const ATTACHMENT_LIMIT = 2e7;
const IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp"
]);
/** Write attachments to a private temp folder and describe them. */
async function prepareAttachments(attachments) {
	const list = attachments ?? [];
	if (list.length === 0) return {
		images: [],
		paths: [],
		imagePaths: [],
		note: ""
	};
	const dir = join(tmpdir(), "dsh-agent-bridge", randomUUID());
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const images = [];
	const paths = [];
	const imagePaths = [];
	const others = [];
	for (const [index, item] of list.entries()) {
		if (Buffer.byteLength(item.base64, "base64") > ATTACHMENT_LIMIT) throw new HttpError(413, `${item.name} is too large`);
		const path = join(dir, `${index}-${item.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || `file-${index}`}`);
		await writeFile(path, Buffer.from(item.base64, "base64"), { mode: 384 });
		paths.push(path);
		if (IMAGE_TYPES.has(item.mime)) {
			images.push({
				mime: item.mime,
				base64: item.base64
			});
			imagePaths.push(path);
		} else others.push(path);
	}
	return {
		images,
		paths,
		imagePaths,
		note: others.length === 0 ? "" : `\n\nAttached files:\n${others.map((path) => `- ${path}`).join("\n")}`
	};
}
/** How long a message may wait for a busy session before it is given up on. */
const SCHEDULE_PATIENCE_MS = 10 * 6e4;
/** Finished entries are kept this long so the list can show what happened. */
const SCHEDULE_KEEP_MS = 168 * 36e5;
/** Sends scheduled messages when they fall due. */
var Scheduler = class {
	/**
	* @param store - persisted state.
	* @param send - sends one message to its session; rejects when it cannot.
	* @param isRunning - whether a turn is already running in a session (the message then waits).
	* @param now - clock, replaceable in tests.
	*/
	constructor(store, send, isRunning, now = Date.now) {
		this.store = store;
		this.send = send;
		this.isRunning = isRunning;
		this.now = now;
		this.ticking = false;
	}
	list(sessionId) {
		return this.store.get("scheduled").filter((message) => message.sessionId === sessionId).sort((a, b) => a.at - b.at);
	}
	add(input) {
		if (input.text.trim() === "") throw new HttpError(400, "the message is empty");
		if (!Number.isFinite(input.at) || input.at < this.now() - 1e3) throw new HttpError(400, "the time is in the past");
		const message = {
			...input,
			id: randomUUID(),
			status: "pending"
		};
		this.store.set("scheduled", [...this.store.get("scheduled"), message]);
		return message;
	}
	cancel(id) {
		const all = this.store.get("scheduled");
		const target = all.find((message) => message.id === id);
		if (target === void 0 || target.status !== "pending") return false;
		this.store.set("scheduled", all.filter((message) => message.id !== id));
		return true;
	}
	/** Send everything that is due once; safe to call often. */
	async tick() {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = this.now();
			for (const message of this.store.get("scheduled").filter((item) => item.status === "pending" && item.at <= now)) {
				if (this.isRunning(message.sessionId)) {
					if (now - message.at > SCHEDULE_PATIENCE_MS) this.finish(message.id, "failed", "the session stayed busy");
					continue;
				}
				try {
					this.finish(message.id, "sent");
					await this.send(message);
				} catch (error) {
					this.finish(message.id, "failed", error instanceof Error ? error.message : String(error));
				}
			}
			const cutoff = now - SCHEDULE_KEEP_MS;
			const kept = this.store.get("scheduled").filter((message) => message.status === "pending" || message.at > cutoff);
			if (kept.length !== this.store.get("scheduled").length) this.store.set("scheduled", kept);
		} finally {
			this.ticking = false;
		}
	}
	finish(id, status, error) {
		this.store.set("scheduled", this.store.get("scheduled").map((message) => message.id === id ? {
			...message,
			status,
			...error === void 0 ? {} : { error }
		} : message));
	}
	start(intervalMs = 5e3) {
		this.stop();
		this.timer = setInterval(() => {
			this.tick();
		}, intervalMs);
	}
	stop() {
		if (this.timer !== void 0) clearInterval(this.timer);
		this.timer = void 0;
	}
};
//#endregion
//#region src/index.ts
/**
* dsh-agent-bridge, Host half. Serves Claude Code and Codex sessions to the browser half over the
* authenticated Connection Fetch channel: the session list, transcripts, live turns, session management,
* and a change feed for the transcript file.
* @module dsh-agent-bridge
*/
/** Stable plugin name (matches the `cordis.patch.yml` row id). */
const name = "agent-bridge";
/**
* The whole entry config is one volatile reference: a settings edit is committed into the running plugin
* instead of remounting it, so turns in progress survive it.
*/
const Config = Schema.object({
	enabled: Schema.boolean().default(true),
	sessionLimit: Schema.natural().min(1).default(100),
	watchIntervalMs: Schema.natural().min(50).default(500),
	claudeExecutable: Schema.string().default("claude"),
	defaultCwd: Schema.string().default(""),
	permissionMode: Schema.union([
		"default",
		"acceptEdits",
		"plan"
	]).default("default"),
	memoryFile: Schema.string().default(""),
	computerUse: Schema.boolean().default(true),
	browserUse: Schema.boolean().default(true),
	taskmasterCommand: Schema.string().default("npx"),
	voiceBaseUrl: Schema.string().default(""),
	voiceApiKeyEnv: Schema.string().default("VOICE_API_KEY"),
	voiceSttModel: Schema.string().default("whisper-1"),
	voiceTtsModel: Schema.string().default("tts-1"),
	voiceTtsVoice: Schema.string().default("alloy"),
	browserHeaded: Schema.boolean().default(false),
	peekabooCommand: Schema.string().default("peekaboo"),
	codexEnabled: Schema.boolean().default(true),
	codexExecutable: Schema.string().default("codex"),
	codexHistoryTurns: Schema.natural().min(1).default(20),
	codexApprovalPolicy: Schema.union(["untrusted", "on-request"]).default("untrusted"),
	codexSandbox: Schema.union(["read-only", "workspace-write"]).default("workspace-write"),
	allowedTools: Schema.array(Schema.string()).default([])
}).volatile();
/** Services this plugin requires. */
const inject = ["connection"];
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	});
}
function parseId(id) {
	if (id.startsWith("claude:")) return {
		engine: "claude",
		raw: id.slice(7)
	};
	if (id.startsWith("codex:")) return {
		engine: "codex",
		raw: id.slice(6)
	};
}
function idOf(request) {
	return parseId(new URL(request.url, "http://host").searchParams.get("id") ?? "");
}
function prefixed(engine, raw) {
	return `${engine === "claude" ? CLAUDE_ID_PREFIX : CODEX_ID_PREFIX}${raw}`;
}
async function watchResponse(request, intervalMs, driverOf) {
	const parsed = idOf(request);
	const file = parsed === void 0 ? void 0 : await driverOf(parsed.engine).findFile(parsed.raw);
	if (file === void 0) return json({ error: "unknown session" }, 404);
	return watchStream(file, intervalMs, request.signal);
}
function homedirOf(settings) {
	return settings.defaultCwd === "" ? homedir() : settings.defaultCwd;
}
function turnOptions(settings, sessionId, text, cwd, memory = "", extra = {}) {
	return {
		...extra,
		...sessionId === void 0 ? {} : { sessionId },
		cwd,
		text,
		executable: settings.claudeExecutable,
		permissionMode: settings.permissionMode,
		allowedTools: settings.allowedTools,
		computerUse: settings.computerUse,
		browserUse: settings.browserUse,
		browserHeaded: settings.browserHeaded,
		peekabooCommand: settings.peekabooCommand,
		memory
	};
}
function liveResponse(request, driverOf) {
	const parsed = idOf(request);
	if (parsed === void 0) return json({ error: "unknown session" }, 404);
	const encoder = new TextEncoder();
	let release;
	const body = new ReadableStream({
		start(controller) {
			const send = (event) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			release = driverOf(parsed.engine).subscribe(parsed.raw, send);
			request.signal.addEventListener("abort", () => release?.(), { once: true });
		},
		cancel: () => release?.()
	});
	return new Response(body, { headers: {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		"x-accel-buffering": "no"
	} });
}
/**
* Register the routes.
* @param ctx - plugin context.
* @param config - configuration from the composition entry.
*/
function apply(ctx, config) {
	const current = () => {
		const settings = config.get();
		return {
			...settings,
			claudeExecutable: resolveCommand(settings.claudeExecutable),
			codexExecutable: resolveCommand(settings.codexExecutable),
			peekabooCommand: resolveCommand(settings.peekabooCommand)
		};
	};
	const connection = ctx.connection;
	const runs = new RunManager();
	let codexEngine;
	const codex = () => {
		codexEngine ??= new CodexEngine(current().codexExecutable);
		return codexEngine;
	};
	const store = new StateStore(process.env["AGENT_BRIDGE_STATE"] ?? defaultStatePath(), defaultStatePath("external-engines"));
	const terminals = new TerminalManager();
	ctx.effect(() => () => {
		terminals.closeAll();
		runs.closeAll();
		codexEngine?.closeAll();
	}, "agent-bridge: runs");
	const claudeDriver = {
		readMessages: async (id) => ({ messages: await readClaudeMessages(id) }),
		readGoal: readClaudeGoal,
		findFile: findClaudeFile,
		subscribe: (id, subscriber) => runs.subscribe(id, subscriber),
		isRunning: (id) => runs.isRunning(id),
		interrupt: (id) => runs.interrupt(id),
		answer: (id, requestId, body) => runs.answer(id, requestId, body.behavior === "allow" ? {
			behavior: "allow",
			...body.answers === void 0 ? {} : { answers: body.answers }
		} : { behavior: "deny" }),
		fork: forkClaudeSession,
		rename: renameClaudeSession,
		delete: deleteClaudeSession
	};
	const codexDriver = {
		readMessages: async (id) => {
			const turns = current().codexHistoryTurns;
			const page = await codex().readMessages(id, turns);
			return {
				messages: page.messages,
				...page.earlierOmitted ? { recentTurns: turns } : {}
			};
		},
		readGoal: (id) => codex().readGoal(id),
		findFile: (id) => codex().findFile(id),
		subscribe: (id, subscriber) => codex().subscribe(id, subscriber),
		isRunning: (id) => codex().isRunning(id),
		interrupt: (id) => codex().interrupt(id),
		answer: (id, requestId, body) => codex().answer(id, requestId, body.behavior === "allow" ? {
			behavior: "allow",
			...body.answers === void 0 ? {} : { answers: body.answers },
			...body.remember === true ? { remember: true } : {}
		} : { behavior: "deny" }),
		fork: (id) => codex().fork(id),
		rename: (id, title) => codex().rename(id, title),
		delete: (id) => codex().delete(id)
	};
	const driverOf = (engine) => engine === "claude" ? claudeDriver : codexDriver;
	const route = (path, handler, label, method = "GET") => {
		ctx.effect(() => connection.fetch.register({
			path,
			methods: method === "BOTH" ? ["GET", "POST"] : [method],
			requestBody: "buffered",
			fetch: async (request) => {
				if (!current().enabled) return json({ error: "disabled" }, 404);
				try {
					return await handler(request, current());
				} catch (error) {
					if (error instanceof HttpError) return json({ error: error.message }, error.status);
					return json({ error: error instanceof Error ? error.message : String(error) }, 500);
				}
			}
		}), `agent-bridge: ${label} route`);
	};
	route(SESSIONS_PATH, async (request, settings) => {
		const warnings = [];
		let codexRows = [];
		if (settings.codexEnabled) try {
			codexRows = await codex().listRows(settings.sessionLimit);
		} catch (error) {
			warnings.push(`codex: ${error instanceof Error ? error.message : String(error)}`);
		}
		const archived = new Set(store.get("archived"));
		const wantArchived = query(request, "archived") === "1";
		const rows = [...await listClaudeRows(settings.sessionLimit), ...codexRows].filter((row) => archived.has(row.id) === wantArchived).sort((a, b) => b.updatedAt - a.updatedAt);
		return json({
			sessions: rows,
			running: rows.filter((row) => {
				const parsed = parseId(row.id);
				return parsed !== void 0 && driverOf(parsed.engine).isRunning(parsed.raw);
			}).map((row) => row.id),
			pinned: store.get("pinned"),
			defaultCwd: homedirOf(settings),
			codexEnabled: settings.codexEnabled,
			warnings
		});
	}, "sessions");
	route(SESSION_PATH, async (request) => {
		const parsed = idOf(request);
		if (parsed === void 0) return json({ error: "unknown session" }, 404);
		const driver = driverOf(parsed.engine);
		const goal = await driver.readGoal(parsed.raw);
		const usage = parsed.engine === "claude" ? await readClaudeUsage(parsed.raw) : void 0;
		const page = await driver.readMessages(parsed.raw);
		return json({
			messages: page.messages,
			...page.recentTurns === void 0 ? {} : { recentTurns: page.recentTurns },
			...goal === void 0 ? {} : { goal },
			...usage === void 0 ? {} : { usage }
		});
	}, "session");
	route(WATCH_PATH, (request, settings) => watchResponse(request, settings.watchIntervalMs, driverOf), "watch");
	route(LIVE_PATH, (request) => liveResponse(request, driverOf), "live");
	const sendMessage = async (body, settings) => {
		const parsed = body.id === void 0 ? void 0 : parseId(body.id);
		const engine = parsed?.engine ?? body.engine ?? "claude";
		const knownCwd = body.cwd ?? (parsed?.engine === "claude" ? (await listClaudeRows(Math.max(settings.sessionLimit, 1e3))).find((row) => row.id === body.id)?.cwd : void 0);
		const cwd = knownCwd === void 0 || knownCwd === "" ? homedirOf(settings) : knownCwd;
		if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) throw new HttpError(400, `the working directory no longer exists: ${cwd}`);
		const attached = await prepareAttachments(body.attachments);
		const text = `${body.text}${attached.note}`;
		const clearDraft = () => {
			store.set("drafts", Object.fromEntries(Object.entries(store.get("drafts")).filter(([key]) => key !== (body.id ?? ""))));
		};
		if (engine === "codex") {
			if (!settings.codexEnabled) throw new HttpError(404, "codex is disabled");
			const id = await codex().start({
				...parsed === void 0 ? {} : { threadId: parsed.raw },
				cwd,
				text,
				approvalPolicy: settings.codexApprovalPolicy,
				sandbox: settings.codexSandbox,
				...body.model === void 0 ? {} : { model: body.model },
				...body.effort === void 0 ? {} : { effort: body.effort },
				images: attached.imagePaths
			});
			clearDraft();
			return { id: prefixed("codex", id) };
		}
		const memory = settings.memoryFile === "" ? "" : await readFile(settings.memoryFile, "utf8");
		const id = await runs.start(turnOptions(settings, parsed?.raw, text, cwd, memory, {
			...body.model === void 0 ? {} : { model: body.model },
			...body.effort === void 0 ? {} : { effort: body.effort },
			images: attached.images
		}));
		clearDraft();
		return { id: prefixed("claude", id) };
	};
	route(SEND_PATH, async (request, settings) => json(await sendMessage(await request.json(), settings)), "send", "POST");
	const scheduler = new Scheduler(store, async (message) => {
		await sendMessage({
			id: message.sessionId,
			cwd: message.cwd,
			text: message.text,
			...message.model === void 0 ? {} : { model: message.model },
			...message.effort === void 0 ? {} : { effort: message.effort }
		}, current());
	}, (sessionId) => {
		const parsed = parseId(sessionId);
		return parsed !== void 0 && driverOf(parsed.engine).isRunning(parsed.raw);
	});
	scheduler.start();
	ctx.effect(() => () => {
		scheduler.stop();
	}, "agent-bridge: scheduler");
	route(SCHEDULE_PATH, async (request) => {
		if (request.method === "GET") {
			const id = query(request, "id");
			return json({ messages: scheduler.list(id).map(({ id: messageId, sessionId, text, at, status, error }) => ({
				id: messageId,
				sessionId,
				text,
				at,
				status,
				...error === void 0 ? {} : { error }
			})) });
		}
		const body = await request.json();
		if (body.action === "cancel") return json({ ok: scheduler.cancel(body.id) });
		if (parseId(body.sessionId) === void 0) throw new HttpError(404, "unknown session");
		return json({ id: scheduler.add({
			sessionId: body.sessionId,
			cwd: body.cwd,
			text: body.text,
			at: body.at,
			...body.model === void 0 ? {} : { model: body.model },
			...body.effort === void 0 ? {} : { effort: body.effort }
		}).id });
	}, "schedule", "BOTH");
	route(ANSWER_PATH, async (request) => {
		const body = await request.json();
		const parsed = parseId(body.id);
		const found = parsed !== void 0 && driverOf(parsed.engine).answer(parsed.raw, body.requestId, body);
		return json({ ok: found }, found ? 200 : 404);
	}, "answer", "POST");
	route(MANAGE_PATH, async (request) => {
		const body = await request.json();
		const parsed = parseId(body.id);
		if (parsed === void 0) return json({ error: "unknown session" }, 404);
		const driver = driverOf(parsed.engine);
		if (driver.isRunning(parsed.raw)) return json({ error: "a turn is running in this session" }, 409);
		switch (body.action) {
			case "fork": return json({ id: prefixed(parsed.engine, await driver.fork(parsed.raw)) });
			case "rename":
				await driver.rename(parsed.raw, body.title ?? "");
				return json({ ok: true });
			case "delete":
				await driver.delete(parsed.raw);
				return json({ ok: true });
		}
	}, "manage", "POST");
	route(SCREEN_STATUS_PATH, async (_request, settings) => {
		const { stdout } = await promisify(execFile)(settings.peekabooCommand, [
			"permissions",
			"status",
			"--no-remote"
		], { timeout: 2e4 });
		const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => /(Granted|Denied|Not)/i.test(line));
		if (!settings.computerUse) return json({
			lines,
			tools: [],
			server: "disabled"
		});
		const probe = await probeTools(turnOptions(settings, void 0, "", homedirOf(settings)));
		return json({
			lines,
			tools: probe.tools.filter((tool) => tool.startsWith(`mcp__${SCREEN_SERVER}__`)).map((tool) => tool.slice(`mcp__${SCREEN_SERVER}__`.length)),
			server: probe.mcpServers.find((server) => server.name === "peekaboo-dsh")?.status ?? "missing"
		});
	}, "screen status");
	route(INTERRUPT_PATH, async (request) => {
		const parsed = parseId((await request.json()).id);
		const found = parsed !== void 0 && await driverOf(parsed.engine).interrupt(parsed.raw);
		return json({ ok: found }, found ? 200 : 404);
	}, "interrupt", "POST");
	const query = (request, key) => new URL(request.url).searchParams.get(key) ?? "";
	route(TERM_OPEN_PATH, async (request) => {
		const body = await request.json();
		return json({ tid: terminals.open(body.cwd, body.cols ?? 80, body.rows ?? 24) });
	}, "terminal open", "POST");
	route(TERM_STREAM_PATH, (request) => {
		const tid = query(request, "tid");
		const encoder = new TextEncoder();
		let release;
		const stream = new ReadableStream({
			start(controller) {
				release = terminals.subscribe(tid, (event) => {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				});
				request.signal.addEventListener("abort", () => release?.(), { once: true });
			},
			cancel: () => release?.()
		});
		return new Response(stream, { headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no"
		} });
	}, "terminal stream");
	route(TERM_INPUT_PATH, async (request) => {
		const body = await request.json();
		terminals.input(body.tid, body.data);
		return json({ ok: true });
	}, "terminal input", "POST");
	route(TERM_RESIZE_PATH, async (request) => {
		const body = await request.json();
		terminals.resize(body.tid, body.cols, body.rows);
		return json({ ok: true });
	}, "terminal resize", "POST");
	route(TERM_CLOSE_PATH, async (request) => {
		terminals.close((await request.json()).tid);
		return json({ ok: true });
	}, "terminal close", "POST");
	route(FS_LIST_PATH, async (request) => json({ entries: await listDir(query(request, "cwd"), query(request, "path")) }), "fs list");
	route(FS_READ_PATH, async (request) => json(await readText(query(request, "cwd"), query(request, "path"))), "fs read");
	route(FS_WRITE_PATH, async (request) => {
		const body = await request.json();
		return json(await writeText(body.cwd, body.path, body.content, body.baseMtimeMs));
	}, "fs write", "POST");
	route(FS_ACTION_PATH, async (request) => json(await fsAction(await request.json())), "fs action", "POST");
	route(FS_IMAGE_PATH, async (request) => json(await readImage(query(request, "cwd"), query(request, "path"))), "fs image");
	route(FS_BROWSE_PATH, async (request) => json(await browseDirs(query(request, "path"))), "fs browse");
	route(GIT_STATUS_PATH, async (request) => json(await gitStatus(query(request, "cwd"))), "git status");
	route(GIT_DIFF_PATH, async (request) => json({ diff: await gitDiff(query(request, "cwd"), query(request, "path"), query(request, "staged") === "1", query(request, "untracked") === "1") }), "git diff");
	route(GIT_LOG_PATH, async (request) => json({ commits: await gitLog(query(request, "cwd")) }), "git log");
	route(GIT_BRANCHES_PATH, async (request) => json(await gitBranches(query(request, "cwd"))), "git branches");
	route(GIT_REMOTE_PATH, async (request) => json(await gitRemote(query(request, "cwd"))), "git remote");
	route(GIT_SHOW_PATH, async (request) => json(await gitShow(query(request, "cwd"), query(request, "hash"))), "git show");
	route(GIT_COMPARE_PATH, async (request) => json(await gitCompare(query(request, "cwd"), query(request, "base"), query(request, "head"))), "git compare");
	route(GIT_MESSAGE_PATH, async (request, settings) => json({ message: await gitDraftMessage(query(request, "cwd"), settings.claudeExecutable) }), "git message");
	route(GIT_ACTION_PATH, async (request) => json(await gitAction(await request.json())), "git action", "POST");
	const infoCache = /* @__PURE__ */ new Map();
	const infoLoads = /* @__PURE__ */ new Map();
	route(INFO_PATH, async (request, settings) => {
		const engine = query(request, "engine") === "codex" ? "codex" : "claude";
		const asked = query(request, "cwd") || homedirOf(settings);
		const cwd = statSync(asked, { throwIfNoEntry: false })?.isDirectory() === true ? asked : homedir();
		const key = `${engine}:${cwd}`;
		const load = (force) => {
			const running = infoLoads.get(key);
			if (running !== void 0 && !force) return running;
			const started = (engine === "codex" ? codex().listModels().then(async (models) => ({
				models,
				commands: [],
				mcp: [],
				account: await codex().readAccount(),
				defaults: await codex().readDefaults(models)
			})) : probeInfo(turnOptions(settings, void 0, "", cwd))).then((info) => {
				if (infoLoads.get(key) === started) infoCache.set(key, {
					at: Date.now(),
					info
				});
				return info;
			}).finally(() => {
				if (infoLoads.get(key) === started) infoLoads.delete(key);
			});
			infoLoads.set(key, started);
			return started;
		};
		const cached = infoCache.get(key);
		const fresh = query(request, "fresh") === "1";
		if (cached === void 0 || fresh) return json(await load(fresh));
		if (Date.now() - cached.at >= 2e4) load(false).catch(() => {});
		return json(cached.info);
	}, "info");
	route(SEARCH_PATH, async (request, settings) => {
		const term = query(request, "q").trim();
		if (term.length < 2) return json({ hits: [] });
		const archived = new Set(store.get("archived"));
		const hits = await searchClaude((await listClaudeRows(settings.sessionLimit)).filter((row) => !archived.has(row.id)), term, 30);
		if (settings.codexEnabled) {
			for (const row of await codex().search(term, 20).catch(() => [])) if (!archived.has(row.id)) hits.push({
				id: row.id,
				title: row.title,
				snippet: "",
				cwd: row.cwd
			});
		}
		return json({ hits });
	}, "search");
	route(DRAFT_PATH, async (request) => {
		if (request.method === "GET") return json({ text: store.get("drafts")[query(request, "id")] ?? "" });
		const body = await request.json();
		const drafts = { ...store.get("drafts") };
		if (body.text === "") delete drafts[body.id];
		else drafts[body.id] = body.text.slice(0, 1e5);
		store.set("drafts", drafts);
		return json({ ok: true });
	}, "draft", "BOTH");
	route(CHOICE_PATH, async (request) => {
		if (request.method === "GET") return json(store.get("choices")[query(request, "engine")] ?? {
			model: "",
			effort: ""
		});
		const body = await request.json();
		if (body.engine !== "claude" && body.engine !== "codex" || typeof body.model !== "string" || typeof body.effort !== "string" || body.model.length > 200 || body.effort.length > 50) return json({ error: "invalid choice" }, 400);
		store.set("choices", {
			...store.get("choices"),
			[body.engine]: {
				model: body.model,
				effort: body.effort
			}
		});
		return json({ ok: true });
	}, "choice", "BOTH");
	route(ARCHIVE_PATH, async (request) => {
		const body = await request.json();
		if (parseId(body.id) === void 0) return json({ error: "unknown session" }, 404);
		const set = new Set(store.get("archived"));
		if (body.archived) set.add(body.id);
		else set.delete(body.id);
		store.set("archived", [...set]);
		return json({ ok: true });
	}, "archive", "POST");
	route(PIN_PATH, async (request) => {
		const body = await request.json();
		if (parseId(body.id) === void 0) return json({ error: "unknown session" }, 404);
		const set = new Set(store.get("pinned"));
		if (body.pinned) set.add(body.id);
		else set.delete(body.id);
		store.set("pinned", [...set]);
		return json({ ok: true });
	}, "pin", "POST");
	route(SKILLS_PATH, async (request) => {
		if (request.method === "GET") return json({ skills: await listSkills(query(request, "cwd")) });
		return json(await changeSkill(await request.json()));
	}, "skills", "BOTH");
	route(MCP_PATH, async (request, settings) => {
		const result = await mcpChange(settings.claudeExecutable, await request.json());
		infoCache.clear();
		infoLoads.clear();
		return json(result);
	}, "mcp change", "POST");
	route(GIT_CONFIG_PATH, async (request) => {
		if (request.method === "GET") return json(await readGitConfig());
		const body = await request.json();
		return json(await writeGitConfig(body.name, body.email));
	}, "git config", "BOTH");
	route(GIT_WORKTREES_PATH, async (request) => {
		if (request.method === "GET") return json({ worktrees: await gitWorktrees(query(request, "cwd")) });
		return json(await gitWorktreeAction(await request.json()));
	}, "worktrees", "BOTH");
	route(CLONE_PATH, async (request) => {
		const body = await request.json();
		return json(await gitClone(body.url, body.parent, body.name));
	}, "clone", "POST");
	route(TASKS_PATH, async (request, settings) => {
		if (request.method === "GET") return json(await readTasks(query(request, "cwd"), query(request, "tag") || void 0));
		return json(await tasksAction(await request.json(), settings.taskmasterCommand));
	}, "tasks", "BOTH");
	route(VOICE_PATH, async (request, settings) => {
		if (request.method === "GET") return json({ enabled: settings.voiceBaseUrl.trim() !== "" });
		return json(await voiceAction(await request.json(), {
			baseUrl: settings.voiceBaseUrl,
			apiKeyEnv: settings.voiceApiKeyEnv,
			sttModel: settings.voiceSttModel,
			ttsModel: settings.voiceTtsModel,
			ttsVoice: settings.voiceTtsVoice
		}));
	}, "voice", "BOTH");
}
//#endregion
export { Config, apply, inject, name };
