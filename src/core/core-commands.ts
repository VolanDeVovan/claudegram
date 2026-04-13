import type { Bot } from "grammy";
import type { ConfigManager } from "./config.ts";
import type { BotContext } from "./plugin-api.ts";
import type { SessionManager } from "./session-manager.ts";
import { applyRollback, type BotRuntime } from "./update.ts";
import type { NotifyTarget } from "./update-state.ts";

const startedAt = Date.now();

function targetFromContext(ctx: BotContext): NotifyTarget {
	// Inside command/callback handlers grammy guarantees ctx.chat is set.
	// Surface the invariant explicitly so a violation throws a clear error
	// instead of targeting chat 0 and failing opaquely on sendMessage.
	if (!ctx.chat) {
		throw new Error("targetFromContext called without ctx.chat");
	}
	const target: NotifyTarget = { chatId: ctx.chat.id };
	const threadId = ctx.msg?.message_thread_id;
	if (threadId) target.messageThreadId = threadId;
	return target;
}

export function registerCoreCommands(
	bot: Bot<BotContext>,
	sessionManager: SessionManager,
	reloadPlugins: () => Promise<{ loaded: string[]; errors: string[] }>,
	runtime: BotRuntime,
): void {
	const { generations } = runtime;
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
		const current = generations.getCurrent();
		if (current <= 1) {
			await ctx.reply("No previous generation to rollback to.");
			return;
		}
		const target = current - 1;
		// Early feedback: applyRollback may take several seconds (bun install
		// runs on both paths). On the cold-restart branch it never returns,
		// so without this reply the user sees nothing until the post-restart
		// startup notification arrives.
		await ctx.reply(`Rolling back to generation ${target}…`).catch(() => {});
		try {
			const result = await applyRollback(
				runtime,
				target,
				ctx.scope,
				ctx.project,
				targetFromContext(ctx),
				reloadPlugins,
			);
			// If a restart was needed, applyRollback never returns — control
			// reaches this line only on the hot-reload path.
			await ctx.reply(result.message);
			sessionManager.pushContext(
				ctx.scope,
				ctx.project,
				`[/rollback]\n${result.message}`,
			);
		} catch (e) {
			const msg = `Rollback failed: ${e instanceof Error ? e.message : String(e)}`;
			await ctx.reply(msg);
			sessionManager.pushContext(
				ctx.scope,
				ctx.project,
				`[/rollback failed]\n${msg}`,
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
