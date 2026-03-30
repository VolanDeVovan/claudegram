/**
 * @plugin status-command
 * @description Adds /status command — shows current project,
 *   active plugins, session cost, and turn count.
 */
import { definePlugin } from "@core/plugin-api.ts";

export default definePlugin({
	name: "status-command",
	description: "Shows bot status: project, plugins, session info",

	commands: {
		status: {
			description: "Show current project, session, and costs",
			handler: async (ctx) => {
				const userId = String(ctx.from!.id);
				const { config, sessions } = ctx.pluginContext;

				const activeProject = sessions.getActive(userId, "self")
					? "self"
					: "self";
				const session = sessions.getActive(userId, activeProject);
				const projects = config.data.projects.map((p) => p.name).join(", ");

				const lines = [
					"*Status*",
					`Project: ${activeProject}`,
					`Model: ${config.data.model}`,
					`Projects: ${projects || "self"}`,
					"",
				];

				if (session) {
					lines.push(
						`Session: ${session.id.slice(0, 8)}...`,
						`Turns: ${session.turns}`,
						`Cost: $${session.costUsd.toFixed(4)}`,
						`Last used: ${session.lastUsed}`,
					);
				} else {
					lines.push("No active session.");
				}

				await ctx.reply(lines.join("\n"));
			},
		},
	},
});
