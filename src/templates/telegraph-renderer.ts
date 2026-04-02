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

type TNode =
	| string
	| { tag: string; attrs?: Record<string, string>; children?: TNode[] };

/** Parse inline markdown: bold+italic, bold, italic, strikethrough, code, links */
function parseInline(text: string): TNode[] {
	const nodes: TNode[] = [];
	let remaining = text;

	const patterns: Array<{
		regex: RegExp;
		handler: (m: RegExpMatchArray) => TNode;
	}> = [
		// Links: [text](url)
		{
			regex: /\[([^\]]+)\]\(([^)]+)\)/,
			handler: (m) => ({ tag: "a", attrs: { href: m[2] }, children: [m[1]] }),
		},
		// Bold + Italic: ***text***
		{
			regex: /\*\*\*(.+?)\*\*\*/,
			handler: (m) => ({
				tag: "strong",
				children: [{ tag: "em", children: [m[1]] }],
			}),
		},
		// Bold: **text** or __text__
		{
			regex: /\*\*(.+?)\*\*/,
			handler: (m) => ({ tag: "strong", children: [m[1]] }),
		},
		{
			regex: /__(.+?)__/,
			handler: (m) => ({ tag: "strong", children: [m[1]] }),
		},
		// Italic: *text* or _text_ (not inside words for _)
		{
			regex: /\*(.+?)\*/,
			handler: (m) => ({ tag: "em", children: [m[1]] }),
		},
		{
			regex: /(?<!\w)_(.+?)_(?!\w)/,
			handler: (m) => ({ tag: "em", children: [m[1]] }),
		},
		// Strikethrough: ~~text~~
		{
			regex: /~~(.+?)~~/,
			handler: (m) => ({ tag: "s", children: [m[1]] }),
		},
		// Inline code: `code`
		{
			regex: /`([^`]+)`/,
			handler: (m) => ({ tag: "code", children: [m[1]] }),
		},
	];

	while (remaining.length > 0) {
		let earliest: {
			index: number;
			length: number;
			node: TNode;
		} | null = null;

		for (const pattern of patterns) {
			const match = remaining.match(pattern.regex);
			if (match?.index !== undefined) {
				if (!earliest || match.index < earliest.index) {
					earliest = {
						index: match.index,
						length: match[0].length,
						node: pattern.handler(match),
					};
				}
			}
		}

		if (earliest) {
			if (earliest.index > 0) {
				nodes.push(remaining.slice(0, earliest.index));
			}
			nodes.push(earliest.node);
			remaining = remaining.slice(earliest.index + earliest.length);
		} else {
			nodes.push(remaining);
			break;
		}
	}

	return nodes;
}

/** Parse markdown text into Telegraph-compatible node tree */
function textToNodes(text: string): TNode[] {
	const nodes: TNode[] = [];
	const lines = text.split("\n");
	let inCodeBlock = false;
	let codeBlockContent = "";
	let inList: "ul" | "ol" | null = null;
	let listItems: TNode[] = [];
	let pendingParagraphLines: string[] = [];
	let tableHeaders: string[] = [];

	const flushParagraph = () => {
		if (pendingParagraphLines.length === 0) return;
		const children: TNode[] = [];
		for (let j = 0; j < pendingParagraphLines.length; j++) {
			if (j > 0) children.push({ tag: "br" });
			children.push(...parseInline(pendingParagraphLines[j]));
		}
		nodes.push({ tag: "p", children });
		pendingParagraphLines = [];
	};

	const flushList = () => {
		if (inList && listItems.length > 0) {
			nodes.push({ tag: inList, children: listItems });
			listItems = [];
			inList = null;
		}
	};

	const flushAll = () => {
		flushParagraph();
		flushList();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Code block handling
		if (line.startsWith("```")) {
			flushAll();
			if (inCodeBlock) {
				nodes.push({
					tag: "pre",
					children: [codeBlockContent.trimEnd()],
				});
				inCodeBlock = false;
				codeBlockContent = "";
			} else {
				inCodeBlock = true;
			}
			continue;
		}

		if (inCodeBlock) {
			codeBlockContent += `${line}\n`;
			continue;
		}

		// Empty line — paragraph break
		if (line.trim() === "") {
			flushAll();
			continue;
		}

		// Horizontal rule
		if (/^[-*_]{3,}\s*$/.test(line)) {
			flushAll();
			nodes.push({ tag: "hr" });
			continue;
		}

		// Headers
		if (line.startsWith("#### ")) {
			flushAll();
			nodes.push({ tag: "h4", children: parseInline(line.slice(5)) });
			continue;
		}
		if (line.startsWith("### ")) {
			flushAll();
			nodes.push({ tag: "h4", children: parseInline(line.slice(4)) });
			continue;
		}
		if (line.startsWith("## ")) {
			flushAll();
			nodes.push({ tag: "h3", children: parseInline(line.slice(3)) });
			continue;
		}
		if (line.startsWith("# ")) {
			flushAll();
			nodes.push({ tag: "h3", children: parseInline(line.slice(2)) });
			continue;
		}

		// Unordered list items
		if (/^\s*[-*+]\s+/.test(line)) {
			flushParagraph();
			if (inList !== "ul") {
				flushList();
				inList = "ul";
			}
			const content = line.replace(/^\s*[-*+]\s+/, "");
			listItems.push({ tag: "li", children: parseInline(content) });
			continue;
		}

		// Ordered list items
		const orderedMatch = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
		if (orderedMatch) {
			flushParagraph();
			if (inList !== "ol") {
				flushList();
				inList = "ol";
			}
			listItems.push({ tag: "li", children: parseInline(orderedMatch[2]) });
			continue;
		}

		// Blockquote
		if (line.startsWith("> ")) {
			flushAll();
			nodes.push({
				tag: "blockquote",
				children: parseInline(line.slice(2)),
			});
			continue;
		}

		// Table handling — header as bold, data rows with labels
		if (line.includes("|") && line.trim().startsWith("|")) {
			flushAll();
			const cells = line
				.split("|")
				.filter((c) => c.trim())
				.map((c) => c.trim());

			// Skip separator rows
			if (cells.length > 0 && cells.every((c) => /^[-:]+$/.test(c))) {
				continue;
			}

			// Detect header row: next line is a separator
			const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
			const nextCells = nextLine
				.split("|")
				.filter((c) => c.trim())
				.map((c) => c.trim());
			const isHeader =
				nextCells.length > 0 && nextCells.every((c) => /^[-:]+$/.test(c));

			if (isHeader && cells.length > 0) {
				tableHeaders = cells;
				nodes.push({
					tag: "p",
					children: [{ tag: "strong", children: [cells.join("  ·  ")] }],
				});
				continue;
			}

			// Data row — use stored headers for labeled output
			if (tableHeaders.length > 0 && cells.length > 0) {
				const parts: TNode[] = [];
				for (let ci = 0; ci < cells.length; ci++) {
					if (ci > 0) parts.push("  |  ");
					if (tableHeaders[ci]) {
						parts.push({
							tag: "strong",
							children: [`${tableHeaders[ci]}: `],
						});
					}
					parts.push(cells[ci]);
				}
				nodes.push({ tag: "p", children: parts });
			} else if (cells.length > 0) {
				nodes.push({ tag: "p", children: [cells.join("  |  ")] });
			}
			continue;
		}

		// Regular text line — accumulate into pending paragraph
		flushList();
		pendingParagraphLines.push(line);
	}

	// Flush remaining content
	flushAll();

	// Close unclosed code block
	if (inCodeBlock && codeBlockContent) {
		nodes.push({
			tag: "pre",
			children: [codeBlockContent.trimEnd()],
		});
	}

	return nodes;
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
