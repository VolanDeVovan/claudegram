import { getLogger } from "@logtape/logtape";
import type { Bot } from "grammy";
import { markdownToTelegramHtml } from "./markdown-html.ts";
import type { BotContext, QueryEvent, ResponseTarget } from "./plugin-api.ts";

const log = getLogger(["bot", "renderer"]);

const TELEGRAM_MSG_LIMIT = 4096;
const EDIT_DEBOUNCE_MS = 300;
const MIN_EDIT_DELTA = 20;

export async function defaultRenderer(
	events: AsyncIterable<QueryEvent>,
	target: ResponseTarget,
	bot: Bot<BotContext>,
): Promise<void> {
	let text = "";
	let msgId: number | undefined;
	let lastEditTime = 0;
	let lastSentText = "";
	let pendingEdit: ReturnType<typeof setTimeout> | null = null;
	let currentChunk = 0;

	const sendOpts = target.messageThreadId
		? { message_thread_id: target.messageThreadId }
		: {};

	async function flush(): Promise<void> {
		if (pendingEdit) {
			clearTimeout(pendingEdit);
			pendingEdit = null;
		}
		await editOrSend();
	}

	async function editOrSend(): Promise<void> {
		const chunk = getChunkText();
		if (!chunk || (msgId && chunk === lastSentText)) return;

		const html = markdownToTelegramHtml(chunk);
		try {
			if (msgId) {
				await bot.api.editMessageText(target.chatId, msgId, html, {
					parse_mode: "HTML",
				});
			} else {
				const sent = await bot.api.sendMessage(target.chatId, html, {
					...sendOpts,
					parse_mode: "HTML",
				});
				msgId = sent.message_id;
			}
			lastSentText = chunk;
			lastEditTime = Date.now();
		} catch (e) {
			// HTML parse error — retry as plain text
			try {
				if (msgId) {
					await bot.api.editMessageText(target.chatId, msgId, chunk);
				} else {
					const sent = await bot.api.sendMessage(
						target.chatId,
						chunk,
						sendOpts,
					);
					msgId = sent.message_id;
				}
				lastSentText = chunk;
				lastEditTime = Date.now();
			} catch (e2) {
				log.error("Renderer send error: {error}", {
					error: e2 instanceof Error ? e2.message : String(e2),
				});
			}
		}
	}

	function getChunkText(): string {
		const start = currentChunk * TELEGRAM_MSG_LIMIT;
		return text.slice(start, start + TELEGRAM_MSG_LIMIT);
	}

	function scheduleEdit(): void {
		const now = Date.now();
		const elapsed = now - lastEditTime;

		if (elapsed >= EDIT_DEBOUNCE_MS) {
			editOrSend();
		} else if (!pendingEdit) {
			pendingEdit = setTimeout(() => {
				pendingEdit = null;
				editOrSend();
			}, EDIT_DEBOUNCE_MS - elapsed);
		}
	}

	for await (const event of events) {
		if (event.type === "text_delta") {
			text += event.delta;

			// Check if we need a new message (chunk overflow)
			const chunkStart = currentChunk * TELEGRAM_MSG_LIMIT;
			if (text.length - chunkStart > TELEGRAM_MSG_LIMIT) {
				await flush();
				currentChunk++;
				msgId = undefined;
				lastSentText = "";
			}

			scheduleEdit();
		}
	}

	// Final flush
	await flush();
}
