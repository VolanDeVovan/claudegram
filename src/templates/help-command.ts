/**
 * @plugin help-command
 * @description Adds /help command — lists all available commands
 *   collected from loaded plugins.
 */
import { definePlugin } from "@core/plugin-api.ts";

export default definePlugin({
	name: "help-command",
	description: "Lists all available commands from loaded plugins",

	commands: {
		help: {
			description: "Show available commands and capabilities",
			handler: async (ctx) => {
				const lines = [
					"*Available Commands*",
					"",
					"/start — Welcome message and bot info",
					"/new — Start a new conversation",
					"/clear — Clear current session",
					"/cancel — Cancel running query",
					"/ping — Health check",
					"/help — This message",
				];
				await ctx.reply(lines.join("\n"));
			},
		},
	},
});
