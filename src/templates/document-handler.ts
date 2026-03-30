/**
 * @plugin document-handler
 * @description Handles file attachments — downloads and reads content
 *   (text, code, etc.), passes to Claude as context.
 */
import { definePlugin } from "@core/plugin-api.ts";

export default definePlugin({
	name: "document-handler",
	description: "Downloads file attachments and passes content to Claude",

	handlers: {
		"message:document": async (ctx) => {
			const userId = String(ctx.from!.id);
			const { sessions, bot } = ctx.pluginContext;
			const project = sessions.getActive(userId, "self")?.projectName ?? "self";

			const doc = ctx.message!.document!;
			const file = await ctx.api.getFile(doc.file_id);
			const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

			const response = await fetch(url);
			const content = await response.text();

			const caption =
				ctx.message!.caption ?? "Here is a file for you to analyze:";
			const message = `${caption}\n\nFilename: ${doc.file_name ?? "unknown"}\nSize: ${doc.file_size ?? 0} bytes\n\nContent:\n\`\`\`\n${content}\n\`\`\``;

			const events = ctx.pluginContext.query({
				message,
				userId,
				project,
			});

			for await (const _event of events) {
				// Events consumed by executor/renderer
			}
		},
	},
});
