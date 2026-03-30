/**
 * @plugin forum-routing
 * @description Maps Telegram forum topics to projects in group chats.
 *   Each project gets its own forum topic. Messages in a topic
 *   are automatically routed to the corresponding project session.
 *   Only activates in supergroups with forum topics enabled.
 * @priority 20
 * @config plugins.forum-routing.threadMap — Record<threadId, projectName>
 */
import { definePlugin } from "@core/plugin-api.ts";
import type { SessionManager } from "@core/session-manager.ts";
import { z } from "zod";

export default definePlugin({
	name: "forum-routing",
	description: "Routes forum topics to project sessions in group chats",
	priority: 20,

	configSchema: z.object({
		threadMap: z.record(z.string(), z.string()).default({}),
	}),

	middleware: [
		async (ctx, next) => {
			const threadId = ctx.message?.message_thread_id;
			if (!threadId) return next();

			// Only handle forum topics in supergroups
			const chatType = ctx.chat?.type;
			if (chatType !== "supergroup") return next();

			const threadKey = String(threadId);
			const cfg = ctx.pluginContext.config.get<{
				threadMap?: Record<string, string>;
			}>("plugins.forum-routing");
			const projectName = cfg?.threadMap?.[threadKey];

			if (projectName) {
				const userId = String(ctx.from!.id);
				const sessions = ctx.pluginContext.sessions as SessionManager;
				// Switch active project to match the forum topic
				sessions.setActiveProject(userId, projectName);
				// Resume existing session if any
				const active = sessions.getActive(userId, projectName);
				if (active) {
					sessions.activate(active.id);
				}
			}
			await next();
		},
	],
});
