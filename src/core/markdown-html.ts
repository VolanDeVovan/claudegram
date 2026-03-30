/**
 * Convert Claude's markdown output to Telegram-compatible HTML.
 *
 * Telegram supports: <b>, <i>, <code>, <pre>, <a href>, <s>, <u>.
 *
 * Order of operations:
 * 1. Extract fenced code blocks → placeholders
 * 2. Extract inline code → placeholders
 * 3. HTML-escape remaining text
 * 4. Convert bold (**text** / __text__)
 * 5. Convert italic (*text*, _text_ with word boundaries)
 * 6. Convert links [text](url)
 * 7. Convert headers (# Header → <b>Header</b>)
 * 8. Convert strikethrough (~~text~~)
 * 9. Restore placeholders
 */

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(text: string): string {
	const placeholders: [string, string][] = [];
	let counter = 0;

	function makePlaceholder(html: string): string {
		const key = `\x00PH${counter}\x00`;
		counter++;
		placeholders.push([key, html]);
		return key;
	}

	// 1. Fenced code blocks
	let result = text.replace(
		/```(\w+)?\n([\s\S]*?)```/g,
		(_, lang: string | undefined, code: string) => {
			const escaped = escapeHtml(code);
			const html = lang
				? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
				: `<pre><code>${escaped}</code></pre>`;
			return makePlaceholder(html);
		},
	);

	// 2. Inline code
	result = result.replace(/`([^`\n]+)`/g, (_, code: string) => {
		return makePlaceholder(`<code>${escapeHtml(code)}</code>`);
	});

	// 3. HTML-escape remaining text
	result = escapeHtml(result);

	// 4. Bold: **text** or __text__
	result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	result = result.replace(/__(.+?)__/g, "<b>$1</b>");

	// 5. Italic: *text* (non-space around), _text_ (word boundaries)
	result = result.replace(/\*(\S.*?\S|\S)\*/g, "<i>$1</i>");
	result = result.replace(/(?<!\w)_(\S.*?\S|\S)_(?!\w)/g, "<i>$1</i>");

	// 6. Links: [text](url)
	result = result.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		'<a href="$2">$1</a>',
	);

	// 7. Headers: # Header → <b>Header</b>
	result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

	// 8. Strikethrough: ~~text~~
	result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// 9. Restore placeholders
	for (const [key, html] of placeholders) {
		result = result.replace(key, html);
	}

	return result;
}
