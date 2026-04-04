import type { Bot } from "grammy";
import type { ConfigManager } from "./config.ts";
import type { GenerationManager } from "./generation-manager.ts";
import type { BotContext } from "./plugin-api.ts";
import type { SessionManager } from "./session-manager.ts";

const startedAt = Date.now();

export function registerCoreCommands(
	bot: Bot<BotContext>,
	sessionManager: SessionManager,
	config: ConfigManager,
	generationManager: GenerationManager,
	reloadPlugins: () => Promise<{ loaded: string[]; errors: string[] }>,
): void {
	// Core commands registered AFTER auth middleware — no guarded() needed

	bot.command("cancel", async (ctx) => {
		const { scope, project } = ctx;
		const cancelled = sessionManager.cancelQuery(scope, project);
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

	bot.command("rollback", async (ctx) => {
		const current = generationManager.getCurrent();
		if (current <= 1) {
			await ctx.reply("No previous generation to rollback to.");
			return;
		}
		const target = current - 1;
		try {
			generationManager.rollback(target);
			const result = await reloadPlugins();
			const plugins = result.loaded.join(", ") || "none";
			await ctx.reply(
				`Rolled back to generation ${target}. Plugins: ${plugins}`,
			);
		} catch (e) {
			await ctx.reply(
				`Rollback failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	});
}

export function createPluginCommands(
	sessionManager: SessionManager,
	config: ConfigManager,
): Record<string, (ctx: BotContext) => Promise<void>> {
	return {
		start: async (ctx) => {
			const projects = config.data.projects.filter((p) => p.name !== "self");
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
			msg += "Commands: /new /clear /cancel /ping";

			await ctx.reply(msg);
		},

		new: async (ctx) => {
			const { scope, project } = ctx;
			await sessionManager.clearSession(scope, project);
			await ctx.reply(
				"Session cleared. Next message starts a new conversation.",
			);
		},

		clear: async (ctx) => {
			const { scope, project } = ctx;
			await sessionManager.clearSession(scope, project);
			await ctx.reply("Session cleared.");
		},
	};
}
