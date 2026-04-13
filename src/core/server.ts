import { join, resolve } from "node:path";
import { run } from "@grammyjs/runner";
import { getLogger } from "@logtape/logtape";
import { runWizard } from "@setup/wizard.ts";
import { Bot, type MiddlewareFn } from "grammy";
import { ConfigManager } from "./config.ts";
import { createPluginCommands, registerCoreCommands } from "./core-commands.ts";
import { createCoreTools } from "./core-tools.ts";
import { Executor } from "./executor.ts";
import { GenerationManager } from "./generation-manager.ts";
import * as git from "./git.ts";
import { initLogger } from "./logger.ts";
import { MessageChannel } from "./message-channel.ts";
import type {
	BotContext,
	PluginContext,
	ResponseTarget,
} from "./plugin-api.ts";
import {
	buildMiddleware,
	disposePlugins,
	type LoadedPlugins,
	loadPlugins,
} from "./plugin-loader.ts";
import { JsonScopeStore } from "./scope-store.ts";
import { SessionManager } from "./session-manager.ts";
import type { BotRuntime } from "./update.ts";
import { sendStartupNotification } from "./update.ts";

const BOT_ROOT = resolve(process.cwd());
const DATA_DIR = join(BOT_ROOT, "data");
const CONFIG_PATH = join(DATA_DIR, "config.jsonc");
const SESSIONS_PATH = join(DATA_DIR, "sessions.json");
const SCOPE_DIR = join(DATA_DIR, "scope");
const LOGS_DIR = join(DATA_DIR, "logs");
const PLUGINS_DIR = join(BOT_ROOT, "plugins");
const GENERATIONS_DIR = join(DATA_DIR, "generations");

async function main() {
	// Init logger first
	await initLogger(LOGS_DIR);
	const log = getLogger(["bot", "startup"]);

	// First-run wizard
	if (!ConfigManager.exists(CONFIG_PATH)) {
		await runWizard(CONFIG_PATH, PLUGINS_DIR, GENERATIONS_DIR);
	}

	// Load config
	const config = new ConfigManager(CONFIG_PATH);
	log.info("Config loaded. {projectCount} projects, owner: {owner}", {
		projectCount: config.data.projects.length,
		owner: config.data.owner,
	});

	// Ensure self project exists
	if (!config.data.projects.find((p) => p.name === "self")) {
		config.set("projects", [
			...config.data.projects,
			{ name: "self", path: BOT_ROOT, description: "This bot itself" },
		]);
	}

	// Init storage
	const scopeStore = new JsonScopeStore(SCOPE_DIR);
	const sessionManager = new SessionManager(SESSIONS_PATH, config);

	// Init generation manager
	const generationManager = new GenerationManager(GENERATIONS_DIR, PLUGINS_DIR);

	// Create bot
	const bot = new Bot<BotContext>(config.data.botToken);

	// ── Core middleware chain ──
	// Order: stale → dedup → log → pluginContext → scope resolution → auth → core commands → plugin middleware → message handler

	const bootTime = Date.now();

	// 1. Stale message filter
	bot.use(async (ctx, next) => {
		if (ctx.message && ctx.message.date * 1000 < bootTime) return;
		await next();
	});

	// 2. Message deduplication
	const seen = new Set<number>();
	const MAX_SEEN = 1000;
	bot.use(async (ctx, next) => {
		const id = ctx.message?.message_id;
		if (!id) return next();
		if (seen.has(id)) return;
		seen.add(id);
		if (seen.size > MAX_SEEN) {
			const first = seen.values().next().value;
			if (first !== undefined) seen.delete(first);
		}
		await next();
	});

	// 3. Log all commands
	bot.use(async (ctx, next) => {
		const entities = ctx.message?.entities ?? ctx.channelPost?.entities ?? [];
		const text = ctx.message?.text ?? ctx.channelPost?.text ?? "";
		for (const e of entities) {
			if (e.type === "bot_command") {
				const command = text.slice(e.offset, e.offset + e.length);
				log.info("Command {command} from user {userId}", {
					command,
					userId: String(ctx.from?.id),
				});
			}
		}
		await next();
	});

	// 4. Inject pluginContext into every context
	let currentPluginCtx: PluginContext;
	bot.use(async (ctx, next) => {
		ctx.pluginContext = currentPluginCtx;
		await next();
	});

	// 5. Scope resolution middleware — sets ctx.userId, ctx.scope, ctx.project
	bot.use(async (ctx, next) => {
		const userId = String(ctx.from?.id);
		ctx.userId = userId;

		// Try plugin resolveContext hooks (chain, first non-null wins)
		let resolved = false;
		for (const { resolver } of loadedPlugins.contextResolvers) {
			const result = await resolver(ctx, currentPluginCtx);
			if (result) {
				ctx.scope = result.scope;
				ctx.project = result.project;
				// Store target if provided by resolver
				if (result.target) {
					ctx.resolvedTarget = result.target;
				}
				resolved = true;
				break;
			}
		}

		if (!resolved) {
			// Core fallback: scope = userId, project = "self"
			// Multi-project routing is entirely a plugin responsibility (resolveContext + scopeStore)
			ctx.scope = userId;
			ctx.project = "self";
		}

		await next();
	});

	// 6. Owner auth + plugin authChecks
	bot.use(async (ctx, next) => {
		const userId = ctx.userId;
		if (!userId) return;

		if (userId === config.data.owner) {
			return next();
		}

		// Check plugin authChecks
		for (const { plugin, check } of loadedPlugins.authChecks) {
			const pluginConfig = config.get(`plugins.${plugin.name}`);
			try {
				if (check(userId, pluginConfig, ctx)) {
					log.info("Message from user {userId} allowed by plugin {plugin}", {
						userId,
						plugin: plugin.name,
					});
					return next();
				}
			} catch (e) {
				log.error("authCheck error in plugin {plugin}: {error}", {
					plugin: plugin.name,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		log.info("Message from user {userId} denied", { userId });
	});

	// Runtime-level state captured by the BotRuntime handle below. Getters
	// are used for `activeQueries` / `stopRunner` because those are updated
	// during the message loop and runner setup respectively — any value
	// captured at construction time would go stale.
	let activeQueries = 0;
	let runnerStopFn: (() => Promise<void>) | null = null;

	const runtime: BotRuntime = {
		rootDir: BOT_ROOT,
		dataDir: DATA_DIR,
		generations: generationManager,
		sessions: sessionManager,
		activeQueries: () => activeQueries,
		stopRunner: async () => {
			if (runnerStopFn) await runnerStopFn();
		},
		notify: async (target, text) => {
			await bot.api.sendMessage(target.chatId, text, {
				message_thread_id: target.messageThreadId,
			});
		},
	};

	// 7. Core commands — AFTER auth, no guarded() needed
	registerCoreCommands(bot, sessionManager, reloadPlugins, runtime);

	// 8. Swappable plugin middleware
	let currentMiddleware: MiddlewareFn<BotContext> = (_ctx, next) => next();
	bot.use((ctx, next) => currentMiddleware(ctx, next));

	// ── Plugin loading ──

	let loadedPlugins: LoadedPlugins = {
		plugins: [],
		errors: [],
		contextResolvers: [],
		authChecks: [],
		beforeQueryHooks: [],
		afterQueryHooks: [],
		renderMiddlewares: [],
		tools: [],
		commands: new Map(),
	};

	// Core tools
	const coreTools = createCoreTools(
		config,
		() => loadedPlugins,
		reloadPlugins,
		runtime,
	);

	// Executor
	const executor = new Executor({
		config,
		sessionManager,
		bot,
		scopeStore,
		botRoot: BOT_ROOT,
		pluginsDir: PLUGINS_DIR,
		coreTools,
		getLoadedPlugins: () => loadedPlugins,
	});

	// Plugin context
	currentPluginCtx = {
		bot,
		config,
		scopeStore,
		query: executor.createQueryFn(),
		sessions: sessionManager,
	};

	const coreCommandDescriptions: Record<string, string> = {
		start: "Show bot info and available commands",
		new: "Start a new conversation",
		clear: "Clear current session",
	};

	async function reloadPlugins(): Promise<{
		loaded: string[];
		errors: string[];
	}> {
		const RELOAD_TIMEOUT_MS = 10_000;
		const reloadLog = getLogger(["bot", "reload"]);
		reloadLog.info("Reload started");

		// Wait for active queries to finish
		const start = Date.now();
		while (activeQueries > 0) {
			if (Date.now() - start > RELOAD_TIMEOUT_MS) {
				reloadLog.warn(
					"Reload timeout: {count} queries still active, force-disposing",
					{ count: activeQueries },
				);
				break;
			}
			await new Promise((r) => setTimeout(r, 100));
		}

		// Dispose current plugins
		await disposePlugins(loadedPlugins.plugins);

		// Load new plugins
		const newLoaded = await loadPlugins(PLUGINS_DIR, currentPluginCtx, config);

		// Add core commands as plugin commands
		const coreCmds = createPluginCommands(sessionManager, config);
		for (const [name, handler] of Object.entries(coreCmds)) {
			if (!newLoaded.commands.has(name)) {
				newLoaded.commands.set(name, {
					plugin: "core",
					handler,
					description: coreCommandDescriptions[name],
				});
			}
		}

		loadedPlugins = newLoaded;

		// Build and swap middleware
		const composer = buildMiddleware(loadedPlugins);
		currentMiddleware = composer.middleware();

		// Sync command list with Telegram for autocomplete
		const botCommands: Array<{ command: string; description: string }> = [
			{ command: "cancel", description: "Cancel current operation" },
			{ command: "ping", description: "Check bot status" },
			{
				command: "rollback",
				description: "Rollback to previous plugin generation",
			},
		];
		for (const [name, { description }] of loadedPlugins.commands) {
			botCommands.push({
				command: name,
				description: description ?? `/${name}`,
			});
		}
		await bot.api.setMyCommands(botCommands, {
			scope: { type: "all_private_chats" },
		});

		const loadedNames = loadedPlugins.plugins.map((p) => p.name);
		const errorMsgs = loadedPlugins.errors.map((e) => `${e.path}: ${e.error}`);

		if (loadedPlugins.errors.length === 0) {
			// Tag every reload snapshot with the current git HEAD so a later
			// rollback can tell whether this generation's plugins match the
			// currently checked-out code. Without the hash, applyRollback()
			// would always take the hot-reload path and silently restore old
			// plugins onto a newer runtime.
			generationManager.create(
				`Reload: ${loadedNames.join(", ") || "no plugins"}`,
				git.getHead(BOT_ROOT),
			);
			reloadLog.info("Reload complete, generation created", {
				plugins: loadedNames,
			});
		} else {
			reloadLog.warn("Reload had errors: {errors}", {
				errors: errorMsgs,
			});
		}

		return { loaded: loadedNames, errors: errorMsgs };
	}

	// Initial load
	await reloadPlugins();

	// ── Message routing (core) ──
	bot.on("message", async (ctx) => {
		let text =
			ctx.overrideText ?? ctx.message?.text ?? ctx.message?.caption ?? "";
		if (!text) return;

		const { userId, scope, project } = ctx;

		// Fast path: inject into running query
		const activeChannel = sessionManager.getActiveChannel(scope, project);
		if (activeChannel && !activeChannel.closed) {
			activeChannel.push(text);
			log.info("Message injected into active channel for {scope}:{project}", {
				scope,
				project,
			});
			return;
		}

		// Drain pending context (bot-sent messages the agent should know about)
		const pending = sessionManager.drainContext(scope, project);
		if (pending.length > 0) {
			text = `${pending.join("\n\n---\n\n")}\n\n---\n\n${text}`;
		}

		// Resolve target
		let target: ResponseTarget = {
			chatId: ctx.chat.id,
			scope,
			project,
		};
		if (ctx.message.message_thread_id) {
			target.messageThreadId = ctx.message.message_thread_id;
		}
		// Use target from resolveContext if available
		if (ctx.resolvedTarget) {
			target = ctx.resolvedTarget;
		}

		// beforeQuery hooks
		for (const { handler } of loadedPlugins.beforeQueryHooks) {
			try {
				await handler({ message: text, userId, scope, project }, ctx);
			} catch (e) {
				log.error("beforeQuery hook error: {error}", {
					error: e instanceof Error ? e.message : String(e),
				});
				// Thrown = abort query
				if (e instanceof Error) {
					await ctx.reply(`Blocked: ${e.message}`).catch(() => {});
				}
				return;
			}
		}

		await sessionManager.withSessionLock(scope, project, async (signal) => {
			// Double-check: channel may have appeared while waiting for lock
			const ch = sessionManager.getActiveChannel(scope, project);
			if (ch && !ch.closed) {
				ch.push(text);
				return;
			}

			const channel = new MessageChannel();
			channel.push(text);
			sessionManager.setActiveChannel(scope, project, channel);

			activeQueries++;
			try {
				const result = await executor.handleMessage(
					{
						message: text,
						userId,
						scope,
						project,
						signal,
						channel,
					},
					target,
				);

				if (result.error) {
					log.error("Query error: {error}", {
						error: result.error.message,
					});
					await ctx.reply(`Error: ${result.error.message}`).catch(() => {});
				}

				for (const { handler } of loadedPlugins.afterQueryHooks) {
					try {
						await handler(result, ctx);
					} catch (e) {
						log.error("afterQuery hook error: {error}", {
							error: e instanceof Error ? e.message : String(e),
						});
					}
				}
			} finally {
				activeQueries--;
				channel.close();
				sessionManager.removeActiveChannel(scope, project);
			}
		});
	});

	// Start bot
	const me = await bot.api.getMe();
	log.info("Bot started as @{username}, owner: {owner}", {
		username: me.username,
		owner: config.data.owner,
	});

	const runner = run(bot);
	runnerStopFn = () => runner.stop();
	log.info("Polling started (concurrent runner)");

	// Send pending update notification (after restart)
	sendStartupNotification(runtime).catch((e) => {
		log.error("Startup notification error: {error}", {
			error: e instanceof Error ? e.message : String(e),
		});
	});

	// Graceful shutdown. runner.stop() by itself only halts polling — the
	// event loop may still have open handles (timers, network), so Node
	// wouldn't exit on its own. Explicit exit avoids hanging on Ctrl-C.
	const stop = async () => {
		await runner.stop();
		process.exit(0);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
