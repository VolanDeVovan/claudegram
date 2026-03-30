/**
 * @plugin session-switcher
 * @description Switch between sessions within a project.
 *   Adds /sessions (list), /resume (pick from list), /continue (resume latest).
 *   Uses ctx.pluginContext.sessions API from core.
 *   This is a starting point — user can adapt: add inline keyboards,
 *   auto-resume on bot restart, session naming, etc.
 * @priority 50
 */
import { definePlugin } from "@core/plugin-api.ts";

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

export default definePlugin({
	name: "session-switcher",
	description: "Switch between sessions (/sessions, /resume, /continue)",
	priority: 50,

	commands: {
		sessions: {
			description: "List all sessions for the current project",
			handler: async (ctx) => {
				const userId = String(ctx.from!.id);
				const sessions = ctx.pluginContext.sessions.list(userId);

				if (!sessions.length) {
					await ctx.reply("No sessions found.");
					return;
				}

				const lines = sessions.map(
					(s, i) =>
						`${s.isActive ? "▸" : " "} ${i + 1}. ${s.projectName} — ${s.turns} turns, ${timeSince(s.lastUsed)} ago`,
				);
				await ctx.reply(lines.join("\n"));
			},
		},

		resume: {
			description: "Resume a specific session by number (e.g. /resume 3)",
			handler: async (ctx) => {
				const num = Number.parseInt(ctx.match as string);
				if (Number.isNaN(num)) {
					await ctx.reply(
						"Usage: /resume <number>. Use /sessions to see the list.",
					);
					return;
				}

				const userId = String(ctx.from!.id);
				const sessions = ctx.pluginContext.sessions.list(userId);
				const target = sessions[num - 1];

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
				const userId = String(ctx.from!.id);
				const sessions = ctx.pluginContext.sessions.list(userId);
				const latest = sessions
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
					`Continued session (${latest.turns} turns, ${timeSince(latest.lastUsed)} ago).`,
				);
			},
		},
	},
});
