/**
 * @plugin telegraph
 * @description Adds a tool for publishing markdown content to Telegraph Instant View.
 *   The model decides when to use Telegraph (long responses, rich formatting, etc.).
 *   Uses Telegraph API createAccount (auto, no manual token needed).
 *   Account persisted in data/telegraph-account.json.
 * @prerequisites Bot must have internet access to reach api.telegra.ph.
 * @postInstall The model now has a `publish_telegraph` tool to create Telegraph
 *   Instant View pages from markdown. It will use it for long or richly
 *   formatted responses. Telegraph account is created automatically on first use.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@core/plugin-api.ts";
import { z } from "zod";

const TELEGRAPH_API = "https://api.telegra.ph";
const ACCOUNT_FILE = join(process.cwd(), "data", "telegraph-account.json");

interface TelegraphAccount {
	access_token: string;
	short_name: string;
}

export async function getOrCreateAccount(): Promise<TelegraphAccount> {
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

export type TNode =
	| string
	| { tag: string; attrs?: Record<string, string>; children?: TNode[] };

/**
 * Known video/embed platforms — converted to Telegraph /embed/ iframe format.
 * Note: only the /embed/{platform}?url=... format works (not direct embed URLs).
 */
const EMBED_PATTERNS: Record<string, RegExp> = {
	youtube:
		/^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]+).*/,
	twitter:
		/(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/([a-zA-Z0-9_]*\/)*status\/(\d+)[?]?.*/,
	telegram:
		/^(https?):\/\/(t\.me|telegram\.me|telegram\.dog)\/([a-zA-Z0-9_]+)\/(\d+)/,
	vimeo:
		/(https?:\/\/)?(www\.)?(player\.)?vimeo\.com\/([a-z]*\/)*(\d{6,11})[?]?.*/,
};

function toEmbedUrl(url: string): string | null {
	for (const site in EMBED_PATTERNS) {
		if (EMBED_PATTERNS[site].test(url)) {
			return `/embed/${site}?url=${encodeURIComponent(url)}`;
		}
	}
	return null;
}

/** Parse inline markdown: bold+italic, bold, italic, strikethrough, code, links, images */
export function parseInline(text: string): TNode[] {
	const nodes: TNode[] = [];
	let remaining = text;

	const patterns: Array<{
		regex: RegExp;
		handler: (m: RegExpMatchArray) => TNode;
	}> = [
		// Images: ![alt](url)
		{
			regex: /!\[([^\]]*)\]\(([^)]+)\)/,
			handler: (m) => {
				const children: TNode[] = [{ tag: "img", attrs: { src: m[2] } }];
				if (m[1]) children.push({ tag: "figcaption", children: [m[1]] });
				return { tag: "figure", children };
			},
		},
		// Links: [text](url) — with embed detection
		{
			regex: /\[([^\]]+)\]\(([^)]+)\)/,
			handler: (m) => {
				const embedUrl = toEmbedUrl(m[2]);
				if (embedUrl) {
					return {
						tag: "figure",
						children: [{ tag: "iframe", attrs: { src: embedUrl } }],
					};
				}
				return {
					tag: "a",
					attrs: { href: m[2] },
					children: parseInline(m[1]),
				};
			},
		},
		// Bold + Italic: ***text***
		{
			regex: /\*\*\*(.+?)\*\*\*/,
			handler: (m) => ({
				tag: "strong",
				children: [{ tag: "em", children: parseInline(m[1]) }],
			}),
		},
		// Bold: **text** or __text__
		{
			regex: /\*\*(.+?)\*\*/,
			handler: (m) => ({ tag: "strong", children: parseInline(m[1]) }),
		},
		{
			regex: /__(.+?)__/,
			handler: (m) => ({ tag: "strong", children: parseInline(m[1]) }),
		},
		// Italic: *text* or _text_ (not inside words for _)
		{
			regex: /\*(.+?)\*/,
			handler: (m) => ({ tag: "em", children: parseInline(m[1]) }),
		},
		{
			regex: /(?<!\w)_(.+?)_(?!\w)/,
			handler: (m) => ({ tag: "em", children: parseInline(m[1]) }),
		},
		// Strikethrough: ~~text~~
		{
			regex: /~~(.+?)~~/,
			handler: (m) => ({ tag: "s", children: parseInline(m[1]) }),
		},
		// Inline code: `code` — no recursion, content is literal
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
export function textToNodes(text: string): TNode[] {
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

		// Headers (h5/h6 mapped to h4, h1/h2 mapped to h3 — Telegraph only supports h3/h4)
		if (line.startsWith("###### ")) {
			flushAll();
			nodes.push({ tag: "h4", children: parseInline(line.slice(7)) });
			continue;
		}
		if (line.startsWith("##### ")) {
			flushAll();
			nodes.push({ tag: "h4", children: parseInline(line.slice(6)) });
			continue;
		}
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

		// Bare embed URL on its own line (YouTube, Twitter, Telegram, Vimeo)
		const bareUrlMatch = line.match(/^\s*(https?:\/\/[^\s]+)\s*$/);
		if (bareUrlMatch) {
			const url = bareUrlMatch[1];
			const embedUrl = toEmbedUrl(url);
			if (embedUrl) {
				flushAll();
				nodes.push({
					tag: "figure",
					children: [{ tag: "iframe", attrs: { src: embedUrl } }],
				});
				continue;
			}
			// Bare image URL
			if (/\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s]*)?$/i.test(url)) {
				flushAll();
				nodes.push({
					tag: "figure",
					children: [{ tag: "img", attrs: { src: url } }],
				});
				continue;
			}
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

export async function createPage(
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
	name: "telegraph",
	description: "Publishes content to Telegraph Instant View pages",

	configSchema: z.object({}),

	tools: [
		{
			name: "publish_telegraph",
			description:
				"Publish content as a Telegraph (telegra.ph) Instant View page and return the URL. " +
				"Use for long or richly formatted responses that benefit from a clean web layout. " +
				"Input is standard markdown with full support for: " +
				"headings (# through ######), **bold**, *italic*, ~~strikethrough~~, " +
				"`inline code`, ```fenced code blocks```, ordered/unordered lists, " +
				"> blockquotes, horizontal rules (---), tables (|col|col|), " +
				"images (![alt](url) or bare image URL on its own line), " +
				"and links ([text](url)). " +
				"Video URLs from YouTube, Vimeo, Twitter/X on their own line become embedded players.",
			schema: z.object({
				title: z.string().describe("Page title (1-256 chars)"),
				markdown: z.string().describe("Markdown content for the page"),
			}),
			scope: "all",
			handler: async (input: { title: string; markdown: string }) => {
				const account = await getOrCreateAccount();
				const page = await createPage(account, input.title, input.markdown);
				return `Telegraph page created: ${page.url}`;
			},
		},
	],
});
