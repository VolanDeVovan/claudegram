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
import type {
	BotContext,
	QueryEvent,
	QueryOpts,
	ResponseTarget,
} from "./plugin-api.ts";
import type { LoadedPlugins } from "./plugin-loader.ts";
import { defaultRenderer } from "./response-renderer.ts";
import type { SessionManager } from "./session-manager.ts";

const log = getLogger(["bot", "executor"]);

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
	private botRoot: string;
	private pluginsDir: string;
	private coreTools: SdkMcpToolDefinition[];
	private getLoadedPlugins: () => LoadedPlugins;
	private selfSystemPrompt: string;

	constructor(opts: {
		config: ConfigManager;
		sessionManager: SessionManager;
		bot: Bot<BotContext>;
		botRoot: string;
		pluginsDir: string;
		coreTools: SdkMcpToolDefinition[];
		getLoadedPlugins: () => LoadedPlugins;
	}) {
		this.config = opts.config;
		this.sessionManager = opts.sessionManager;
		this.bot = opts.bot;
		this.botRoot = opts.botRoot;
		this.pluginsDir = opts.pluginsDir;
		this.coreTools = opts.coreTools;
		this.getLoadedPlugins = opts.getLoadedPlugins;
		this.selfSystemPrompt = loadSystemPrompt(this.botRoot);
	}

	async *executeQuery(opts: QueryOpts): AsyncIterable<QueryEvent> {
		const project = opts.project;
		const isSelf = project === "self";
		const projectConfig = this.config.data.projects.find(
			(p) => p.name === project,
		);
		const cwd = isSelf ? this.botRoot : (projectConfig?.path ?? this.botRoot);
		const model = projectConfig?.model ?? this.config.data.model;
		const loaded = this.getLoadedPlugins();

		// Build MCP server for tools (core + plugin)
		const allTools = [...this.coreTools];
		for (const { tool } of loaded.tools) {
			const scope = tool.scope ?? "self";
			const allowed =
				scope === "all" ||
				(scope === "self" && isSelf) ||
				(Array.isArray(scope) && scope.includes(project));
			if (!allowed) continue;

			allTools.push({
				name: tool.name,
				description: tool.description,
				inputSchema: {},
				handler: async (args) => {
					log.info("Tool call: {tool}", { tool: tool.name, args });
					const start = Date.now();
					const result = await tool.handler(args, {
						bot: this.bot,
						config: this.config,
						db: this.bot
							.botInfo as unknown as typeof import("../core/database.ts").db, // placeholder, actual db passed via server
						query: this.createQueryFn(),
						sessions: this.sessionManager,
					});
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
			abortController: opts.signal
				? ({
						abort: () => opts.signal?.dispatchEvent(new Event("abort")),
						signal: opts.signal,
					} as AbortController)
				: undefined,
			systemPrompt: isSelf ? this.selfSystemPrompt : undefined,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		};

		// Add MCP servers
		const mcpServers: Record<string, unknown> = {};
		if (isSelf && allTools.length > 0) {
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
		const sessionId = this.sessionManager.getActiveSessionId(
			opts.userId,
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

		const stopWatchdog = startWatchdog(opts.userId, project);
		const startTime = Date.now();
		let totalText = "";
		let resultSessionId: string | undefined;
		let turns = 0;
		let costUsd = 0;
		let hadTextOutput = false;

		try {
			const q = sdkQuery({ prompt, options: sdkOptions });

			for await (const message of q) {
				const msg = message as SDKMessage;

				if (msg.type === "assistant") {
					// Extract text from assistant message content blocks
					for (const block of msg.message.content) {
						if (block.type === "text") {
							// Separate text from different assistant turns
							const sep = hadTextOutput && block.text.length > 0 ? "\n\n" : "";
							yield { type: "text_delta", delta: sep + block.text };
							totalText += sep + block.text;
							hadTextOutput = true;
						} else if (block.type === "thinking") {
							yield {
								type: "thinking_delta",
								delta: (block as Record<string, string>).thinking ?? "",
							};
						} else if (block.type === "tool_use") {
							yield {
								type: "tool_start",
								tool: block.name,
								input: block.input,
							};
						}
					}
					resultSessionId = msg.session_id;
				} else if (msg.type === "result") {
					resultSessionId = msg.session_id;
					if (msg.subtype === "success") {
						const success = msg as SDKResultSuccess;
						turns = success.num_turns;
						costUsd = success.total_cost_usd;
						if (success.result && success.result !== totalText) {
							// Final result text
						}
					}

					// Close channel so streamInput() finishes and calls endInput(),
					// allowing the CLI process to exit and the query to complete.
					// Without this, multi-turn mode deadlocks: the channel blocks
					// waiting for more messages, but close() is in the finally block
					// which waits for the query to finish first.
					if (opts.channel && !opts.channel.closed) {
						opts.channel.close();
					}
				}
			}
		} catch (e) {
			if (opts.signal?.aborted) {
				log.info("Query aborted for project {project}", { project });
				yield { type: "done", finalText: "" };
				return;
			}

			log.error("Query failed for project {project}: {error}", {
				project,
				error: e instanceof Error ? e.message : String(e),
			});

			// If resume failed, try fresh session
			if (sessionId) {
				log.warn("Session resume failed, starting fresh", {
					sessionId,
					error: e instanceof Error ? e.message : String(e),
				});
				this.sessionManager.deactivateSession(sessionId);
				delete sdkOptions.resume;

				try {
					// Channel may be consumed — fall back to string for retry
					const retryPrompt = opts.message;
					const q = sdkQuery({ prompt: retryPrompt, options: sdkOptions });
					for await (const message of q) {
						const msg = message as SDKMessage;
						if (msg.type === "assistant") {
							for (const block of msg.message.content) {
								if (block.type === "text") {
									const sep =
										hadTextOutput && block.text.length > 0 ? "\n\n" : "";
									yield { type: "text_delta", delta: sep + block.text };
									totalText += sep + block.text;
									hadTextOutput = true;
								}
							}
							resultSessionId = msg.session_id;
						} else if (msg.type === "result") {
							resultSessionId = msg.session_id;
							if (msg.subtype === "success") {
								const success = msg as SDKResultSuccess;
								turns = success.num_turns;
								costUsd = success.total_cost_usd;
							}
						}
					}
				} catch (e2) {
					log.error("Fresh query also failed: {error}", {
						error: e2 instanceof Error ? e2.message : String(e2),
					});
					yield {
						type: "text_delta",
						delta: `Error: ${e2 instanceof Error ? e2.message : String(e2)}`,
					};
				}
			} else {
				yield {
					type: "text_delta",
					delta: `Error: ${e instanceof Error ? e.message : String(e)}`,
				};
			}
		} finally {
			stopWatchdog();
		}

		// Persist session
		if (resultSessionId) {
			const existingSession = this.sessionManager.getActiveSessionId(
				opts.userId,
				project,
			);
			if (existingSession === resultSessionId) {
				this.sessionManager.updateSession(resultSessionId, turns, costUsd);
			} else {
				if (existingSession) {
					this.sessionManager.deactivateSession(existingSession);
				}
				this.sessionManager.createSession(
					resultSessionId,
					opts.userId,
					project,
				);
				this.sessionManager.updateSession(resultSessionId, turns, costUsd);
			}
		}

		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		log.info("Query complete: {turns} turns, {cost}, {duration}s", {
			turns,
			cost: costUsd.toFixed(4),
			duration,
		});

		yield { type: "done", finalText: totalText };
	}

	createQueryFn(): (opts: QueryOpts) => AsyncIterable<QueryEvent> {
		return (opts: QueryOpts) => this.executeQuery(opts);
	}

	async handleMessage(opts: QueryOpts, target: ResponseTarget): Promise<void> {
		const loaded = this.getLoadedPlugins();

		// Typing indicator heartbeat
		const sendOpts = target.messageThreadId
			? { message_thread_id: target.messageThreadId }
			: {};
		const typingInterval = setInterval(() => {
			this.bot.api
				.sendChatAction(target.chatId, "typing", sendOpts)
				.catch(() => {});
		}, 4000);

		try {
			const events = this.executeQuery(opts);

			if (loaded.responseRenderer) {
				await loaded.responseRenderer(events, target, this.bot);
			} else {
				await defaultRenderer(events, target, this.bot);
			}
		} finally {
			clearInterval(typingInterval);
		}
	}
}
