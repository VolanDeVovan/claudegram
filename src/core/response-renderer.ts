import { getLogger } from "@logtape/logtape";
import type { Bot } from "grammy";
import {
	markdownToTelegramHtml,
	splitTelegramHtmlChunks,
} from "./markdown-html.ts";
import type { BotContext, QueryEvent, ResponseTarget } from "./plugin-api.ts";

const log = getLogger(["bot", "renderer"]);

const TELEGRAM_MSG_LIMIT = 4096;
const EDIT_DEBOUNCE_MS = 300;

export async function defaultRenderer(
	events: AsyncIterable<QueryEvent>,
	target: ResponseTarget,
	bot: Bot<BotContext>,
): Promise<void> {
	let text = "";
	const sentMessages: number[] = [];
	let lastEditTime = 0;
	let lastSentText = "";
	let pendingEdit: ReturnType<typeof setTimeout> | null = null;

	const sendOpts = target.messageThreadId
		? { message_thread_id: target.messageThreadId }
		: {};

	async function flush(): Promise<void> {
		if (pendingEdit) {
			clearTimeout(pendingEdit);
			pendingEdit = null;
		}
		await render();
	}

	async function sendHtml(html: string): Promise<number> {
		try {
			const sent = await bot.api.sendMessage(target.chatId, html, {
				...sendOpts,
				parse_mode: "HTML",
			});
			return sent.message_id;
		} catch {
			// HTML parse error — fallback to plain text
			const sent = await bot.api.sendMessage(
				target.chatId,
				html.replace(/<[^>]+>/g, ""),
				sendOpts,
			);
			return sent.message_id;
		}
	}

	async function editHtml(msgId: number, html: string): Promise<void> {
		try {
			await bot.api.editMessageText(target.chatId, msgId, html, {
				parse_mode: "HTML",
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// "message is not modified" is fine — skip
			if (msg.includes("message is not modified")) return;
			// HTML parse error — retry plain
			try {
				await bot.api.editMessageText(
					target.chatId,
					msgId,
					html.replace(/<[^>]+>/g, ""),
				);
			} catch (e2) {
				log.error("Renderer edit error: {error}", {
					error: e2 instanceof Error ? e2.message : String(e2),
				});
			}
		}
	}

	async function render(): Promise<void> {
		if (!text || text === lastSentText) return;

		const html = markdownToTelegramHtml(text);
		const chunks = splitTelegramHtmlChunks(html, TELEGRAM_MSG_LIMIT);

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (!chunk) continue;
			if (i < sentMessages.length) {
				// Edit existing message
				await editHtml(sentMessages[i] as number, chunk);
			} else {
				// Send new message
				const msgId = await sendHtml(chunk);
				sentMessages.push(msgId);
			}
		}

		lastSentText = text;
		lastEditTime = Date.now();
	}

	function scheduleEdit(): void {
		const now = Date.now();
		const elapsed = now - lastEditTime;

		if (elapsed >= EDIT_DEBOUNCE_MS) {
			render();
		} else if (!pendingEdit) {
			pendingEdit = setTimeout(() => {
				pendingEdit = null;
				render();
			}, EDIT_DEBOUNCE_MS - elapsed);
		}
	}

	for await (const event of events) {
		if (event.type === "text_delta") {
			text += event.delta;
			scheduleEdit();
		}
	}

	await flush();
}
