/**
 * Renderer toolkit — single import point for the helpers a render plugin
 * actually needs. Implementation lives here; types and markdown helpers are
 * re-exported from {@link ./plugin-api.ts} and {@link ./markdown-html.ts} so
 * plugin authors don't have to remember three paths.
 *
 * @example
 *   import {
 *     messageStream,
 *     markdownToTelegramHtml,
 *     accumulate,
 *     tee,
 *     EMPTY_RESULT,
 *   } from "@core/render-kit.ts";
 */

import { getLogger } from "@logtape/logtape";
import type { Bot } from "grammy";
import {
	markdownToTelegramHtml,
	splitTelegramHtmlChunks,
} from "./markdown-html.ts";
import type {
	BotContext,
	QueryEvent,
	RenderArtifact,
	ResponseTarget,
} from "./plugin-api.ts";

export {
	EMPTY_RESULT,
	type RenderArtifact,
	type RenderContext,
	type Renderer,
	type RenderResult,
	type TurnOutcome,
} from "./plugin-api.ts";
export { markdownToTelegramHtml, splitTelegramHtmlChunks };

const log = getLogger(["bot", "render-kit"]);

const TELEGRAM_MSG_LIMIT = 4096;
const DEFAULT_DEBOUNCE_MS = 300;

function threadOpts(target: ResponseTarget): { message_thread_id?: number } {
	return target.messageThreadId
		? { message_thread_id: target.messageThreadId }
		: {};
}

/**
 * Send `html` as a Telegram message. On parse error, retries with HTML stripped
 * (plain text). Auto-attaches `chat_id` and `message_thread_id` from `target`.
 *
 * Returns the sent message_id. Does NOT chunk — pass HTML under 4096 chars,
 * or use `messageStream` for growing buffers that may exceed the limit.
 */
export async function sendTelegramHtml(
	bot: Bot<BotContext>,
	target: ResponseTarget,
	html: string,
): Promise<number> {
	const opts = threadOpts(target);
	try {
		const sent = await bot.api.sendMessage(target.chatId, html, {
			...opts,
			parse_mode: "HTML",
		});
		return sent.message_id;
	} catch {
		const sent = await bot.api.sendMessage(
			target.chatId,
			html.replace(/<[^>]+>/g, ""),
			opts,
		);
		return sent.message_id;
	}
}

/**
 * Edit a Telegram message to `html`. Tolerates "message is not modified".
 * On parse error, retries with HTML stripped.
 *
 * Returns true if the edit reached Telegram (or was a no-op no-modification),
 * false if both HTML and plain attempts failed.
 */
export async function editTelegramHtml(
	bot: Bot<BotContext>,
	target: ResponseTarget,
	messageId: number,
	html: string,
): Promise<boolean> {
	try {
		await bot.api.editMessageText(target.chatId, messageId, html, {
			parse_mode: "HTML",
		});
		return true;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("message is not modified")) return true;
		try {
			await bot.api.editMessageText(
				target.chatId,
				messageId,
				html.replace(/<[^>]+>/g, ""),
			);
			return true;
		} catch (e2) {
			log.error("editTelegramHtml failed: {error}", {
				error: e2 instanceof Error ? e2.message : String(e2),
			});
			return false;
		}
	}
}

/**
 * Stateful editor for a logical Telegram message that may grow past 4096 chars
 * (chunked into N physical messages). Debounces edits — safe to call `set()` on
 * every `text_delta`. Reconciles via `editMessageText` for chunks already sent,
 * and `sendMessage` for new tail chunks.
 *
 * One instance per logical message: build separately for the answer body, the
 * tool trace overlay, the thinking display.
 *
 * Pass `role` + `kind` to tag what the stream's messages represent — they're
 * filled into the {@link RenderArtifact}s returned by `artifacts()`. Omit
 * both for ephemeral streams that delete themselves and surface no artifacts.
 *
 * @example terminal text renderer
 *   const stream = messageStream(ctx.bot, ctx.target, { role: "body", kind: "primary" });
 *   let text = "";
 *   for await (const e of events) {
 *     if (e.type === "text_delta") {
 *       text += e.delta;
 *       stream.set(markdownToTelegramHtml(text));
 *     } else if (e.type === "complete") {
 *       if (e.text !== text) text = e.text;
 *       stream.set(markdownToTelegramHtml(text));
 *     }
 *   }
 *   await stream.flush();
 *
 * @example ephemeral overlay
 *   const overlay = messageStream(ctx.bot, ctx.target);
 *   for await (const e of events) {
 *     if (e.type === "tool_start") overlay.set(buildTraceHtml(...));
 *   }
 *   await overlay.delete();
 */
export function messageStream(
	bot: Bot<BotContext>,
	target: ResponseTarget,
	opts: {
		/** Default 300ms. Set to 0 to flush synchronously on every `set`. */
		debounceMs?: number;
		/** Override chunking strategy. Default splits at 4096 char boundaries. */
		chunk?: (html: string) => string[];
		/** Role to tag every artifact with. Default `"body"`. */
		role?: RenderArtifact["role"];
		/** Default `"primary"`. Use `"decoration"` for transient overlays. */
		kind?: RenderArtifact["kind"];
	} = {},
): MessageStream {
	const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const chunk =
		opts.chunk ?? ((html) => splitTelegramHtmlChunks(html, TELEGRAM_MSG_LIMIT));
	const role: RenderArtifact["role"] = opts.role ?? "body";
	const kind: RenderArtifact["kind"] = opts.kind ?? "primary";

	const sentIds: number[] = [];
	let pendingHtml: string | null = null;
	let lastWrittenHtml = "";
	let timer: ReturnType<typeof setTimeout> | null = null;
	let writing: Promise<void> | null = null;

	async function write(html: string): Promise<void> {
		if (html === lastWrittenHtml) return;
		const chunks = chunk(html);
		for (let i = 0; i < chunks.length; i++) {
			const piece = chunks[i];
			if (!piece) continue;
			if (i < sentIds.length) {
				await editTelegramHtml(bot, target, sentIds[i] as number, piece);
			} else {
				const id = await sendTelegramHtml(bot, target, piece);
				sentIds.push(id);
			}
		}
		lastWrittenHtml = html;
	}

	async function flushNow(): Promise<void> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		// Serialize: never run two writes concurrently — would race on chunk index.
		while (writing) await writing;
		if (pendingHtml === null) return;
		const html = pendingHtml;
		pendingHtml = null;
		writing = write(html);
		try {
			await writing;
		} finally {
			writing = null;
		}
	}

	function schedule(): void {
		if (debounceMs === 0) {
			void flushNow();
			return;
		}
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			void flushNow();
		}, debounceMs);
	}

	return {
		set(html: string): void {
			pendingHtml = html;
			schedule();
		},
		flush: flushNow,
		async delete(): Promise<void> {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			pendingHtml = null;
			while (writing) await writing;
			for (const id of sentIds) {
				try {
					await bot.api.deleteMessage(target.chatId, id);
				} catch {}
			}
			sentIds.length = 0;
			lastWrittenHtml = "";
		},
		artifacts(): RenderArtifact[] {
			return sentIds.map((id) => ({ messageId: id, role, kind }));
		},
	};
}

export interface MessageStream {
	/** Replace the rendered text. Schedules a debounced write; cheap on hot loops. */
	set(html: string): void;
	/** Force-write any pending edit immediately. Call before exiting the renderer. */
	flush(): Promise<void>;
	/** Delete every chunk message produced. For ephemeral overlays. */
	delete(): Promise<void>;
	/**
	 * Snapshot of `RenderArtifact[]` for the messages currently sent — pass
	 * to `RenderResult.artifacts.body` (or whatever role) when returning from
	 * a renderer. Live snapshot; call after `flush()` for the final state.
	 */
	artifacts(): RenderArtifact[];
}

/**
 * Pass-through async iterable that accumulates assistant text across blocks.
 * Returns the forwarded events plus a `getText()` that returns the latest
 * reconciled value: deltas concatenated, successive text blocks joined with
 * `"\n\n"`, replaced by `complete.text` on terminal.
 *
 * Cuts the recurring "track block boundaries + accumulate deltas" dance every
 * text-body renderer would otherwise write. The default renderer is one
 * `for await` away from this helper.
 *
 * @example
 *   const { events: evs, getText } = accumulate(events);
 *   for await (const e of evs) {
 *     if (e.type === "text_delta" || e.type === "complete")
 *       stream.set(markdownToTelegramHtml(getText()));
 *   }
 */
export function accumulate(source: AsyncIterable<QueryEvent>): {
	events: AsyncIterable<QueryEvent>;
	getText: () => string;
} {
	let text = "";
	let textBlocks = 0;
	async function* forward(): AsyncIterable<QueryEvent> {
		for await (const e of source) {
			if (e.type === "text_start") {
				if (textBlocks++ > 0) text += "\n\n";
			} else if (e.type === "text_delta") {
				text += e.delta;
			} else if (
				e.type === "complete" ||
				e.type === "aborted" ||
				e.type === "error"
			) {
				if (e.text && e.text !== text) text = e.text;
			}
			yield e;
		}
	}
	return { events: forward(), getText: () => text };
}

/**
 * Pass-through async iterable that drops events failing `pred`.
 * Common use: `filter(events, e => e.type !== "thinking_delta")`.
 */
export async function* filter<T>(
	source: AsyncIterable<T>,
	pred: (e: T) => boolean,
): AsyncIterable<T> {
	for await (const e of source) if (pred(e)) yield e;
}

/**
 * Pass-through async iterable that transforms each event.
 * Use when you need to rewrite event payloads (e.g., redact tool input)
 * without changing the kind of events downstream sees.
 */
export async function* map<T, U>(
	source: AsyncIterable<T>,
	fn: (e: T) => U,
): AsyncIterable<U> {
	for await (const e of source) yield fn(e);
}

/**
 * Split an async iterable into N independent consumers.
 *
 * Each branch yields the full sequence at its own pace. The slowest consumer
 * applies backpressure on the source via a shared queue. Errors propagate to
 * all branches.
 *
 * Use when a renderer wants to show its own UI *and* defer to the next
 * renderer in the chain (so it must hand `next` an unconsumed iterable).
 *
 * @example
 *   const [forTrace, forNext] = tee(events);
 *   const trace = renderTrace(forTrace, ctx);
 *   await next(forNext);
 *   await trace;
 */
export function tee<T>(
	source: AsyncIterable<T>,
): [AsyncIterable<T>, AsyncIterable<T>];
export function tee<T>(
	source: AsyncIterable<T>,
	n: 2,
): [AsyncIterable<T>, AsyncIterable<T>];
export function tee<T>(
	source: AsyncIterable<T>,
	n: 3,
): [AsyncIterable<T>, AsyncIterable<T>, AsyncIterable<T>];
export function tee<T>(
	source: AsyncIterable<T>,
	n: 4,
): [AsyncIterable<T>, AsyncIterable<T>, AsyncIterable<T>, AsyncIterable<T>];
export function tee<T>(source: AsyncIterable<T>, n: number): AsyncIterable<T>[];
export function tee<T>(source: AsyncIterable<T>, n = 2): AsyncIterable<T>[] {
	const queues: Array<Array<IteratorResult<T>>> = Array.from(
		{ length: n },
		() => [],
	);
	const wakers: Array<(() => void) | null> = Array(n).fill(null);
	let pumping = false;
	let pumpError: unknown = null;

	async function pump(): Promise<void> {
		if (pumping) return;
		pumping = true;
		try {
			for await (const value of source) {
				const result: IteratorResult<T> = { value, done: false };
				for (let i = 0; i < n; i++) {
					queues[i]?.push(result);
					const waker = wakers[i];
					if (waker) {
						wakers[i] = null;
						waker();
					}
				}
			}
		} catch (e) {
			pumpError = e;
		} finally {
			const done: IteratorResult<T> = { value: undefined, done: true };
			for (let i = 0; i < n; i++) {
				queues[i]?.push(done);
				const waker = wakers[i];
				if (waker) {
					wakers[i] = null;
					waker();
				}
			}
		}
	}

	function makeBranch(idx: number): AsyncIterable<T> {
		return {
			[Symbol.asyncIterator](): AsyncIterator<T> {
				if (!pumping) pump();
				return {
					async next(): Promise<IteratorResult<T>> {
						const queue = queues[idx];
						if (!queue) return { value: undefined, done: true };
						while (queue.length === 0) {
							if (pumpError) throw pumpError;
							await new Promise<void>((resolve) => {
								wakers[idx] = resolve;
							});
						}
						return queue.shift() as IteratorResult<T>;
					},
				};
			},
		};
	}

	return Array.from({ length: n }, (_, i) => makeBranch(i));
}
