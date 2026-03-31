import { join, resolve } from "node:path";
import { sequentialize } from "@grammyjs/runner";
import { getLogger } from "@logtape/logtape";
import { runWizard } from "@setup/wizard.ts";
import { Bot, type MiddlewareFn } from "grammy";
import { ConfigManager } from "./config.ts";
import { createPluginCommands, registerCoreCommands } from "./core-commands.ts";
import { createCoreTools } from "./core-tools.ts";
import { initDatabase } from "./database.ts";
import { Executor } from "./executor.ts";
import { GenerationManager } from "./generation-manager.ts";
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
import { SessionManager } from "./session-manager.ts";

const BOT_ROOT = resolve(process.cwd());
const DATA_DIR = join(BOT_ROOT, "data");
const CONFIG_PATH = join(DATA_DIR, "config.jsonc");
const DB_PATH = join(DATA_DIR, "bot.db");
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

	// Init database
	const db = initDatabase(DB_PATH);

	// Init session manager
	const sessionManager = new SessionManager(db, config);

	// Init generation manager
	const generationManager = new GenerationManager(GENERATIONS_DIR, PLUGINS_DIR);

	// Create bot
	const bot = new Bot<BotContext>(config.data.botToken);

	// ── Core middleware (before plugins) ──

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

	// 3. Log all commands (uses Telegram bot_command entities)
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

	// 5. /cancel and /ping — bypass queue
	registerCoreCommands(bot, sessionManager, config, () => loadedPlugins);

	// 6. Owner auth
	bot.use(async (ctx, next) => {
		const userId = String(ctx.from?.id);
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

	// 7. Message injection — inject into active channel if agent is busy
	bot.use(async (ctx, next) => {
		if (!ctx.message?.text || ctx.message.text.startsWith("/")) return next();

		const userId = String(ctx.from?.id ?? "unknown");
		const project = sessionManager.getActiveProject(userId);
		const channel = sessionManager.getActiveChannel(userId, project);

		if (channel && !channel.closed) {
			const pushed = channel.push(ctx.message.text);
			if (pushed) {
				log.info(
					"Message injected into active channel for {userId}:{project}",
					{ userId, project },
				);
				return; // swallow update — message injected into running query
			}
		}

		return next();
	});

	// 8. Sequentialize per user+project
	bot.use(
		sequentialize((ctx) => {
			const userId = String(ctx.from?.id ?? "unknown");
			const project = sessionManager.getActiveProject(userId);
			return `${userId}:${project}`;
		}),
	);

	// 9. Swappable plugin middleware
	let currentMiddleware: MiddlewareFn<BotContext> = (_ctx, next) => next();
	bot.use((ctx, next) => currentMiddleware(ctx, next));

	// ── Plugin loading ──

	let loadedPlugins: LoadedPlugins = {
		plugins: [],
		errors: [],
		resolveTarget: null,
		responseRenderer: null,
		approvalHandlers: [],
		authChecks: [],
		tools: [],
		commands: new Map(),
	};

	// Core tools
	const coreTools = createCoreTools(
		config,
		generationManager,
		() => loadedPlugins,
		reloadPlugins,
	);

	// Executor
	const executor = new Executor({
		config,
		sessionManager,
		bot,
		botRoot: BOT_ROOT,
		pluginsDir: PLUGINS_DIR,
		coreTools,
		getLoadedPlugins: () => loadedPlugins,
	});

	// Plugin context
	currentPluginCtx = {
		bot,
		config,
		db,
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
		const reloadLog = getLogger(["bot", "reload"]);
		reloadLog.info("Reload started");

		// Dispose current plugins
		await disposePlugins(loadedPlugins.plugins);

		// Load new plugins
		const newLoaded = await loadPlugins(PLUGINS_DIR, currentPluginCtx, config);

		// Add core commands as plugin commands
		const coreCmds = createPluginCommands(
			sessionManager,
			config,
			() => newLoaded,
		);
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
		];
		for (const [name, { description }] of loadedPlugins.commands) {
			botCommands.push({
				command: name,
				description: description ?? `/${name}`,
			});
		}
		await bot.api.setMyCommands(botCommands);

		const loadedNames = loadedPlugins.plugins.map((p) => p.name);
		const errorMsgs = loadedPlugins.errors.map((e) => `${e.path}: ${e.error}`);

		if (loadedPlugins.errors.length === 0) {
			// Create generation on successful reload
			generationManager.create(
				`Reload: ${loadedNames.join(", ") || "no plugins"}`,
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

	// ── Text message routing (core) ──
	// Always routes text to Claude via executor. Plugins can modify
	// behavior through responseRenderer, resolveTarget, approvalHandler hooks.
	bot.on("message:text", async (ctx) => {
		if (ctx.message.text.startsWith("/")) return;

		const userId = String(ctx.from.id);
		const project = sessionManager.getActiveProject(userId);

		// Resolve target
		let target: ResponseTarget = { chatId: ctx.chat.id };
		if (ctx.message.message_thread_id) {
			target.messageThreadId = ctx.message.message_thread_id;
		}
		if (loadedPlugins.resolveTarget) {
			try {
				target = loadedPlugins.resolveTarget(userId, project, ctx);
			} catch (e) {
				log.error("resolveTarget error: {error}", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// Create a streaming message channel for this query
		const channel = new MessageChannel();
		channel.push(ctx.message.text ?? "");
		sessionManager.setActiveChannel(userId, project, channel);

		await sessionManager.withSessionLock(userId, project, async (signal) => {
			try {
				await executor.handleMessage(
					{
						message: ctx.message.text ?? "",
						userId,
						project,
						signal,
						channel,
					},
					target,
				);
			} finally {
				sessionManager.removeActiveChannel(userId, project);
			}
		});
	});

	// Start bot
	const me = await bot.api.getMe();
	log.info("Bot started as @{username}, owner: {owner}", {
		username: me.username,
		owner: config.data.owner,
	});

	bot.start({
		onStart: () => {
			log.info("Polling started");
		},
	});
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
