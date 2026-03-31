import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getLogger } from "@logtape/logtape";

const log = getLogger(["bot", "message-channel"]);

/**
 * Pushable async iterable that bridges Telegram message handlers
 * and the Claude Agent SDK's streaming input mode.
 *
 * The SDK's `query()` accepts `AsyncIterable<SDKUserMessage>` as prompt.
 * This channel lets us yield the initial message, then inject follow-up
 * messages between agent turns as they arrive from Telegram.
 *
 * Iterator behavior:
 * - Yields immediately from queue if non-empty
 * - When queue is empty, blocks until a new message is pushed or channel is closed
 * - Must be explicitly closed via `close()` / `flush()` when the agent query ends
 */
export class MessageChannel implements AsyncIterable<SDKUserMessage> {
	private queue: SDKUserMessage[] = [];
	private waiter: (() => void) | null = null;
	private _closed = false;

	get closed(): boolean {
		return this._closed;
	}

	get pending(): number {
		return this.queue.length;
	}

	/**
	 * Push a user message into the channel.
	 * Returns false if the channel is already closed.
	 */
	push(text: string): boolean {
		if (this._closed) return false;

		const msg: SDKUserMessage = {
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
		};

		this.queue.push(msg);
		log.debug("Message pushed, queue size: {size}", {
			size: this.queue.length,
		});

		// Wake up the iterator if it's waiting
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = null;
			resolve();
		}

		return true;
	}

	/** Force-close the channel (no more messages will be yielded). */
	close(): void {
		this._closed = true;
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = null;
			resolve();
		}
	}

	/** Clear the queue and close the channel (for /cancel). */
	flush(): void {
		this.queue.length = 0;
		this.close();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
		while (true) {
			// Yield all currently queued messages
			while (this.queue.length > 0) {
				const msg = this.queue.shift();
				if (msg) yield msg;
			}

			// If closed, stop
			if (this._closed) return;

			// Wait for next push() or close()
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
	}
}
