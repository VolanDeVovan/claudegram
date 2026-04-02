/**
 * @plugin ack-reaction
 * @description Reacts to incoming messages with an emoji before processing.
 *   Gives the user instant feedback that their message was received.
 *   Updates reaction to ✅ or ❌ after query completes via afterQuery hook.
 * @priority 15
 * @config plugins.ack-reaction.emoji — reaction emoji (default: "👀")
 * @prerequisites Bot must have permission to react to messages in the chat
 *   (admin rights not required in private chats, but may be needed in groups).
 * @postInstall Bot will react with 👀 on incoming messages, then update to ✅ (success)
 *   or ❌ (error) after processing. Emoji is configurable via config.
 */
import { definePlugin, type QueryResult } from "@core/plugin-api.ts";
import { z } from "zod";

export default definePlugin({
	name: "ack-reaction",
	description: "Reacts to incoming messages with a configurable emoji",
	priority: 15,

	configSchema: z.object({
		emoji: z.string().default("👀"),
	}),

	middleware: [
		async (ctx, next) => {
			if (ctx.message) {
				const cfg = ctx.pluginContext.config.get<{ emoji?: string }>(
					"plugins.ack-reaction",
				);
				try {
					// biome-ignore lint/suspicious/noExplicitAny: grammy react() typing doesn't accept dynamic strings
					await ctx.react((cfg?.emoji ?? "👀") as any);
				} catch {
					// Reaction might fail in some chat types
				}
			}
			await next();
		},
	],

	afterQuery: async (result: QueryResult, ctx) => {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: grammy react() typing doesn't accept dynamic strings
			await ctx.react((result.error ? "❌" : "✅") as any);
		} catch {
			// Reaction might fail in some chat types
		}
	},
});
