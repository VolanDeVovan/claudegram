/**
 * @plugin project-switcher
 * @description Adds /project command for switching between projects in DMs.
 *   Lists available projects and lets the user switch the active one.
 *   Works in any chat type but designed primarily for private chats.
 * @priority 30
 */
import { definePlugin } from "@core/plugin-api.ts";
import type { SessionManager } from "@core/session-manager.ts";

export default definePlugin({
	name: "project-switcher",
	description: "Switch between projects via /project command",
	priority: 30,

	commands: {
		project: {
			description: "Switch project or list available projects",
			handler: async (ctx) => {
				const userId = String(ctx.from!.id);
				const sessions = ctx.pluginContext.sessions as SessionManager;
				const config = ctx.pluginContext.config;
				const projects = config.data.projects;
				const arg = (ctx.match as string)?.trim();

				if (!arg) {
					// List projects
					const activeProject = sessions.getActiveProject(userId);
					const lines = projects.map(
						(p) =>
							`${p.name === activeProject ? "▸ " : "  "}${p.name}${p.description ? ` — ${p.description}` : ""}`,
					);
					if (lines.length === 0) {
						await ctx.reply("No projects configured.");
						return;
					}
					await ctx.reply(
						`Projects:\n${lines.join("\n")}\n\nUsage: /project <name>`,
					);
					return;
				}

				// Switch to project
				const target = projects.find(
					(p) => p.name.toLowerCase() === arg.toLowerCase(),
				);
				if (!target) {
					await ctx.reply(
						`Project "${arg}" not found. Available: ${projects.map((p) => p.name).join(", ")}`,
					);
					return;
				}

				sessions.setActiveProject(userId, target.name);
				await ctx.reply(`Switched to project "${target.name}".`);
			},
		},
	},
});
