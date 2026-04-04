/**
 * @plugin project-switcher
 * @description Adds /project command with inline keyboard for switching between projects.
 *   Shows buttons for each project, highlights the active one.
 *   Works in any chat type but designed primarily for private chats.
 * @priority 30
 * @postInstall Added command `/project` — shows inline keyboard to switch between projects.
 *   If the user has only "self" project, suggest adding a project first.
 */
import { definePlugin } from "@core/plugin-api.ts";
import { InlineKeyboard } from "grammy";

const PREFIX = "proj:";

function buildKeyboard(
	projects: { name: string; description?: string }[],
	activeProject: string,
): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (const p of projects) {
		const isActive = p.name === activeProject;
		const label = `${isActive ? "✅ " : ""}${p.description ?? p.name}`;
		kb.text(label, `${PREFIX}${p.name}`).row();
	}
	return kb;
}

export default definePlugin({
	name: "project-switcher",
	description: "Switch between projects via inline keyboard (/project)",
	priority: 30,

	async resolveContext(ctx, pluginCtx) {
		const project = await pluginCtx.scopeStore.get<string>(
			ctx.userId,
			"active_project",
		);
		if (!project) return null;
		return { scope: ctx.userId, project };
	},

	middleware: [
		async (ctx, next) => {
			const data = ctx.callbackQuery?.data;
			if (!data?.startsWith(PREFIX)) return next();

			const projectName = data.slice(PREFIX.length);
			const config = ctx.pluginContext.config;
			const projects = config.data.projects;

			const target = projects.find((p) => p.name === projectName);
			if (!target) {
				await ctx.answerCallbackQuery({
					text: "Project not found",
					show_alert: true,
				});
				return;
			}

			await ctx.pluginContext.scopeStore.set(
				ctx.userId,
				"active_project",
				target.name,
			);

			const kb = buildKeyboard(projects, target.name);
			await ctx.editMessageText("Select project:", { reply_markup: kb });
			await ctx.answerCallbackQuery({
				text: `Switched to ${target.description ?? target.name}`,
			});
		},
	],

	commands: {
		project: {
			description: "Switch project or list available projects",
			handler: async (ctx) => {
				const config = ctx.pluginContext.config;
				const projects = config.data.projects;
				const arg = (ctx.match as string)?.trim();

				if (!arg) {
					if (projects.length === 0) {
						await ctx.reply("No projects configured.");
						return;
					}
					const activeProject =
						(await ctx.pluginContext.scopeStore.get<string>(
							ctx.userId,
							"active_project",
						)) ?? "self";
					const kb = buildKeyboard(projects, activeProject);
					await ctx.reply("Select project:", { reply_markup: kb });
					return;
				}

				// Text fallback: /project <name>
				const target = projects.find(
					(p) => p.name.toLowerCase() === arg.toLowerCase(),
				);
				if (!target) {
					await ctx.reply(
						`Project "${arg}" not found. Available: ${projects.map((p) => p.name).join(", ")}`,
					);
					return;
				}

				await ctx.pluginContext.scopeStore.set(
					ctx.userId,
					"active_project",
					target.name,
				);
				await ctx.reply(`Switched to project "${target.name}".`);
			},
		},
	},
});
