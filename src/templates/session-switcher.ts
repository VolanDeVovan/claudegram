/**
 * @plugin session-switcher
 * @description Switch between sessions within a project via inline keyboard.
 *   Adds /sessions (keyboard list), /resume (pick by number or keyboard),
 *   /continue (resume latest inactive).
 *   Uses ctx.pluginContext.sessions API from core.
 * @priority 50
 * @postInstall Added commands: `/sessions` (list all), `/resume` (pick session),
 *   `/continue` (resume latest inactive). Works immediately, no configuration needed.
 */
import { definePlugin } from "@core/plugin-api.ts";
import { InlineKeyboard } from "grammy";

const PREFIX = "sess:";
const MAX_SESSIONS = 10;

function timeSince(dateStr: string): string {
	const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function buildKeyboard(
	sessions: {
		id: string;
		projectName: string;
		turns: number;
		lastUsed: string;
		isActive: boolean;
	}[],
): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (const s of sessions.slice(0, MAX_SESSIONS)) {
		const label = `${s.isActive ? "▸ " : ""}${s.projectName} — ${s.turns} turns, ${timeSince(s.lastUsed)} ago`;
		kb.text(label, `${PREFIX}${s.id}`).row();
	}
	return kb;
}

export default definePlugin({
	name: "session-switcher",
	description:
		"Switch between sessions via inline keyboard (/sessions, /resume, /continue)",
	priority: 50,

	middleware: [
		async (ctx, next) => {
			const data = ctx.callbackQuery?.data;
			if (!data?.startsWith(PREFIX)) return next();

			const sessionId = data.slice(PREFIX.length);
			const userId = String(ctx.from?.id);
			const sessions = ctx.pluginContext.sessions;
			const allSessions = sessions.list(userId);
			const target = allSessions.find((s) => s.id === sessionId);

			if (!target) {
				await ctx.answerCallbackQuery({
					text: "Session no longer exists",
					show_alert: true,
				});
				return;
			}

			if (target.isActive) {
				await ctx.answerCallbackQuery();
				return;
			}

			sessions.activate(target.id);

			const updated = sessions.list(userId);
			const kb = buildKeyboard(updated);
			await ctx.editMessageText("Sessions:", { reply_markup: kb });
			await ctx.answerCallbackQuery({
				text: `Resumed ${target.projectName} (${target.turns} turns)`,
			});
		},
	],

	commands: {
		sessions: {
			description: "List all sessions for the current project",
			handler: async (ctx) => {
				const userId = String(ctx.from?.id);
				const allSessions = ctx.pluginContext.sessions.list(userId);

				if (!allSessions.length) {
					await ctx.reply("No sessions found.");
					return;
				}

				const kb = buildKeyboard(allSessions);
				await ctx.reply("Sessions:", { reply_markup: kb });
			},
		},

		resume: {
			description: "Resume a specific session by number (e.g. /resume 3)",
			handler: async (ctx) => {
				const arg = (ctx.match as string)?.trim();
				const num = Number.parseInt(arg, 10);

				if (!arg || Number.isNaN(num)) {
					// No valid number — show keyboard
					const userId = String(ctx.from?.id);
					const allSessions = ctx.pluginContext.sessions.list(userId);
					if (!allSessions.length) {
						await ctx.reply("No sessions found.");
						return;
					}
					const kb = buildKeyboard(allSessions);
					await ctx.reply("Sessions:", { reply_markup: kb });
					return;
				}

				const userId = String(ctx.from?.id);
				const allSessions = ctx.pluginContext.sessions.list(userId);
				const target = allSessions[num - 1];

				if (!target) {
					await ctx.reply(
						"Invalid session number. Use /sessions to see the list.",
					);
					return;
				}

				ctx.pluginContext.sessions.activate(target.id);
				await ctx.reply(
					`Resumed session in ${target.projectName} (${target.turns} turns).`,
				);
			},
		},

		continue: {
			description: "Resume the most recent inactive session",
			handler: async (ctx) => {
				const userId = String(ctx.from?.id);
				const allSessions = ctx.pluginContext.sessions.list(userId);
				const latest = allSessions
					.filter((s) => !s.isActive)
					.sort(
						(a, b) =>
							new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
					)[0];

				if (!latest) {
					await ctx.reply("No previous session to continue.");
					return;
				}

				ctx.pluginContext.sessions.activate(latest.id);
				await ctx.reply(
					`Continued session in ${latest.projectName} (${latest.turns} turns, ${timeSince(latest.lastUsed)} ago).`,
				);
			},
		},
	},
});
