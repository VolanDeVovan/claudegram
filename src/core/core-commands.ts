import type { Bot } from "grammy";
import type { ConfigManager } from "./config.ts";
import type { BotContext } from "./plugin-api.ts";
import type { LoadedPlugins } from "./plugin-loader.ts";
import type { SessionManager } from "./session-manager.ts";

const startedAt = Date.now();

export function registerCoreCommands(
	bot: Bot<BotContext>,
	sessionManager: SessionManager,
	config: ConfigManager,
	getLoadedPlugins: () => LoadedPlugins,
): void {
	// /cancel and /ping bypass sequentialize — registered BEFORE middleware
	bot.command("cancel", async (ctx) => {
		const userId = String(ctx.from?.id);
		const project = sessionManager.getActiveProject(userId);
		const cancelled = sessionManager.cancelQuery(userId, project);
		if (cancelled) {
			await ctx.reply("Cancelled.");
		} else {
			await ctx.reply("Nothing to cancel.");
		}
	});

	bot.command("ping", async (ctx) => {
		const uptimeMs = Date.now() - startedAt;
		const uptimeSec = Math.floor(uptimeMs / 1000);
		const min = Math.floor(uptimeSec / 60);
		const sec = uptimeSec % 60;
		await ctx.reply(`pong — uptime: ${min}m ${sec}s`);
	});
}

export function createPluginCommands(
	sessionManager: SessionManager,
	config: ConfigManager,
	getLoadedPlugins: () => LoadedPlugins,
): Record<string, (ctx: BotContext) => Promise<void>> {
	return {
		start: async (ctx) => {
			const plugins = getLoadedPlugins();
			const project = sessionManager.getActiveProject(String(ctx.from?.id));
			const projects = config.data.projects.filter((p) => p.name !== "self");
			const pluginList =
				plugins.plugins.map((p) => p.name).join(", ") || "none";

			let msg =
				"Hi! I'm a Claude-powered bot that configures itself through this chat.\n\n" +
				"Just tell me what you need — I'll write plugins and apply them live.\n" +
				"For example:\n" +
				'• "add my project /path/to/my-app"\n' +
				'• "react with 👀 to every message"\n' +
				'• "set up forum topics for different projects"\n\n';

			if (projects.length > 0) {
				msg += `Projects: ${projects.map((p) => p.name).join(", ")}\n`;
			}
			msg += `Plugins: ${pluginList}\n`;
			msg += "Commands: /new /clear /cancel /ping";

			await ctx.reply(msg);
		},

		new: async (ctx) => {
			const userId = String(ctx.from?.id);
			const project = sessionManager.getActiveProject(userId);
			sessionManager.clearSession(userId, project);
			await ctx.reply(
				"Session cleared. Next message starts a new conversation.",
			);
		},

		clear: async (ctx) => {
			const userId = String(ctx.from?.id);
			const project = sessionManager.getActiveProject(userId);
			sessionManager.clearSession(userId, project);
			await ctx.reply("Session cleared.");
		},
	};
}
