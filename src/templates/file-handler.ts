/**
 * @plugin file-handler
 * @description Handles file uploads from Telegram and provides send_file tool.
 *   Downloads photos, documents, voice messages, videos, and audio to the project's
 *   .uploads/ directory. The send_file tool is available in ALL projects — the agent
 *   can send files from any project directory to the user's chat.
 * @priority 25
 * @prerequisites Bot must be able to download files (standard bot API permissions).
 * @postInstall Files sent to the bot will be downloaded to <project>/.uploads/ and
 *   forwarded to the agent as text. A `send_file` tool will be added to ALL projects
 *   (not just this one), allowing the agent to send files back to the chat.
 *   Consider adding .uploads/ to .gitignore in your projects.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { definePlugin, defineTool } from "@core/plugin-api.ts";
import { getLogger } from "@logtape/logtape";
import { InputFile } from "grammy";
import { z } from "zod";

const log = getLogger(["bot", "plugin", "file-handler"]);

const IMAGE_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".bmp",
	".webp",
]);

function uniqueName(base: string, ext: string): string {
	const ts = Math.floor(Date.now() / 1000);
	const rnd = randomBytes(2).toString("hex").slice(0, 3);
	return `${base}_${ts}_${rnd}.${ext}`;
}

function stripExt(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot > 0 ? filename.slice(0, dot) : filename;
}

function getExt(filename: string, fallback: string): string {
	const dot = filename.lastIndexOf(".");
	return dot > 0 ? filename.slice(dot + 1) : fallback;
}

interface BufferedGroup {
	files: string[];
	caption?: string;
	timer: Timer;
	cwd: string;
	userId: string;
	project: string;
}

const mediaGroupBuffer = new Map<string, BufferedGroup>();

export default definePlugin({
	name: "file-handler",
	description:
		"Downloads files from Telegram to .uploads/, provides send_file tool",
	priority: 25,

	middleware: [
		async (ctx, next) => {
			const msg = ctx.message;
			if (!msg) return next();

			// Extract file info from message
			const fileInfo = getFileInfo(msg);
			if (!fileInfo) return next();

			const userId = String(ctx.from?.id);
			const project = ctx.pluginContext.sessions.getActiveProject(userId);
			const projectConfig = ctx.pluginContext.config.data.projects.find(
				(p) => p.name === project,
			);
			const cwd =
				project === "self"
					? process.cwd()
					: (projectConfig?.path ?? process.cwd());

			let filename: string;
			try {
				filename = await downloadFile(
					ctx,
					fileInfo.fileId,
					fileInfo.filename,
					cwd,
				);
			} catch (e) {
				log.error("File download failed: {error}", {
					error: e instanceof Error ? e.message : String(e),
				});
				await ctx.reply(
					`Не удалось скачать файл, попробуй ещё раз\n\n${e instanceof Error ? e.message : String(e)}`,
				);
				return;
			}

			const caption = msg.caption;

			// Media group handling
			const groupId = msg.media_group_id;
			if (groupId) {
				let group = mediaGroupBuffer.get(groupId);
				if (!group) {
					group = {
						files: [],
						caption: undefined,
						// biome-ignore lint/style/noNonNullAssertion: timer is set immediately below
						timer: null! as Timer,
						cwd,
						userId,
						project,
					};
					mediaGroupBuffer.set(groupId, group);
				}
				group.files.push(filename);
				if (caption) group.caption = caption;

				clearTimeout(group.timer);
				group.timer = setTimeout(async () => {
					mediaGroupBuffer.delete(groupId);
					// biome-ignore lint/style/noNonNullAssertion: group is guaranteed to exist inside its own timeout
					const text = formatOverrideText(group!.files, group!.caption);
					ctx.overrideText = text;
					try {
						await next();
					} catch (e) {
						log.error("Media group pipeline error: {error}", {
							error: e instanceof Error ? e.message : String(e),
						});
					}
				}, 500);
				return;
			}

			// Single file
			ctx.overrideText = formatOverrideText([filename], caption);
			return next();
		},
	],

	tools: [
		defineTool({
			name: "send_file",
			description:
				"Send a file from the project directory to the Telegram chat. " +
				'Mode "auto" (default) sends images as photos (inline preview) and everything else as documents. ' +
				'"photo" forces inline photo (fails if not an image). ' +
				'"document" always sends as a file attachment (preserves original quality and filename).',
			schema: z.object({
				path: z
					.string()
					.describe("Relative path to the file within the project directory"),
				mode: z
					.enum(["auto", "photo", "document"])
					.default("auto")
					.describe(
						"How to send: auto (images as photos, rest as documents), photo (force inline), document (force attachment)",
					),
				caption: z
					.string()
					.optional()
					.describe("Optional caption shown below the file"),
			}),
			scope: "all",
			handler: async ({ path: filePath, mode, caption }, ctx) => {
				if (!ctx.chatId) {
					return "Error: send_file is not available in nested queries (no chat context)";
				}

				if (isAbsolute(filePath)) {
					return "Error: path must be relative to the project directory";
				}

				const absolute = resolve(ctx.cwd, filePath);
				const rel = relative(ctx.cwd, absolute);
				if (rel.startsWith("..")) {
					return "Error: path must be within the project directory";
				}

				const file = Bun.file(absolute);
				if (!(await file.exists())) {
					return `Error: file not found: ${filePath}`;
				}

				const ext = extname(absolute).toLowerCase();
				const isImage = IMAGE_EXTENSIONS.has(ext);
				const sendAsPhoto = mode === "photo" || (mode === "auto" && isImage);

				if (mode === "photo" && !isImage) {
					return `Error: ${ext || "unknown"} is not a supported image format. Use mode "document" or "auto".`;
				}

				const threadOpts = ctx.messageThreadId
					? { message_thread_id: ctx.messageThreadId }
					: {};

				const name = basename(absolute);

				try {
					if (sendAsPhoto) {
						try {
							await ctx.bot.api.sendPhoto(
								ctx.chatId,
								new InputFile(file.stream(), name),
								{ ...threadOpts, caption },
							);
							return `Photo sent: ${name}`;
						} catch (e) {
							// auto mode: fall back to document on sendPhoto failure
							if (mode === "auto") {
								await ctx.bot.api.sendDocument(
									ctx.chatId,
									new InputFile(Bun.file(absolute).stream(), name),
									{ ...threadOpts, caption },
								);
								return `File sent as document (photo failed): ${name}`;
							}
							throw e;
						}
					}

					await ctx.bot.api.sendDocument(
						ctx.chatId,
						new InputFile(file.stream(), name),
						{ ...threadOpts, caption },
					);
				} catch (e) {
					return `Error sending file: ${e instanceof Error ? e.message : String(e)}`;
				}
				return `File sent: ${name}`;
			},
		}),
	],
});

function formatOverrideText(files: string[], caption?: string): string {
	const lines = ["Attached files:"];
	for (const f of files) {
		lines.push(`- ${f}`);
	}
	if (caption) {
		lines.push("", caption);
	}
	return lines.join("\n");
}

// biome-ignore lint/suspicious/noExplicitAny: grammy message types are complex
function getFileInfo(msg: any): { fileId: string; filename: string } | null {
	if (msg.photo && msg.photo.length > 0) {
		const photo = msg.photo[msg.photo.length - 1];
		return { fileId: photo.file_id, filename: uniqueName("photo", "jpg") };
	}
	if (msg.document) {
		const orig = msg.document.file_name ?? "document";
		return {
			fileId: msg.document.file_id,
			filename: uniqueName(stripExt(orig), getExt(orig, "bin")),
		};
	}
	if (msg.voice) {
		return { fileId: msg.voice.file_id, filename: uniqueName("voice", "ogg") };
	}
	if (msg.video) {
		return { fileId: msg.video.file_id, filename: uniqueName("video", "mp4") };
	}
	if (msg.audio) {
		const title = msg.audio.title ?? msg.audio.file_name ?? "audio";
		const ext = msg.audio.file_name
			? getExt(msg.audio.file_name, "mp3")
			: "mp3";
		return {
			fileId: msg.audio.file_id,
			filename: uniqueName(stripExt(title), ext),
		};
	}
	if (msg.video_note) {
		return {
			fileId: msg.video_note.file_id,
			filename: uniqueName("videonote", "mp4"),
		};
	}
	// Stickers and unsupported types — skip
	return null;
}

async function downloadFile(
	ctx: {
		api: {
			getFile: (id: string) => Promise<{ file_path?: string }>;
			token: string;
		};
	},
	fileId: string,
	filename: string,
	cwd: string,
): Promise<string> {
	const file = await ctx.api.getFile(fileId);
	if (!file.file_path) {
		throw new Error("Telegram returned no file_path — file may be too large");
	}
	const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	const uploadDir = resolve(cwd, ".uploads");
	await mkdir(uploadDir, { recursive: true });
	const fullPath = resolve(uploadDir, filename);
	await Bun.write(fullPath, buffer);
	log.info("File saved: {filename}", { filename });
	return `.uploads/${filename}`;
}
