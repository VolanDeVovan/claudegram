/**
 * @plugin photo-handler
 * @description Handles photo messages — downloads via grammy getFile(),
 *   passes to Claude as image input for analysis.
 */
import { definePlugin } from "@core/plugin-api.ts";

export default definePlugin({
	name: "photo-handler",
	description: "Downloads photos and passes them to Claude for analysis",

	handlers: {
		"message:photo": async (ctx) => {
			const userId = String(ctx.from!.id);
			const { sessions, bot } = ctx.pluginContext;
			const project = sessions.getActive(userId, "self")?.projectName ?? "self";

			const photos = ctx.message!.photo!;
			const photo = photos[photos.length - 1]!;
			const file = await ctx.api.getFile(photo.file_id);
			const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

			const response = await fetch(url);
			const buffer = await response.arrayBuffer();
			const base64 = Buffer.from(buffer).toString("base64");

			const caption = ctx.message!.caption ?? "What do you see in this image?";

			const events = ctx.pluginContext.query({
				message: caption,
				userId,
				project,
				images: [{ mediaType: "image/jpeg", data: base64 }],
			});

			for await (const _event of events) {
				// Events consumed by executor/renderer
			}
		},
	},
});
