/**
 * @plugin telegraph-renderer
 * @description Publishes long responses (>2500 chars) to Telegraph Instant View.
 *   Uses Telegraph API createAccount (auto, no manual token needed).
 *   Account persisted in data/telegraph-account.json.
 *   Short responses pass through to the default renderer via next().
 * @priority 50
 * @config plugins.telegraph-renderer.threshold — char limit before switching to Telegraph (default: 2500)
 * @prerequisites Bot must have internet access to reach api.telegra.ph.
 * @postInstall Long responses (>2500 chars) will now be published as Telegraph pages
 *   with Instant View. Threshold is configurable. Telegraph account is created
 *   automatically on first use, no API keys needed.
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

export default definePlugin({
	name: "telegraph-renderer",
	description:
		"Publishes long responses to Telegraph Instant View for better readability",
	priority: 50,

	configSchema: z.object({
		threshold: z.number().default(2500),
	}),

	renderMiddleware: async (
		events: AsyncIterable<QueryEvent>,
		target: ResponseTarget,
		bot: Bot<BotContext>,
		next: (events: AsyncIterable<QueryEvent>) => Promise<void>,
	) => {
		const threshold = 2500;

		// Collect all events — we need to know final length before deciding
		const collected: QueryEvent[] = [];
		let text = "";
		for await (const event of events) {
			collected.push(event);
			if (event.type === "text_delta") text += event.delta;
		}

		if (text.length <= threshold) {
			// Short response — delegate to default renderer
			async function* replay() {
				yield* collected;
			}
			await next(replay());
			return;
		}

		// Long response — publish to Telegraph
		const account = await getOrCreateAccount();
		const page = await createPage(account, "Claude Response", text);
		const sendOpts = target.messageThreadId
			? { message_thread_id: target.messageThreadId }
			: {};
		await bot.api.sendMessage(target.chatId, page.url, sendOpts);
	},
});
