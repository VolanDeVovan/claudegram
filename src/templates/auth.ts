/**
 * @plugin auth
 * @description Extended access control — allowedUsers whitelist.
 *   Extends core owner-only auth with configurable user whitelist.
 *   Without this plugin, only the owner can interact with the bot.
 * @priority 10
 * @config plugins.auth.allowedUsers — array of Telegram user IDs
 */
import { definePlugin, defineTool } from "@core/plugin-api.ts";
import { z } from "zod";

export default definePlugin({
	name: "auth",
	description: "Extended access control (allowedUsers whitelist)",
	priority: 10,

	configSchema: z.object({
		allowedUsers: z.array(z.string()).default([]),
	}),

	authCheck: (userId, pluginConfig) => {
		return pluginConfig.allowedUsers.includes(String(userId));
	},

	tools: [
		defineTool({
			name: "user_add",
			description: "Add a user to the allowed users whitelist",
			schema: z.object({ userId: z.string() }),
			handler: async (input, ctx) => {
				const users =
					(ctx.config.get<string[]>("plugins.auth.allowedUsers") as string[]) ??
					[];
				if (users.includes(input.userId)) {
					return `User ${input.userId} is already in the whitelist.`;
				}
				ctx.config.set("plugins.auth.allowedUsers", [...users, input.userId]);
				return `User ${input.userId} added to whitelist.`;
			},
		}),
		defineTool({
			name: "user_remove",
			description: "Remove a user from the allowed users whitelist",
			schema: z.object({ userId: z.string() }),
			handler: async (input, ctx) => {
				const users =
					(ctx.config.get<string[]>("plugins.auth.allowedUsers") as string[]) ??
					[];
				const filtered = users.filter((id) => id !== input.userId);
				ctx.config.set("plugins.auth.allowedUsers", filtered);
				return `User ${input.userId} removed from whitelist.`;
			},
		}),
	],
});
