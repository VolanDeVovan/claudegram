/**
 * @plugin private-topic-routing
 * @description Maps topics in private chats to projects.
 *   Each project gets its own topic. Messages in a topic
 *   are automatically routed to the corresponding project session.
 *   Only activates in private chats with topics enabled.
 * @priority 20
 * @config plugins.private-topic-routing.topicMap — Record<topicId, projectName>
 * @prerequisites Bot must have "Threaded mode" enabled in BotFather.
 *   This setting is only available through the BotFather Mini App (not via commands).
 *   Open @BotFather in Telegram → tap the Mini App button (≡ menu) to launch it →
 *   select your bot → Bot Settings → Threaded mode → Enable.
 * @postInstall Run /setup_topics in the private chat to create a topic per project
 *   and auto-configure topicMap.
 */
import { definePlugin } from "@core/plugin-api.ts";
import { z } from "zod";

export default definePlugin({
	name: "private-topic-routing",
	description: "Routes private chat topics to project sessions",
	priority: 20,

	configSchema: z.object({
		topicMap: z.record(z.string(), z.string()).default({}),
	}),

	resolveContext(ctx, pluginCtx) {
		if (ctx.chat?.type !== "private") return null;
		if (!ctx.from?.id) return null;
		const threadId = ctx.message?.message_thread_id;
		if (!threadId) return null;

		const threadKey = String(threadId);
		const cfg = pluginCtx.config.get<{
			topicMap?: Record<string, string>;
		}>("plugins.private-topic-routing");
		const project = cfg?.topicMap?.[threadKey];
		if (!project) return null;

		const scope = `${ctx.from.id}:${threadKey}`;
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
			description: "Create a topic per project and configure topicMap",
			handler: async (ctx) => {
				const chatId = ctx.chat?.id;
				if (!chatId || ctx.chat?.type !== "private") {
					await ctx.reply("This command only works in a private chat.");
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
						topicMap?: Record<string, string>;
					}>("plugins.private-topic-routing")?.topicMap ?? {};
				const alreadyMapped = new Set(Object.values(existing));
				const toCreate = projects.filter((p) => !alreadyMapped.has(p.name));

				if (toCreate.length === 0) {
					await ctx.reply("All projects already have topics.");
					return;
				}

				await ctx.reply(`Creating ${toCreate.length} topic(s)…`);

				const topicMap: Record<string, string> = { ...existing };
				const results: string[] = [];

				for (const project of toCreate) {
					try {
						const topic = await ctx.api.createForumTopic(chatId, project.name);
						topicMap[String(topic.message_thread_id)] = project.name;
						results.push(
							`✅ ${project.name} → topic ${topic.message_thread_id}`,
						);
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						results.push(`❌ ${project.name}: ${msg}`);
					}
				}

				if (Object.keys(topicMap).length > 0) {
					ctx.pluginContext.config.set(
						"plugins.private-topic-routing.topicMap",
						topicMap,
					);
				}

				await ctx.reply(results.join("\n"));
			},
		},
	},
});
