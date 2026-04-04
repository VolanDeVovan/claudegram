/**
 * @plugin forum-routing
 * @description Maps Telegram forum topics to projects in group chats.
 *   Each project gets its own forum topic. Messages in a topic
 *   are automatically routed to the corresponding project session.
 *   Only activates in supergroups with forum topics enabled.
 * @priority 20
 * @config plugins.forum-routing.threadMap — Record<threadId, projectName>
 * @prerequisites The bot must be added to a supergroup with forum topics enabled
 *   (group settings → Topics → ON). At least two projects must be configured.
 * @postInstall Run /setup_topics in the group chat to create a forum topic per project
 *   and auto-configure threadMap.
 */
import { definePlugin } from "@core/plugin-api.ts";
import { z } from "zod";

export default definePlugin({
	name: "forum-routing",
	description: "Routes forum topics to project sessions in group chats",
	priority: 20,

	configSchema: z.object({
		threadMap: z.record(z.string(), z.string()).default({}),
	}),

	resolveContext(ctx, pluginCtx) {
		if (ctx.chat?.type !== "supergroup") return null;
		if (!ctx.from?.id) return null;
		const threadId = ctx.message?.message_thread_id;
		if (!threadId) return null;

		const threadKey = String(threadId);
		const cfg = pluginCtx.config.get<{
			threadMap?: Record<string, string>;
		}>("plugins.forum-routing");
		const project = cfg?.threadMap?.[threadKey];
		if (!project) return null;

		const scope = `${ctx.chat.id}:${threadKey}:${ctx.from.id}`;
		return {
			scope,
			project,
			target: {
				chatId: ctx.chat.id,
				messageThreadId: threadId,
				scope,
				project,
			},
		};
	},

	commands: {
		setup_topics: {
			description: "Create a forum topic per project and configure threadMap",
			handler: async (ctx) => {
				const chatId = ctx.chat?.id;
				if (!chatId || ctx.chat?.type !== "supergroup") {
					await ctx.reply(
						"This command only works in a supergroup with forum topics.",
					);
					return;
				}

				const projects: Array<{ name: string }> =
					ctx.pluginContext.config.get("projects") ?? [];

				if (projects.length === 0) {
					await ctx.reply("No projects configured.");
					return;
				}

				const existing =
					ctx.pluginContext.config.get<{
						threadMap?: Record<string, string>;
					}>("plugins.forum-routing")?.threadMap ?? {};
				const alreadyMapped = new Set(Object.values(existing));
				const toCreate = projects.filter((p) => !alreadyMapped.has(p.name));

				if (toCreate.length === 0) {
					await ctx.reply("All projects already have topics.");
					return;
				}

				await ctx.reply(`Creating ${toCreate.length} topic(s)…`);

				const threadMap: Record<string, string> = { ...existing };
				const results: string[] = [];

				for (const project of toCreate) {
					try {
						const topic = await ctx.api.createForumTopic(chatId, project.name);
						threadMap[String(topic.message_thread_id)] = project.name;
						results.push(
							`✅ ${project.name} → topic ${topic.message_thread_id}`,
						);
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						results.push(`❌ ${project.name}: ${msg}`);
					}
				}

				if (Object.keys(threadMap).length > 0) {
					ctx.pluginContext.config.set(
						"plugins.forum-routing.threadMap",
						threadMap,
					);
				}

				await ctx.reply(results.join("\n"));
			},
		},
	},
});
