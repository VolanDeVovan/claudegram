/**
 * Convert Claude's markdown output to Telegram-compatible HTML.
 *
 * Telegram supports: <b>, <i>, <code>, <pre>, <a href>, <s>, <blockquote>.
 *
 * Pipeline:
 * 1. Extract fenced code blocks → placeholders
 * 2. Extract inline code → placeholders
 * 3. HTML-escape remaining text
 * 4. Convert bold (**text** / __text__)
 * 5. Convert italic (*text*, _text_ with word boundaries)
 * 6. Convert links [text](url)
 * 7. Convert headers (# Header → <b>Header</b>)
 * 8. Convert strikethrough (~~text~~)
 * 9. Convert blockquotes (> text)
 * 10. Restore placeholders
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(text: string): string {
	const placeholders: [string, string][] = [];
	let counter = 0;

	function ph(html: string): string {
		const key = `\x00PH${counter}\x00`;
		counter++;
		placeholders.push([key, html]);
		return key;
	}

	// 1. Fenced code blocks
	let result = text.replace(
		/```(\w+)?\n([\s\S]*?)```/g,
		(_, lang: string | undefined, code: string) => {
			const escaped = escapeHtml(code.replace(/\n$/, ""));
			const html = lang
				? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
				: `<pre><code>${escaped}</code></pre>`;
			return ph(html);
		},
	);

	// 2. Inline code
	result = result.replace(/`([^`\n]+)`/g, (_, code: string) => {
		return ph(`<code>${escapeHtml(code)}</code>`);
	});

	// 3. HTML-escape remaining text
	result = escapeHtml(result);

	// 4. Bold: **text** or __text__ (must come before italic)
	result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
	result = result.replace(/__(.+?)__/gs, "<b>$1</b>");

	// 5. Italic: *text* (not preceded/followed by word char)
	//    _text_ (word boundaries)
	result = result.replace(/(?<!\w)\*(\S(?:.*?\S)?)\*(?!\w)/g, "<i>$1</i>");
	result = result.replace(/(?<!\w)_(\S(?:.*?\S)?)_(?!\w)/g, "<i>$1</i>");

	// 6. Links: [text](url)
	result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	// 7. Headers: # Header → <b>Header</b>
	result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

	// 8. Strikethrough: ~~text~~
	result = result.replace(/~~(.+?)~~/gs, "<s>$1</s>");

	// 9. Blockquotes: > text (consecutive lines merged)
	result = result.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
		const lines = match
			.split("\n")
			.filter((l) => l.startsWith("&gt;"))
			.map((l) => l.replace(/^&gt;\s?/, ""));
		return `<blockquote>${lines.join("\n")}</blockquote>\n`;
	});

	// 10. Restore placeholders
	for (const [key, html] of placeholders) {
		result = result.replace(key, html);
	}

	return result.trim();
}

// ── HTML-aware chunking (inspired by OpenClaw) ──

const HTML_TAG_RE = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/g;

interface OpenTag {
	name: string;
	openTag: string;
	closeTag: string;
}

/** Find safe split point that doesn't break HTML entities (&amp; etc). */
function safeSplitIndex(text: string, maxLen: number): number {
	if (text.length <= maxLen) return text.length;
	const max = Math.max(1, Math.floor(maxLen));
	const lastAmp = text.lastIndexOf("&", max - 1);
	if (lastAmp === -1) return max;
	const lastSemi = text.lastIndexOf(";", max - 1);
	if (lastAmp < lastSemi) return max;
	// Check if there's an unclosed entity
	const semi = text.indexOf(";", lastAmp);
	if (semi === -1 || semi >= max) return lastAmp;
	return max;
}

function closeSuffix(tags: OpenTag[]): string {
	return tags
		.slice()
		.reverse()
		.map((t) => t.closeTag)
		.join("");
}

function closeSuffixLen(tags: OpenTag[]): number {
	return tags.reduce((sum, t) => sum + t.closeTag.length, 0);
}

function openPrefix(tags: OpenTag[]): string {
	return tags.map((t) => t.openTag).join("");
}

function popTag(tags: OpenTag[], name: string): void {
	for (let i = tags.length - 1; i >= 0; i--) {
		if (tags[i]?.name === name) {
			tags.splice(i, 1);
			return;
		}
	}
}

/**
 * Split HTML into chunks that respect tag nesting and entity boundaries.
 * Each chunk is valid HTML — unclosed tags are properly closed/reopened.
 */
export function splitTelegramHtmlChunks(html: string, limit: number): string[] {
	if (!html) return [];
	const max = Math.max(1, Math.floor(limit));
	if (html.length <= max) return [html];

	const chunks: string[] = [];
	const openTags: OpenTag[] = [];
	let current = "";
	let hasPayload = false;

	const reset = () => {
		current = openPrefix(openTags);
		hasPayload = false;
	};

	const flush = () => {
		if (!hasPayload) return;
		chunks.push(`${current}${closeSuffix(openTags)}`);
		reset();
	};

	const appendText = (segment: string) => {
		let remaining = segment;
		while (remaining.length > 0) {
			const available = max - current.length - closeSuffixLen(openTags);
			if (available <= 0) {
				if (!hasPayload) break;
				flush();
				continue;
			}
			if (remaining.length <= available) {
				current += remaining;
				hasPayload = true;
				break;
			}
			const splitAt = safeSplitIndex(remaining, available);
			if (splitAt <= 0) {
				if (!hasPayload) break;
				flush();
				continue;
			}
			current += remaining.slice(0, splitAt);
			hasPayload = true;
			remaining = remaining.slice(splitAt);
			flush();
		}
	};

	reset();
	HTML_TAG_RE.lastIndex = 0;
	let lastIndex = 0;
	for (
		let match = HTML_TAG_RE.exec(html);
		match !== null;
		match = HTML_TAG_RE.exec(html)
	) {
		const tagStart = match.index;
		const tagEnd = HTML_TAG_RE.lastIndex;

		appendText(html.slice(lastIndex, tagStart));

		const rawTag = match[0];
		const isClosing = match[1] === "</";
		const tagName = (match[2] ?? "").toLowerCase();

		if (!isClosing) {
			const nextCloseLen = `</${tagName}>`.length;
			if (
				hasPayload &&
				current.length +
					rawTag.length +
					closeSuffixLen(openTags) +
					nextCloseLen >
					max
			) {
				flush();
			}
		}

		current += rawTag;
		if (isClosing) {
			popTag(openTags, tagName);
		} else {
			openTags.push({
				name: tagName,
				openTag: rawTag,
				closeTag: `</${tagName}>`,
			});
		}
		lastIndex = tagEnd;
	}

	appendText(html.slice(lastIndex));
	flush();

	return chunks.length > 0 ? chunks : [html];
}
