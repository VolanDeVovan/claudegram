import { markdownToTelegramHtml } from "./markdown-html.ts";
import type { QueryEvent, RenderContext, RenderResult } from "./plugin-api.ts";
import { messageStream } from "./render-kit.ts";

/**
 * Default tail renderer. Live-edits one growing message via `messageStream`.
 * Reconciles against `complete.text` / `aborted.text` / `error.text` (those
 * are authoritative; the streamed deltas are a preview).
 *
 * Tags artifacts as `role: "body"`, `kind: "primary"` so decorators higher
 * in the chain can find them via `result.artifacts.findLast(m => m.role === "body")`.
 */
export async function defaultRenderer(
	events: AsyncIterable<QueryEvent>,
	ctx: RenderContext,
): Promise<RenderResult> {
	const stream = messageStream(ctx.bot, ctx.target, {
		role: "body",
		kind: "primary",
	});
	let text = "";
	let textBlocks = 0;

	for await (const event of events) {
		if (event.type === "text_start") {
			// Successive text blocks (text → tool → more text) are joined into
			// a single growing message. First block: no separator.
			if (textBlocks++ > 0) text += "\n\n";
		} else if (event.type === "text_delta") {
			text += event.delta;
			stream.set(markdownToTelegramHtml(text));
		} else if (event.type === "complete" || event.type === "aborted") {
			if (event.text && event.text !== text) text = event.text;
			stream.set(markdownToTelegramHtml(text));
		} else if (event.type === "error") {
			if (event.text && event.text !== text) text = event.text;
			text = text ? `${text}\n\n⚠️ ${event.message}` : `⚠️ ${event.message}`;
			stream.set(markdownToTelegramHtml(text));
		}
	}

	await stream.flush();
	return { artifacts: stream.artifacts() };
}
