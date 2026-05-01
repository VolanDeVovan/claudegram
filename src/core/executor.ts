import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	Options,
	SDKMessage,
	SDKResultSuccess,
	SDKUserMessage,
	SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import {
	createSdkMcpServer,
	query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { getLogger } from "@logtape/logtape";
import type { Bot } from "grammy";
import type { ConfigManager } from "./config.ts";
import type { CoreToolDef } from "./core-tools.ts";
import type {
	BotContext,
	QueryEvent,
	QueryOpts,
	QueryResult,
	RenderContext,
	RenderResult,
	ResponseTarget,
	TokenUsage,
	ToolContext,
	TurnOutcome,
} from "./plugin-api.ts";
import { EMPTY_RESULT } from "./plugin-api.ts";
import type { LoadedPlugins } from "./plugin-loader.ts";
import { defaultRenderer } from "./response-renderer.ts";
import type { ScopeStore } from "./scope-store.ts";
import type { SessionManager } from "./session-manager.ts";

const log = getLogger(["bot", "executor"]);

function isScopeAllowed(
	scope: "self" | "all" | string[],
	project: string,
	isSelf: boolean,
): boolean {
	return (
		scope === "all" ||
		(scope === "self" && isSelf) ||
		(Array.isArray(scope) && scope.includes(project))
	);
}

const WATCHDOG_WARN_SEC = 60;
const WATCHDOG_LOG_INTERVAL_SEC = 30;

function startWatchdog(userId: string, project: string): () => void {
	let elapsed = 0;
	const interval = setInterval(() => {
		elapsed += WATCHDOG_LOG_INTERVAL_SEC;
		if (elapsed >= WATCHDOG_WARN_SEC) {
			log.warn("Query running for {elapsed}s", { userId, project, elapsed });
		}
	}, WATCHDOG_LOG_INTERVAL_SEC * 1000);
	return () => clearInterval(interval);
}

function loadSystemPrompt(botRoot: string): string {
	const path = resolve(botRoot, "SYSTEM.md");
	try {
		return readFileSync(path, "utf-8");
	} catch {
		log.warn("SYSTEM.md not found at {path}, using empty system prompt", {
			path,
		});
		return "";
	}
}

function createMcpServerConfig(tools: SdkMcpToolDefinition[]) {
	return createSdkMcpServer({
		name: "claudegram-core",
		version: "1.0.0",
		tools,
	});
}

export class Executor {
	private config: ConfigManager;
	private sessionManager: SessionManager;
	private bot: Bot<BotContext>;
	private scopeStore: ScopeStore;
	private botRoot: string;
	private pluginsDir: string;
	private coreTools: CoreToolDef[];
	private getLoadedPlugins: () => LoadedPlugins;
	private selfSystemPrompt: string;

	constructor(opts: {
		config: ConfigManager;
		sessionManager: SessionManager;
		bot: Bot<BotContext>;
		scopeStore: ScopeStore;
		botRoot: string;
		pluginsDir: string;
		coreTools: CoreToolDef[];
		getLoadedPlugins: () => LoadedPlugins;
	}) {
		this.config = opts.config;
		this.sessionManager = opts.sessionManager;
		this.bot = opts.bot;
		this.scopeStore = opts.scopeStore;
		this.botRoot = opts.botRoot;
		this.pluginsDir = opts.pluginsDir;
		this.coreTools = opts.coreTools;
		this.getLoadedPlugins = opts.getLoadedPlugins;
		this.selfSystemPrompt = loadSystemPrompt(this.botRoot);
	}

	async *executeQuery(
		opts: QueryOpts,
		target?: ResponseTarget,
	): AsyncIterable<QueryEvent> {
		const project = opts.project;
		const isSelf = project === "self";
		const projectConfig = this.config.data.projects.find(
			(p) => p.name === project,
		);
		const cwd = isSelf ? this.botRoot : (projectConfig?.path ?? this.botRoot);
		const model = projectConfig?.model ?? this.config.data.model;
		const loaded = this.getLoadedPlugins();

		// We always operate through our own AbortController. If the caller
		// provided an AbortSignal, forward its abort event to the local one;
		// this lets the SDK call abortController.abort() and have it actually
		// set signal.aborted (a synthetic { abort: dispatchEvent } only fires
		// listeners, it doesn't flip the aborted flag). The local controller
		// also stays referenced for the generator's lifetime — a signal from
		// an unreferenced controller can never abort.
		const ownController = new AbortController();
		const onExternalAbort = () => ownController.abort();
		if (opts.signal) {
			if (opts.signal.aborted) ownController.abort();
			else
				opts.signal.addEventListener("abort", onExternalAbort, { once: true });
		}
		const signal = ownController.signal;

		// Build ToolContext once per query
		const toolCtx: ToolContext = {
			bot: this.bot,
			config: this.config,
			scopeStore: this.scopeStore,
			query: this.createQueryFn(),
			sessions: this.sessionManager,
			userId: opts.userId,
			scope: opts.scope,
			project,
			cwd,
			signal,
			chatId: target?.chatId,
			messageThreadId: target?.messageThreadId,
		};

		// Track tool calls so `tool_end` events can carry the real tool name
		// (the SDK's tool_result block doesn't include it) and a duration.
		// Pair via callId, populated on tool_use, drained on tool_result.
		const toolCallTimers = new Map<string, { tool: string; start: number }>();

		// Build MCP server for tools (core + plugin)
		const allTools: SdkMcpToolDefinition[] = [];
		for (const tool of this.coreTools) {
			const scopeCfg = this.config.data.coreTools[tool.name] ?? tool.scope;
			if (!isScopeAllowed(scopeCfg, project, isSelf)) continue;
			const { scope: _scope, handler: coreHandler, ...rest } = tool;
			allTools.push({
				...rest,
				// SDK may hand a second `extra` arg (request context); no core
				// tool uses it. Widen CoreToolDef.handler if that changes.
				handler: (args) => coreHandler(args, toolCtx),
			});
		}
		for (const { tool } of loaded.tools) {
			const scope = tool.scope ?? "self";
			if (!isScopeAllowed(scope, project, isSelf)) continue;

			allTools.push({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.schema,
				handler: async (args) => {
					log.info("Tool call: {tool}", { tool: tool.name, args });
					const start = Date.now();
					const result = await tool.handler(args, toolCtx);
					const ms = Date.now() - start;
					log.info("Tool done: {tool} ({ms}ms)", { tool: tool.name, ms });
					return { content: [{ type: "text" as const, text: result }] };
				},
			});
		}

		// Build SDK options
		const sdkOptions: Options = {
			cwd,
			model,
			maxTurns: this.config.data.maxTurns,
			settingSources: ["user", "project", "local"],
			abortController: ownController,
			systemPrompt: isSelf ? this.selfSystemPrompt : undefined,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		};

		// Add MCP servers
		const mcpServers: Record<string, unknown> = {};
		if (allTools.length > 0) {
			mcpServers["claudegram-core"] = createMcpServerConfig(allTools);
		}

		// Add project MCP servers
		if (projectConfig?.mcpServers) {
			for (const server of projectConfig.mcpServers) {
				if ("url" in server) {
					mcpServers[server.name] = {
						type: server.type,
						url: server.url,
						headers: server.headers,
					};
				} else {
					mcpServers[server.name] = {
						command: server.command,
						args: server.args,
						env: server.env,
					};
				}
			}
		}

		if (Object.keys(mcpServers).length > 0) {
			sdkOptions.mcpServers = mcpServers;
		}

		// canUseTool sandbox for self project
		if (isSelf) {
			const dataDir = join(this.botRoot, "data");
			const configFile = join(dataDir, "config.jsonc");
			const srcDir = join(this.botRoot, "src");

			sdkOptions.canUseTool = async (tool, input) => {
				log.debug("SDK tool: {tool}", { tool, input });
				if (tool === "Write" || tool === "Edit") {
					const filePath = (input as Record<string, unknown>)
						.file_path as string;
					if (!filePath) return { behavior: "allow" as const };

					if (filePath.startsWith(this.pluginsDir)) {
						return { behavior: "allow" as const };
					}
					if (filePath === configFile || filePath.endsWith("config.jsonc")) {
						log.warn("Tool denied: {tool} on {path}", {
							tool,
							path: filePath,
						});
						return {
							behavior: "deny" as const,
							message:
								"Cannot edit config.jsonc directly. Use config_get and config_set tools to read and modify configuration.",
						};
					}
					if (filePath.startsWith(dataDir)) {
						log.warn("Tool denied: {tool} on {path}", {
							tool,
							path: filePath,
						});
						return {
							behavior: "deny" as const,
							message:
								"Cannot write to data/. Config: use config_set tool. Plugins: write to plugins/ directory.",
						};
					}
					if (filePath.startsWith(srcDir)) {
						log.warn("Tool denied: {tool} on {path}", {
							tool,
							path: filePath,
						});
						return {
							behavior: "deny" as const,
							message:
								"Cannot modify src/ — it is immutable. Write plugins to plugins/ instead. Use templates in src/templates/ as read-only references.",
						};
					}
					log.warn("Tool denied: {tool} on {path}", { tool, path: filePath });
					return {
						behavior: "deny" as const,
						message: `Writing is restricted to plugins/ only. You tried to write to ${filePath}.`,
					};
				}
				return { behavior: "allow" as const };
			};
		}

		// Session resume
		const sessionId = await this.sessionManager.getActiveSessionId(
			opts.scope,
			project,
		);
		if (sessionId) {
			sdkOptions.resume = sessionId;
		}

		const prompt: string | AsyncIterable<SDKUserMessage> =
			opts.channel ?? opts.message;

		log.info(
			"Query started for project {project}, model {model}, session {session}, streaming: {streaming}",
			{
				project,
				model,
				session: sessionId ? `resume ${sessionId}` : "new",
				streaming: !!opts.channel,
			},
		);

		const stopWatchdog = startWatchdog(opts.scope, project);
		const startTime = Date.now();
		// `totalText` is the running join of every text block seen so far,
		// separated by "\n\n" — matches the shape of `complete.text` so a
		// terminal we synthesize on error/abort is consistent with the SDK's
		// authoritative final text.
		let totalText = "";
		let resultSessionId: string | undefined;
		let turns = 0;
		let costUsd = 0;
		let textBlocksEmitted = 0;
		let usage: TokenUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		};
		let stopReason: string | null = null;

		function snapshotUsage(success: SDKResultSuccess): TokenUsage {
			const u = success.usage as Record<string, unknown>;
			return {
				inputTokens: Number(u.input_tokens ?? 0),
				outputTokens: Number(u.output_tokens ?? 0),
				cacheReadInputTokens: Number(u.cache_read_input_tokens ?? 0),
				cacheCreationInputTokens: Number(u.cache_creation_input_tokens ?? 0),
			};
		}

		function categorizeErrorCause(
			subtype: string | undefined,
		):
			| "transport"
			| "max_turns"
			| "max_budget"
			| "structured_output"
			| "execution"
			| "unknown" {
			switch (subtype) {
				case "error_max_turns":
					return "max_turns";
				case "error_max_budget_usd":
					return "max_budget";
				case "error_max_structured_output_retries":
					return "structured_output";
				case "error_during_execution":
					return "execution";
				default:
					return "unknown";
			}
		}

		// Single terminal — exactly one of complete | error | aborted is yielded
		// at the end of this generator. Setting `terminal` to non-null short-
		// circuits the default `complete`. Nothing else yields a terminal event.
		type Terminal = Extract<
			QueryEvent,
			{ type: "complete" | "error" | "aborted" }
		>;
		let terminal: Terminal | null = null;

		yield { type: "start" };

		try {
			const q = sdkQuery({ prompt, options: sdkOptions });
			this.sessionManager.setActiveQuery(opts.scope, project, q);

			for await (const message of q) {
				const msg = message as SDKMessage;

				if (msg.type === "assistant") {
					const parentCallId =
						(msg as { parent_tool_use_id: string | null }).parent_tool_use_id ??
						null;
					for (const block of msg.message.content) {
						if (block.type === "text") {
							// One SDK content block of type "text" = one renderer-visible
							// text block. Announce it explicitly; the delta carries clean
							// text with no separator prefix.
							yield { type: "text_start" };
							if (block.text.length > 0) {
								yield { type: "text_delta", delta: block.text };
							}
							if (textBlocksEmitted > 0) totalText += "\n\n";
							totalText += block.text;
							textBlocksEmitted++;
						} else if (block.type === "thinking") {
							const thinking = (block as Record<string, string>).thinking ?? "";
							yield { type: "thinking_start" };
							if (thinking.length > 0) {
								yield { type: "thinking_delta", delta: thinking };
							}
						} else if (block.type === "tool_use") {
							const callId =
								(block as Record<string, string>).id ?? randomUUID();
							toolCallTimers.set(callId, {
								tool: block.name,
								start: Date.now(),
							});
							yield {
								type: "tool_start",
								callId,
								tool: block.name,
								input: block.input,
								parentCallId,
							};
						}
					}
					resultSessionId = msg.session_id;
				} else if (msg.type === "user") {
					// Tool results arrive as user messages with `tool_result` content
					// blocks. The SDK has no top-level `tool` message variant — this is
					// where `tool_end` is emitted.
					const userMsg = msg as {
						message: { content: unknown };
						session_id?: string;
					};
					const content = userMsg.message.content;
					if (Array.isArray(content)) {
						for (const block of content as Array<Record<string, unknown>>) {
							if (block.type === "tool_result") {
								const callId = String(block.tool_use_id ?? "");
								const timer = toolCallTimers.get(callId);
								toolCallTimers.delete(callId);
								const tool = timer?.tool ?? "unknown";

								let output = "";
								const c = block.content;
								if (typeof c === "string") {
									output = c;
								} else if (Array.isArray(c)) {
									for (const part of c as Array<Record<string, unknown>>) {
										if (part.type === "text" && typeof part.text === "string")
											output += part.text;
									}
								}
								const isError = block.is_error === true;
								yield {
									type: "tool_end",
									callId,
									tool,
									output,
									isError,
								};
							}
						}
					}
				} else if (msg.type === "system") {
					const sys = msg as Record<string, unknown>;
					const subtype = String(sys.subtype ?? "");
					if (subtype === "api_retry") {
						const err = sys.error as Record<string, unknown> | undefined;
						yield {
							type: "retry",
							attempt: Number(sys.attempt ?? 0),
							maxRetries: Number(sys.max_retries ?? 0),
							delayMs: Number(sys.retry_delay_ms ?? 0),
							reason:
								typeof err?.message === "string" ? err.message : "transient",
						};
					} else if (subtype === "task_started") {
						yield {
							type: "task_start",
							taskId: String(sys.task_id ?? ""),
							description: String(sys.description ?? ""),
							taskType:
								typeof sys.task_type === "string" ? sys.task_type : undefined,
							parentCallId:
								typeof sys.tool_use_id === "string" ? sys.tool_use_id : null,
						};
					} else if (subtype === "task_progress") {
						const u = sys.usage as Record<string, unknown> | undefined;
						yield {
							type: "task_progress",
							taskId: String(sys.task_id ?? ""),
							description: String(sys.description ?? ""),
							summary:
								typeof sys.summary === "string" ? sys.summary : undefined,
							lastTool:
								typeof sys.last_tool === "string" ? sys.last_tool : undefined,
							usage: {
								totalTokens: Number(u?.total_tokens ?? 0),
								toolUses: Number(u?.tool_uses ?? 0),
								durationMs: Number(u?.duration_ms ?? 0),
							},
						};
					} else if (subtype === "task_notification") {
						const u = sys.usage as Record<string, unknown> | undefined;
						const status = String(sys.status ?? "completed") as
							| "completed"
							| "failed"
							| "stopped";
						yield {
							type: "task_end",
							taskId: String(sys.task_id ?? ""),
							status,
							summary: String(sys.summary ?? ""),
							outputFile:
								typeof sys.output_file === "string"
									? sys.output_file
									: undefined,
							usage: {
								totalTokens: Number(u?.total_tokens ?? 0),
								toolUses: Number(u?.tool_uses ?? 0),
								durationMs: Number(u?.duration_ms ?? 0),
							},
						};
					} else if (subtype === "compact_boundary") {
						yield { type: "compact", phase: "boundary" };
					} else if (subtype === "status") {
						const status = String(sys.status ?? "");
						if (status === "compacting")
							yield { type: "compact", phase: "start" };
					}
					// Other system subtypes (init, etc.) are intentionally dropped.
				} else if (msg.type === "rate_limit_event") {
					const rl = msg as Record<string, unknown>;
					const info = rl.rate_limit_info as
						| Record<string, unknown>
						| undefined;
					if (info) {
						const status = info.status as
							| "allowed"
							| "allowed_warning"
							| "rejected"
							| undefined;
						if (status) {
							yield {
								type: "rate_limit",
								status,
								utilization:
									typeof info.utilization === "number"
										? info.utilization
										: undefined,
								resetsAt:
									typeof info.resetsAt === "number" ? info.resetsAt : undefined,
								kind:
									typeof info.rateLimitType === "string"
										? (info.rateLimitType as
												| "five_hour"
												| "seven_day"
												| "seven_day_opus"
												| "seven_day_sonnet"
												| "overage")
										: undefined,
							};
						}
					}
				} else if (msg.type === "tool_progress") {
					const tp = msg as Record<string, unknown>;
					yield {
						type: "tool_progress",
						callId: typeof tp.tool_use_id === "string" ? tp.tool_use_id : "",
						tool: typeof tp.tool_name === "string" ? tp.tool_name : "unknown",
						elapsedSeconds:
							typeof tp.elapsed_time_seconds === "number"
								? tp.elapsed_time_seconds
								: 0,
					};
				} else if (msg.type === "result") {
					resultSessionId = msg.session_id;
					if (msg.subtype === "success") {
						const success = msg as SDKResultSuccess;
						turns = success.num_turns;
						costUsd = success.total_cost_usd;
						usage = snapshotUsage(success);
						stopReason = success.stop_reason;
						// Authoritative final text. Renderers reconcile against this
						// on `complete` if they were live-editing from text_delta.
						if (success.result) totalText = success.result;
					} else {
						const reason = msg.subtype ?? "unknown";
						const m = msg as Record<string, unknown>;
						if (typeof m.num_turns === "number") turns = m.num_turns;
						if (typeof m.total_cost_usd === "number")
							costUsd = m.total_cost_usd;
						if (m.usage) {
							const u = m.usage as Record<string, unknown>;
							usage = {
								inputTokens: Number(u.input_tokens ?? 0),
								outputTokens: Number(u.output_tokens ?? 0),
								cacheReadInputTokens: Number(u.cache_read_input_tokens ?? 0),
								cacheCreationInputTokens: Number(
									u.cache_creation_input_tokens ?? 0,
								),
							};
						}
						log.warn("Query ended with non-success result: {reason}", {
							reason,
							project,
						});
						terminal = {
							type: "error",
							message: `Agent stopped with error: ${reason}`,
							text: totalText,
							turns,
							costUsd,
							usage,
							cause: categorizeErrorCause(reason),
						};
					}

					// Close channel so streamInput() finishes and calls endInput(),
					// allowing the CLI process to exit and the query to complete.
					// Without this, multi-turn mode deadlocks: the channel blocks
					// waiting for more messages, but close() is in the finally block
					// which waits for the query to finish first.
					if (opts.channel && !opts.channel.closed) {
						opts.channel.close();
					}
					break;
				}
			}
		} catch (e) {
			if (signal.aborted) {
				log.info("Query aborted for project {project}", { project });
				terminal = {
					type: "aborted",
					text: totalText,
					turns,
					costUsd,
					usage,
				};
			} else if (sessionId) {
				log.error("Query failed for project {project}: {error}", {
					project,
					error: e instanceof Error ? e.message : String(e),
				});
				log.warn("Session resume failed, starting fresh", {
					sessionId,
					error: e instanceof Error ? e.message : String(e),
				});
				await this.sessionManager.deactivateSession(sessionId);
				delete sdkOptions.resume;

				try {
					const retryPrompt = opts.message;
					const q = sdkQuery({ prompt: retryPrompt, options: sdkOptions });
					this.sessionManager.setActiveQuery(opts.scope, project, q);
					for await (const message of q) {
						const msg = message as SDKMessage;
						if (msg.type === "assistant") {
							for (const block of msg.message.content) {
								if (block.type === "text") {
									yield { type: "text_start" };
									if (block.text.length > 0) {
										yield { type: "text_delta", delta: block.text };
									}
									if (textBlocksEmitted > 0) totalText += "\n\n";
									totalText += block.text;
									textBlocksEmitted++;
								}
							}
							resultSessionId = msg.session_id;
						} else if (msg.type === "result") {
							resultSessionId = msg.session_id;
							if (msg.subtype === "success") {
								const success = msg as SDKResultSuccess;
								turns = success.num_turns;
								costUsd = success.total_cost_usd;
								usage = snapshotUsage(success);
								stopReason = success.stop_reason;
								if (success.result) totalText = success.result;
							}
							break;
						}
					}
				} catch (e2) {
					log.error("Fresh query also failed: {error}", {
						error: e2 instanceof Error ? e2.message : String(e2),
					});
					terminal = {
						type: "error",
						message: e2 instanceof Error ? e2.message : String(e2),
						text: totalText,
						turns,
						costUsd,
						usage,
						// Thrown exception, not an SDK result subtype — we can't
						// reliably classify (it might be transport, but might also be
						// a tool throw, schema mismatch, etc.). Renderers that need
						// granularity can match on `message`.
						cause: "unknown",
					};
				}
			} else {
				log.error("Query failed for project {project}: {error}", {
					project,
					error: e instanceof Error ? e.message : String(e),
				});
				terminal = {
					type: "error",
					message: e instanceof Error ? e.message : String(e),
					text: totalText,
					turns,
					costUsd,
					cause: "unknown",
					usage,
				};
			}
		} finally {
			stopWatchdog();
			opts.signal?.removeEventListener("abort", onExternalAbort);
			this.sessionManager.removeActiveQuery(opts.scope, project);
		}

		// Persist session whenever we have one — independent of how the turn
		// ended. A turn that errored mid-stream may still have done real work
		// the SDK already billed for; throwing that state away wastes context.
		if (resultSessionId) {
			const existingSession = await this.sessionManager.getActiveSessionId(
				opts.scope,
				project,
			);
			if (existingSession === resultSessionId) {
				await this.sessionManager.updateSession(
					resultSessionId,
					turns,
					costUsd,
				);
			} else {
				if (existingSession) {
					await this.sessionManager.deactivateSession(existingSession);
				}
				await this.sessionManager.createSession(
					resultSessionId,
					opts.scope,
					project,
				);
				await this.sessionManager.updateSession(
					resultSessionId,
					turns,
					costUsd,
				);
			}
		}

		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		log.info("Query complete: {turns} turns, {cost}, {duration}s", {
			turns,
			cost: costUsd.toFixed(4),
			duration,
		});

		yield terminal ?? {
			type: "complete",
			text: totalText,
			turns,
			costUsd,
			usage,
			stopReason,
		};
	}

	createQueryFn(): (opts: QueryOpts) => AsyncIterable<QueryEvent> {
		return (opts: QueryOpts) => this.executeQuery(opts);
	}

	async handleMessage(
		opts: QueryOpts,
		target: ResponseTarget,
	): Promise<QueryResult> {
		const loaded = this.getLoadedPlugins();
		const startTime = Date.now();

		// Typing indicator heartbeat
		const sendOpts = target.messageThreadId
			? { message_thread_id: target.messageThreadId }
			: {};
		const typingInterval = setInterval(() => {
			this.bot.api
				.sendChatAction(target.chatId, "typing", sendOpts)
				.catch(() => {});
		}, 4000);

		const result: QueryResult = {
			finalText: "",
			turns: 0,
			project: opts.project,
			costUsd: 0,
			durationMs: 0,
			toolCalls: [],
		};

		// If caller didn't provide a signal, own one for the duration of this
		// call so the AbortController isn't GC'd. Same reasoning as in
		// executeQuery — a signal whose controller is unreachable can never
		// abort, which silently breaks every `signal.aborted` check downstream.
		const ownController = opts.signal ? null : new AbortController();
		const signal = opts.signal ?? (ownController as AbortController).signal;
		const normalizedOpts = ownController ? { ...opts, signal } : opts;

		try {
			// Wrap events to capture QueryResult from the terminal event
			const rawEvents = this.executeQuery(normalizedOpts, target);
			const toolCalls: Array<{ tool: string; durationMs: number }> = [];
			const toolTimers = new Map<string, { tool: string; start: number }>();

			// outcome promise — resolves with the terminal event so renderers
			// don't have to write spy generators just to read final stats.
			// Always resolves: the executeQuery generator guarantees one
			// terminal; the synthetic fallback below covers the impossible
			// "stream ended without terminal" case (kernel bug).
			let resolveOutcome!: (t: TurnOutcome) => void;
			const outcomePromise = new Promise<TurnOutcome>((r) => {
				resolveOutcome = r;
			});
			let outcomeResolved = false;
			const settleOutcome = (t: TurnOutcome) => {
				if (outcomeResolved) return;
				outcomeResolved = true;
				resolveOutcome(t);
			};

			async function* captureResult(
				source: AsyncIterable<QueryEvent>,
			): AsyncIterable<QueryEvent> {
				try {
					for await (const event of source) {
						if (event.type === "tool_start") {
							toolTimers.set(event.callId, {
								tool: event.tool,
								start: Date.now(),
							});
						} else if (event.type === "tool_end") {
							const timer = toolTimers.get(event.callId);
							if (timer) {
								toolCalls.push({
									tool: timer.tool,
									durationMs: Date.now() - timer.start,
								});
								toolTimers.delete(event.callId);
							}
						} else if (
							event.type === "complete" ||
							event.type === "aborted" ||
							event.type === "error"
						) {
							// All three terminals carry partial state — populate the
							// QueryResult uniformly so afterQuery sees real numbers.
							result.finalText = event.text;
							result.turns = event.turns;
							result.costUsd = event.costUsd;
							result.usage = event.usage;
							if (event.type === "complete") {
								result.stopReason = event.stopReason;
							} else if (event.type === "error") {
								result.error = new Error(event.message);
							}
							settleOutcome(event);
						}
						yield event;
					}
				} finally {
					// Defense: if the source completed without a terminal (a kernel
					// bug — should not happen), synthesize one so any awaiter of
					// `ctx.outcome` doesn't hang.
					if (!outcomeResolved) {
						settleOutcome({
							type: "error",
							message: "Stream ended without terminal event",
							text: result.finalText,
							turns: result.turns,
							costUsd: result.costUsd,
							usage: result.usage ?? {
								inputTokens: 0,
								outputTokens: 0,
								cacheReadInputTokens: 0,
								cacheCreationInputTokens: 0,
							},
							cause: "unknown",
						});
					}
				}
			}
			const events = captureResult(rawEvents);

			// Build render chain: plugin renderers sorted by priority, default last.
			// Renderers return a RenderResult that flows back through `next` so
			// decorators can inspect what downstream produced (no side-channel).
			const renderCtx: RenderContext = {
				bot: this.bot,
				target,
				signal,
				outcome: outcomePromise,
				config: this.config,
				scopeStore: this.scopeStore,
				query: this.createQueryFn(),
				pushContext: (text: string) =>
					this.sessionManager.pushContext(target.scope, target.project, text),
			};

			type Next = (events: AsyncIterable<QueryEvent>) => Promise<RenderResult>;
			let render: Next = (e) => defaultRenderer(e, renderCtx);
			// Renderers are sorted ascending (lowest priority first). Wrapping
			// in reverse makes the lowest-priority plugin the OUTERMOST layer,
			// so it runs first and decides whether to delegate via `next`.
			for (const r of loaded.renderers.toReversed()) {
				const next = render;
				const handler = r.handler;
				const pluginName = r.pluginName;
				// Per-renderer error isolation: a buggy plugin must not break the
				// chain. Log the failure and fall through to `next` so the rest
				// of the chain (and the default renderer) still produces a reply.
				// Critical for self-modifying bot — the agent writes renderers
				// and may ship one that throws.
				render = async (e) => {
					try {
						return await handler(e, renderCtx, next);
					} catch (err) {
						log.error("Renderer {plugin} threw — falling through to next", {
							plugin: pluginName,
							error: err instanceof Error ? err.message : String(err),
						});
						return await next(e).catch(() => EMPTY_RESULT);
					}
				};
			}
			const renderResult = await render(events);
			result.renderArtifacts = renderResult.artifacts;
			result.renderMeta = renderResult.meta;

			result.toolCalls = toolCalls;
		} catch (e) {
			result.error = e instanceof Error ? e : new Error(String(e));
		} finally {
			clearInterval(typingInterval);
			result.durationMs = Date.now() - startTime;
		}

		return result;
	}
}
