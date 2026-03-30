/**
 * @plugin telegraph-renderer
 * @description Publishes long responses (>2500 chars) to Telegraph Instant View.
 *   Uses Telegraph API createAccount (auto, no manual token needed).
 *   Account persisted in data/telegraph-account.json.
 *   Registers as responseRenderer — replaces default chunked output.
 * @priority 50
 * @config plugins.telegraph-renderer.threshold — char limit before switching to Telegraph (default: 2500)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BotContext,
	definePlugin,
	type QueryEvent,
	type ResponseTarget,
} from "@core/plugin-api.ts";
import type { Bot } from "grammy";
import { z } from "zod";

const TELEGRAPH_API = "https://api.telegra.ph";
const ACCOUNT_FILE = join(process.cwd(), "data", "telegraph-account.json");

interface TelegraphAccount {
	access_token: string;
	short_name: string;
}

async function getOrCreateAccount(): Promise<TelegraphAccount> {
	if (existsSync(ACCOUNT_FILE)) {
		return JSON.parse(readFileSync(ACCOUNT_FILE, "utf-8"));
	}
	const res = await fetch(`${TELEGRAPH_API}/createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			short_name: "ClaudeBot",
			author_name: "Claude Bot",
		}),
	});
	const data = (await res.json()) as { result: TelegraphAccount };
	writeFileSync(ACCOUNT_FILE, JSON.stringify(data.result, null, 2));
	return data.result;
}

function textToNodes(text: string): Array<{ tag: string; children: string[] }> {
	return text
		.split(/\n\n+/)
		.filter(Boolean)
		.map((para) => ({ tag: "p", children: [para] }));
}

async function createPage(
	account: TelegraphAccount,
	title: string,
	text: string,
): Promise<{ url: string }> {
	const content = textToNodes(text);
	const res = await fetch(`${TELEGRAPH_API}/createPage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			access_token: account.access_token,
			title,
			content,
			author_name: "Claude Bot",
		}),
	});
	const data = (await res.json()) as { result: { url: string } };
	return data.result;
}

const EDIT_DEBOUNCE_MS = 300;

export default definePlugin({
	name: "telegraph-renderer",
	description:
		"Publishes long responses to Telegraph Instant View for better readability",
	priority: 50,

	configSchema: z.object({
		threshold: z.number().default(2500),
	}),

	responseRenderer: async (
		events: AsyncIterable<QueryEvent>,
		target: ResponseTarget,
		bot: Bot<BotContext>,
	) => {
		let text = "";
		let msgId: number | undefined;
		let lastEditTime = 0;
		const threshold = 2500;

		const sendOpts = target.messageThreadId
			? { message_thread_id: target.messageThreadId }
			: {};

		async function editOrSend(content: string): Promise<void> {
			try {
				if (msgId) {
					await bot.api.editMessageText(target.chatId, msgId, content);
				} else {
					const sent = await bot.api.sendMessage(
						target.chatId,
						content,
						sendOpts,
					);
					msgId = sent.message_id;
				}
			} catch {
				// Ignore edit errors
			}
		}

		for await (const event of events) {
			if (event.type !== "text_delta") continue;
			text += event.delta;

			if (text.length <= threshold) {
				const now = Date.now();
				if (now - lastEditTime >= EDIT_DEBOUNCE_MS) {
					await editOrSend(text);
					lastEditTime = now;
				}
			}
		}

		if (text.length > threshold) {
			const account = await getOrCreateAccount();
			const page = await createPage(account, "Claude Response", text);
			const link = page.url;
			if (msgId) {
				await bot.api.editMessageText(target.chatId, msgId, link);
			} else {
				await bot.api.sendMessage(target.chatId, link, sendOpts);
			}
		} else if (text) {
			await editOrSend(text);
		}
	},
});
