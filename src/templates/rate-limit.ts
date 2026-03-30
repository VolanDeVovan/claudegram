/**
 * @plugin rate-limit
 * @description Token bucket rate limiting per user.
 *   Prevents abuse by limiting requests per minute and per day.
 * @priority 15
 * @config plugins.rate-limit.rpm — requests per minute (default: 30)
 * @config plugins.rate-limit.dailyLimit — max requests per day (default: 500)
 */
import { definePlugin } from "@core/plugin-api.ts";
import { z } from "zod";

const counters = new Map<string, { count: number; windowStart: number }>();
const dailyCounters = new Map<string, { count: number; dayStart: number }>();

function getMinuteWindow(): number {
	return Math.floor(Date.now() / 60_000);
}

function getDayStart(): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export default definePlugin({
	name: "rate-limit",
	description: "Token bucket rate limiting per user (RPM and daily)",
	priority: 15,

	configSchema: z.object({
		rpm: z.number().default(30),
		dailyLimit: z.number().default(500),
	}),

	middleware: [
		async (ctx, next) => {
			if (!ctx.from) return next();

			const userId = String(ctx.from.id);
			const cfg = ctx.pluginContext.config.get<{
				rpm?: number;
				dailyLimit?: number;
			}>("plugins.rate-limit");
			const rpm = cfg?.rpm ?? 30;
			const dailyLimit = cfg?.dailyLimit ?? 500;

			const currentWindow = getMinuteWindow();
			const minuteEntry = counters.get(userId);
			if (minuteEntry && minuteEntry.windowStart === currentWindow) {
				if (minuteEntry.count >= rpm) {
					await ctx.reply("Rate limited. Please wait a moment.");
					return;
				}
				minuteEntry.count++;
			} else {
				counters.set(userId, { count: 1, windowStart: currentWindow });
			}

			const today = getDayStart();
			const dailyEntry = dailyCounters.get(userId);
			if (dailyEntry && dailyEntry.dayStart === today) {
				if (dailyEntry.count >= dailyLimit) {
					await ctx.reply("Daily limit reached. Try again tomorrow.");
					return;
				}
				dailyEntry.count++;
			} else {
				dailyCounters.set(userId, { count: 1, dayStart: today });
			}

			await next();
		},
	],
});
