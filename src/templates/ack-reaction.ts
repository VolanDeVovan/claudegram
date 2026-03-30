/**
 * @plugin ack-reaction
 * @description Reacts to incoming messages with an emoji before processing.
 *   Gives the user instant feedback that their message was received.
 * @priority 15
 * @config plugins.ack-reaction.emoji — reaction emoji (default: "👀")
 */
import { definePlugin } from "@core/plugin-api.ts";
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
});
