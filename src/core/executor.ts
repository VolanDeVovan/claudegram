import { join } from "node:path";
import type {
	Options,
	SDKMessage,
	SDKResultSuccess,
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

function buildSelfSystemPrompt(
	config: ConfigManager,
	plugins: LoadedPlugins,
	botRoot: string,
): string {
	const activePlugins = plugins.plugins
		.map((p) => `- ${p.name}: ${p.description ?? "(no description)"}`)
		.join("\n");

	const projects = config.data.projects.map((p) => p.name).join(", ");

	const selfProject = config.data.projects.find((p) => p.name === "self");
	const projectInstructions = selfProject?.systemPrompt
		? `\n\n== Project Instructions ==\n${selfProject.systemPrompt}`
		: "";

	return `You are a Telegram bot assistant powered by Claude.
You can modify your own behavior by writing plugins.

== Plugin System ==
Active plugins live in plugins/. You can write, edit, and delete files there.
Template plugins live in src/templates/ — READ-ONLY reference implementations.
You can ONLY write to plugins/. Use config_set tool for configuration changes.

When the user asks for a feature:
1. Check if a template exists in src/templates/
2. If yes — copy it to plugins/, then adapt to the user's needs
3. If no — write a new plugin following the patterns in templates/
4. Call reload_plugins after any change
5. Confirm the change to the user

When the user adds a project but has no project-switching mechanism:
- Explain that the bot is flexible and can support different switching methods
- Suggest options: chat commands, inline keyboards, forum threads, or custom
- Let the user choose, then implement as a plugin

To understand the available API, read src/core/plugin-api.ts.
Never modify src/. Only write to plugins/.

== Active Plugins ==
${activePlugins || "(none)"}

== Current State ==
Active project: self (${botRoot})
Available projects: ${projects || "self"}
Model: ${config.data.model}

== Communication ==
Your text output is automatically sent to the user's Telegram chat.
You don't need special tools to reply — just write your response.${projectInstructions}`;
}

function buildExternalSystemPrompt(
	config: ConfigManager,
	projectName: string,
): string {
	const project = config.data.projects.find((p) => p.name === projectName);
	const projectPrompt = project?.systemPrompt
		? `\n\n${project.systemPrompt}`
		: "";

	return `You are a coding assistant accessed via Telegram.
You are working on the project "${projectName}" at ${project?.path ?? "."}.

Your text output is automatically sent to the user's Telegram chat.${projectPrompt}`;
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
		if (isSelf) {
			for (const { tool } of loaded.tools) {
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
							db: this.bot.botInfo as any, // placeholder, actual db passed via server
							query: this.createQueryFn(),
							sessions: this.sessionManager,
						});
						const ms = Date.now() - start;
						log.info("Tool done: {tool} ({ms}ms)", { tool: tool.name, ms });
						return { content: [{ type: "text" as const, text: result }] };
					},
				});
			}
		}

		// Build SDK options
		const sdkOptions: Options = {
			cwd,
			model,
			maxTurns: this.config.data.maxTurns,
			settingSources: ["user", "project", "local"],
			abortController: opts.signal
				? ({
						abort: () => opts.signal!.dispatchEvent(new Event("abort")),
						signal: opts.signal,
					} as AbortController)
				: undefined,
			systemPrompt: isSelf
				? buildSelfSystemPrompt(this.config, loaded, this.botRoot)
				: buildExternalSystemPrompt(this.config, project),
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		};

		// Add MCP servers
		const mcpServers: Record<string, any> = {};
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

		const prompt = opts.message;

		log.info(
			"Query started for project {project}, model {model}, session {session}",
			{
				project,
				model,
				session: sessionId ? `resume ${sessionId}` : "new",
			},
		);

		const stopWatchdog = startWatchdog(opts.userId, project);
		const startTime = Date.now();
		let totalText = "";
		let resultSessionId: string | undefined;
		let turns = 0;
		let costUsd = 0;

		try {
			const q = sdkQuery({ prompt, options: sdkOptions });

			for await (const message of q) {
				const msg = message as SDKMessage;

				if (msg.type === "assistant") {
					// Extract text from assistant message content blocks
					for (const block of msg.message.content) {
						if (block.type === "text") {
							yield { type: "text_delta", delta: block.text };
							totalText += block.text;
						} else if (block.type === "thinking") {
							yield {
								type: "thinking_delta",
								delta: (block as any).thinking ?? "",
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
					const q = sdkQuery({ prompt, options: sdkOptions });
					for await (const message of q) {
						const msg = message as SDKMessage;
						if (msg.type === "assistant") {
							for (const block of msg.message.content) {
								if (block.type === "text") {
									yield { type: "text_delta", delta: block.text };
									totalText += block.text;
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
		log.info("Query complete: {turns} turns, ${cost}, {duration}s", {
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
