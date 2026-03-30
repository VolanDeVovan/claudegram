/**
 * @plugin thread-routing
 * @description Maps projects to Telegram forum topics.
 *   Each project gets its own thread. Messages in a thread
 *   are automatically routed to the corresponding project session.
 * @priority 20
 * @config plugins.thread-routing.threadMap — Record<threadId, projectName>
 */
import {
	definePlugin,
	defineTool,
	type ResponseTarget,
} from "@core/plugin-api.ts";
import { z } from "zod";

export default definePlugin({
	name: "thread-routing",
	description: "Routes messages in forum threads to project sessions",
	priority: 20,

	configSchema: z.object({
		threadMap: z.record(z.string(), z.string()).default({}),
	}),

	resolveTarget: (_userId, _project, ctx) => {
		const target: ResponseTarget = { chatId: ctx.chat!.id };
		if (ctx.message?.message_thread_id) {
			target.messageThreadId = ctx.message.message_thread_id;
		}
		return target;
	},

	middleware: [
		async (ctx, next) => {
			if (ctx.message?.message_thread_id) {
				const threadId = String(ctx.message.message_thread_id);
				const cfg = ctx.pluginContext.config.get<{
					threadMap?: Record<string, string>;
				}>("plugins.thread-routing");
				const projectName = cfg?.threadMap?.[threadId];
				if (projectName) {
					const userId = String(ctx.from!.id);
					const active = ctx.pluginContext.sessions.getActive(
						userId,
						projectName,
					);
					if (active) {
						ctx.pluginContext.sessions.activate(active.id);
					}
				}
			}
			await next();
		},
	],

	tools: [
		defineTool({
			name: "thread_map_set",
			description:
				"Map a Telegram forum thread to a project. threadId is the message_thread_id, projectName is the project name.",
			schema: z.object({
				threadId: z.string(),
				projectName: z.string(),
			}),
			handler: async (input, ctx) => {
				const cfg =
					(ctx.config.get<{ threadMap?: Record<string, string> }>(
						"plugins.thread-routing",
					) as { threadMap?: Record<string, string> }) ?? {};
				const threadMap = {
					...cfg.threadMap,
					[input.threadId]: input.projectName,
				};
				ctx.config.set("plugins.thread-routing", { ...cfg, threadMap });
				return `Thread ${input.threadId} mapped to project ${input.projectName}.`;
			},
		}),
	],
});
