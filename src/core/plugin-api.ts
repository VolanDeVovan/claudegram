import type { Bot, Context, MiddlewareFn } from "grammy";
import type { ZodType, z } from "zod";
import type { ConfigManager } from "./config.ts";
import type { MessageChannel } from "./message-channel.ts";
import type { ScopeStore } from "./scope-store.ts";

// ─── Response Target ────────────────────────────────────────────

export interface ResponseTarget {
	chatId: number;
	messageThreadId?: number;
	scope: string;
	project: string;
}

// ─── Query Events (streaming from Claude) ───────────────────────

/**
 * Token usage from the SDK. Carried on terminal events for billing/telemetry.
 * Cache fields are zero when prompt caching wasn't used.
 */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

/** Aggregate usage for a Task-tool subagent run. */
export interface TaskUsage {
	totalTokens: number;
	toolUses: number;
	durationMs: number;
}

/**
 * Streaming events from a Claude Agent SDK turn, delivered to renderers in order.
 *
 * # Lifecycle
 * Exactly one `start` is emitted first. Zero or more streaming events follow.
 * Exactly one terminal event ends the stream: `complete`, `error`, or
 * `aborted`. After a terminal event the iterable closes — no more events.
 *
 * # Event families
 * Drop everything you don't care about — the minimum a body renderer needs is
 * `text_delta` plus the terminal.
 *
 * - **Lifecycle**: `start`, `complete`, `error`, `aborted`.
 * - **Assistant content** (block-level): `text_delta`, `thinking_delta`.
 * - **Tools**: `tool_start`, `tool_progress`, `tool_end`.
 * - **Subagents** (Task tool): `task_start`, `task_progress`, `task_end`.
 * - **Telemetry**: `retry`, `rate_limit`, `compact`.
 *
 * # Deltas vs snapshots
 * `text_delta` / `thinking_delta` are strictly incremental. The kernel never
 * re-emits content; concatenation gives well-formed text.
 *
 * `complete.text` is the authoritative final text. Reconcile against it on
 * `complete` if you've been live-editing from deltas.
 *
 * # Successive blocks
 * Successive assistant text blocks (text → tool → more text) are joined by a
 * `"\n\n"` *prefix* on the next block's delta. Concatenation gives well-formed
 * text; there is no standalone separator event.
 *
 * # Tool call linking
 * `tool_start` / `tool_progress` / `tool_end` share a `callId`. `parentCallId`
 * is non-null when one tool spawned another (Task subagents).
 *
 * # Partial state on terminals
 * All three terminals carry `text`, `turns`, `costUsd`, `usage`, `stopReason`.
 * On `error`/`aborted` these are *partial* — what was accumulated up to the
 * terminal moment.
 */
export type QueryEvent =
	/** First event of every query. Use to allocate state, send typing indicator. */
	| { type: "start" }

	// ─── Assistant content (block-level) ─────────────────────────
	/** Strictly incremental — append to your buffer. Never a snapshot. */
	| { type: "text_delta"; delta: string; blockIndex: number }
	/** Reasoning text. Safe to drop entirely. */
	| { type: "thinking_delta"; delta: string; blockIndex: number }

	// ─── Tools ───────────────────────────────────────────────────
	| {
			type: "tool_start";
			callId: string;
			tool: string;
			input: unknown;
			parentCallId: string | null;
	  }
	/** Mid-call progress (Bash output stream, etc.). Optional UI. */
	| {
			type: "tool_progress";
			callId: string;
			tool: string;
			elapsedSeconds: number;
	  }
	| {
			type: "tool_end";
			callId: string;
			tool: string;
			output: string;
			isError: boolean;
	  }

	// ─── Subagents (Task tool) ───────────────────────────────────
	| {
			type: "task_start";
			taskId: string;
			description: string;
			taskType?: string;
			parentCallId: string | null;
	  }
	| {
			type: "task_progress";
			taskId: string;
			description: string;
			summary?: string;
			lastTool?: string;
			usage: TaskUsage;
	  }
	| {
			type: "task_end";
			taskId: string;
			status: "completed" | "failed" | "stopped";
			summary: string;
			outputFile?: string;
			usage: TaskUsage;
	  }

	// ─── Telemetry ───────────────────────────────────────────────
	/** SDK is retrying after a transient failure. Non-terminal. */
	| {
			type: "retry";
			attempt: number;
			maxRetries: number;
			delayMs: number;
			reason: string;
	  }
	/** Subscription-tier rate-limit telemetry. Non-terminal. */
	| {
			type: "rate_limit";
			status: "allowed" | "allowed_warning" | "rejected";
			utilization?: number;
			resetsAt?: number;
			kind?:
				| "five_hour"
				| "seven_day"
				| "seven_day_opus"
				| "seven_day_sonnet"
				| "overage";
	  }
	/** Context-compaction lifecycle. Render a "compacting context…" banner if you want. */
	| { type: "compact"; phase: "start" | "boundary" | "end" }

	// ─── Terminals ───────────────────────────────────────────────
	/** Successful terminal. `text` is authoritative; reconcile against it. */
	| {
			type: "complete";
			text: string;
			turns: number;
			costUsd: number;
			usage: TokenUsage;
			stopReason: string | null;
	  }
	/**
	 * Terminal for SDK / transport errors. Kernel has exhausted retries.
	 * Partial text/turns/cost reflect work done before the failure.
	 */
	| {
			type: "error";
			message: string;
			text: string;
			turns: number;
			costUsd: number;
			usage: TokenUsage;
			cause:
				| "transport"
				| "max_turns"
				| "max_budget"
				| "structured_output"
				| "execution"
				| "unknown";
	  }
	/** Terminal for /cancel or external abort. Partial state included. */
	| {
			type: "aborted";
			text: string;
			turns: number;
			costUsd: number;
			usage: TokenUsage;
	  };

/**
 * The terminal event of a turn. Always exactly one of these arrives at the
 * end of every {@link QueryEvent} stream; renderers can `await ctx.outcome`
 * to get it without writing a spy generator.
 */
export type TurnOutcome = Extract<
	QueryEvent,
	{ type: "complete" | "error" | "aborted" }
>;

// ─── Sessions ───────────────────────────────────────────────────

export interface SessionInfo {
	id: string;
	scope: string;
	projectName: string;
	createdAt: string;
	lastUsed: string;
	turns: number;
	costUsd: number;
	isActive: boolean;
}

/**
 * Public session operations available to plugins.
 *
 * All methods are scope-aware — pass `ctx.scope` (not `ctx.userId`) to match
 * sessions created under the current routing context.
 */
export interface SessionAPI {
	list(scope: string, projectName?: string): Promise<SessionInfo[]>;
	activate(sessionId: string): Promise<void>;
	getActive(scope: string, projectName: string): Promise<SessionInfo | null>;
	/**
	 * Add text to the pending context buffer for a (scope, project) pair.
	 * On the next user message, all pending blocks are prepended to the prompt —
	 * the agent sees them as context without the user receiving a separate message.
	 *
	 * Use this when the agent needs to know something but the user doesn't need a
	 * visible message. For visible messages, send via `bot.api.sendMessage()` and
	 * call `pushContext()` separately if the agent should also be aware.
	 *
	 * @example
	 * // Silent context — agent knows, user doesn't see a message
	 * ctx.sessions.pushContext(scope, project, "[Monitoring] CPU at 92% for 5 min");
	 *
	 * // Visible message + agent context
	 * await ctx.bot.api.sendMessage(Number(scope), "Build failed.");
	 * ctx.sessions.pushContext(scope, project,
	 *   "[CI notification]\nBuild failed on commit abc1234.\nError: type mismatch in src/foo.ts:42"
	 * );
	 */
	pushContext(scope: string, project: string, text: string): void;
}

// ─── Query Result (returned by handleMessage, passed to afterQuery) ─

export interface QueryResult {
	finalText: string;
	turns: number;
	project: string;
	error?: Error;
	costUsd: number;
	durationMs: number;
	toolCalls: Array<{ tool: string; durationMs: number }>;
	/** Token counts from the SDK. Zero when the run never reached `result`. */
	usage?: TokenUsage;
	/** SDK stop reason, or null if not available. */
	stopReason?: string | null;
	/** What the renderer chain produced. Decorators read this in afterQuery hooks. */
	renderArtifacts?: RenderArtifact[];
	/** Free-form metadata renderers attached to the result. */
	renderMeta?: Record<string, unknown>;
}

// ─── Query Options ──────────────────────────────────────────────

export interface QueryOpts {
	message: string;
	userId: string;
	scope: string;
	project: string;
	signal?: AbortSignal;
	/** Streaming prompt channel — if provided, used as AsyncIterable prompt for the SDK. */
	channel?: MessageChannel;
}

// ─── Plugin Context ─────────────────────────────────────────────

export interface PluginContext {
	/**
	 * Grammy bot instance. Provides direct access to Telegram Bot API.
	 *
	 * Use for per-chat command menus:
	 * ```typescript
	 * // Show only these commands in a specific chat
	 * bot.api.setMyCommands(commands, {
	 *   scope: { type: "chat", chat_id: chatId }
	 * });
	 *
	 * // Different commands for all group chats
	 * bot.api.setMyCommands(commands, {
	 *   scope: { type: "all_group_chats" }
	 * });
	 * ```
	 *
	 * Telegram applies scopes by priority:
	 * chat_member > chat > all_group_chats > all_private_chats > default
	 */
	bot: Bot<BotContext>;
	/** Plugin config lives under `plugins.{name}.*` namespace. `set()` auto-snapshots before mutation. */
	config: ConfigManager;
	/**
	 * Per-scope key-value storage.
	 *
	 * Three storage patterns — pick the right one:
	 * - Per-user state → scopeStore (active_project, preferences, tokens)
	 * - Global settings → config.get("plugins.myPlugin.setting")
	 * - Ephemeral runtime → variable in plugin closure (dies on reload)
	 */
	scopeStore: ScopeStore;
	query: (opts: QueryOpts) => AsyncIterable<QueryEvent>;
	sessions: SessionAPI;
}

export interface ToolContext extends PluginContext {
	userId: string;
	scope: string;
	project: string;
	cwd: string;
	/** Fires when query is cancelled (/cancel). Check `signal.aborted` in long-running handlers. */
	signal: AbortSignal;
	/** Undefined in nested queries (no chat context). */
	chatId?: number;
	messageThreadId?: number;
}

// ─── Bot Context (grammy context extended) ──────────────────────

export interface BotContext extends Context {
	pluginContext: PluginContext;

	/** Set by scope-resolution middleware. Available in all handlers/commands/hooks. */
	userId: string;
	scope: string;
	project: string;

	/** Set by plugins to override the text sent to Claude. Executor reads this ?? ctx.message.text. */
	overrideText?: string;

	/** Set by resolveContext hook when it returns a target. */
	resolvedTarget?: ResponseTarget;
}

// ─── Tools (MCP) ────────────────────────────────────────────────

export interface ToolDefinition {
	name: string;
	description: string;
	schema: ZodType;
	scope?: "self" | "all" | string[];
	handler: (input: unknown, ctx: ToolContext) => Promise<string>;
}

// ─── Commands ───────────────────────────────────────────────────

export type CommandHandler = (ctx: BotContext) => void | Promise<void>;

export interface CommandDefinition {
	description?: string;
	handler: CommandHandler;
}

// ─── Renderers ──────────────────────────────────────────────────

/**
 * One Telegram message produced by a renderer.
 *
 * - `role` — what this message represents in the answer. Closed enum so a
 *   decorator can write `result.artifacts.findLast(m => m.role === "body")`
 *   without guessing what string the wrapped renderer used. If your UX needs
 *   something off-list, stash it in `meta` and treat the role as the closest
 *   match.
 * - `kind` — `"primary"` is part of the answer the user will reread tomorrow
 *   (body, footer chunks); `"decoration"` is transient UX (live trace,
 *   thinking, status banner). Lets a "delete decorations on success"
 *   decorator find what to clean up.
 * - `meta` — free-form per-message data. Voice duration, doc filename,
 *   Telegraph URL, etc. Namespace keys like `"my-plugin.metric"` so multiple
 *   renderers can attach metadata without colliding.
 */
export interface RenderArtifact {
	messageId: number;
	/** Defaults to `ctx.target.chatId`. Set only for cross-chat artifacts. */
	chatId?: number;
	role: "body" | "thinking" | "trace" | "footer" | "status" | "attachment";
	kind: "primary" | "decoration";
	meta?: Record<string, unknown>;
}

/**
 * What a renderer (and the chain below it) produced. Flows back through
 * `await next(events)` so decorators can read what downstream wrote.
 *
 * `artifacts` is a flat ordered list — every message any layer sent. Use
 * `findLast(m => m.role === "body")` to locate the body for a footer reply,
 * or `filter(m => m.kind === "decoration")` to clean up overlays.
 *
 * `meta` is plugin-namespaced free-form data — TTS duration, telemetry blob,
 * anything not a Telegram message. Keep keys like `"my-plugin.metric"`.
 */
export interface RenderResult {
	artifacts: RenderArtifact[];
	meta?: Record<string, unknown>;
}

/** Empty result — for observers and error fall-through paths. */
export const EMPTY_RESULT: RenderResult = { artifacts: [] };

/**
 * Context passed to a renderer. Everything a renderer needs and nothing more.
 *
 * - `bot.api.*` is the **single** path to Telegram. Helpers in
 *   `@core/render-kit.ts` are convenience that wraps recurring patterns
 *   (debounced edits, parse-mode fallback, chunking). Drop down to
 *   `ctx.bot.api` whenever the helpers don't fit.
 * - `target` carries `chatId` + `messageThreadId` + `scope` + `project`. Pass
 *   to all helpers.
 * - `signal` fires on /cancel — check in long loops; ignore Telegram errors
 *   from edits issued after abort.
 * - `outcome` resolves with the terminal event when the turn ends. Cheaper
 *   than spying on the event stream when all you want is "did the turn
 *   succeed?" or "what was the final text?". Always resolves — kernel
 *   synthesizes a fallback if the SDK stream ends without a terminal.
 * - `pushContext(text)` appends to the agent's *next* prompt without showing
 *   a message to the user. Use when a renderer takes a UI action the agent
 *   should know about (e.g. "auto-pin renderer pinned message 42").
 * - `query` starts a nested agent query. Note: today this runs against the
 *   parent's `(scope, project)` and inherits its tools/session — fine for
 *   "delegate to the same project", but a stateless tool-less call (e.g. a
 *   pure translator) is not yet expressible. Treat as a known limitation.
 * - `config`, `scopeStore` for renderers that read plugin settings or
 *   per-user state.
 */
export interface RenderContext {
	bot: Bot<BotContext>;
	target: ResponseTarget;
	signal: AbortSignal;
	/** Resolves with the turn's terminal event. Always resolves. */
	outcome: Promise<TurnOutcome>;
	pushContext: (text: string) => void;
	query: (opts: QueryOpts) => AsyncIterable<QueryEvent>;
	config: ConfigManager;
	scopeStore: ScopeStore;
}

/**
 * A renderer translates a {@link QueryEvent} stream into Telegram UX.
 *
 * # Composition (Express-style chain, results flow back)
 * Renderers are sorted by `priority` (lower runs FIRST, wraps the next).
 * Each renderer either:
 *
 *   1. Calls `await next(events)` to delegate. The promise resolves with the
 *      {@link RenderResult} the downstream chain produced — including ids of
 *      every message it sent. Compose by spreading downstream's artifacts.
 *
 *   2. Does NOT call `next` — fully consumes the stream and returns its own
 *      result. The chain stops; the default tail renderer never runs.
 *
 * The kernel always installs the default text renderer at the innermost
 * layer, so a chain that always calls `next` always produces a reply.
 *
 * # The artifacts list
 * `result.artifacts` is a flat ordered `RenderArtifact[]` — every message
 * any layer below sent, in send order. Each carries a closed-enum `role`
 * (`'body'`, `'footer'`, `'trace'`, …) and a `kind` (`'primary'` =
 * permanent answer / `'decoration'` = transient UX). Decorators dispatch:
 *
 *     const result = await next(events);
 *     const body = result.artifacts.findLast(m => m.role === "body");
 *     if (body) { ... attach footer to body.messageId ... }
 *
 * # Error isolation
 * If a renderer throws, the kernel logs the failure and falls through to
 * `next` so the user still gets a reply. You don't need try/catch for
 * kernel safety — only for your own recovery.
 *
 * # Replacement renderers must handle every terminal
 * If you don't call `next`, you take responsibility for the whole stream —
 * including `error` and `aborted` terminals. The default renderer surfaces
 * errors to the user; if your replacement only handles `complete`, the user
 * gets silence on failure. Iterate `events` to a terminal in every branch.
 *
 * # Single capability path to Telegram
 * Use `ctx.bot.api.*` (full grammy surface). Import helpers from
 * `@core/render-kit.ts` for recurring patterns:
 *
 *   - `messageStream(bot, target, { role, kind })` — debounced chunked
 *     edit-in-place; `stream.artifacts()` gives the {@link RenderArtifact}[]
 *     tagged with the role/kind you set
 *   - `sendTelegramHtml`, `editTelegramHtml` — parse-mode fallback wrappers
 *   - `markdownToTelegramHtml(md)` — model markdown → Telegram HTML
 *   - `tee(events, n)` — split the iterable for fan-out (always wrap the
 *     consumer in try/finally so overlays clean up on error)
 *   - `filter(events, pred)` / `map(events, fn)` — stream combinators
 *   - `accumulate(events)` — passthrough + reconciled-text accessor
 *
 * @example pass-through filter (drop thinking)
 *   import { filter } from "@core/render-kit.ts";
 *   renderer: async (events, ctx, next) =>
 *     next(filter(events, (e) => e.type !== "thinking_delta"));
 *
 * @example terminal text body
 *   import { messageStream, markdownToTelegramHtml } from "@core/render-kit.ts";
 *   renderer: async (events, ctx) => {
 *     const stream = messageStream(ctx.bot, ctx.target, { role: "body", kind: "primary" });
 *     let text = "";
 *     for await (const e of events) {
 *       if (e.type === "text_delta") { text += e.delta; stream.set(markdownToTelegramHtml(text)); }
 *       else if (e.type === "complete") { if (e.text !== text) text = e.text;
 *                                         stream.set(markdownToTelegramHtml(text)); }
 *     }
 *     await stream.flush();
 *     return { artifacts: stream.artifacts() };
 *   }
 *
 * @example cost footer (decorator reads ctx.outcome)
 *   renderer: async (events, ctx, next) => {
 *     const [result, outcome] = await Promise.all([next(events), ctx.outcome]);
 *     const body = result.artifacts.findLast(m => m.role === "body");
 *     if (!body) return result;
 *     const sent = await ctx.bot.api.sendMessage(ctx.target.chatId,
 *       `<i>${outcome.turns} turns · $${outcome.costUsd.toFixed(3)}</i>`,
 *       { reply_parameters: { message_id: body.messageId }, parse_mode: "HTML",
 *         message_thread_id: ctx.target.messageThreadId });
 *     return {
 *       ...result,
 *       artifacts: [
 *         ...result.artifacts,
 *         { messageId: sent.message_id, role: "footer", kind: "primary" },
 *       ],
 *     };
 *   }
 *
 * @example ephemeral overlay + delegate text
 *   import { messageStream, tee } from "@core/render-kit.ts";
 *   renderer: async (events, ctx, next) => {
 *     const [forTrace, forNext] = tee(events);
 *     const overlay = messageStream(ctx.bot, ctx.target, { kind: "decoration" });
 *     const trace = (async () => {
 *       try {
 *         const inFlight = new Map<string, string>();
 *         for await (const e of forTrace) {
 *           if (e.type === "tool_start") inFlight.set(e.callId, e.tool);
 *           else if (e.type === "tool_end") inFlight.delete(e.callId);
 *           overlay.set([...inFlight.values()].map(t => `🔧 ${t}`).join("\n") || " ");
 *         }
 *       } finally {
 *         await overlay.delete();   // always clean up, even on error
 *       }
 *     })();
 *     const result = await next(forNext);
 *     await trace;
 *     return result;
 *   }
 */
export type Renderer = (
	events: AsyncIterable<QueryEvent>,
	ctx: RenderContext,
	next: (events: AsyncIterable<QueryEvent>) => Promise<RenderResult>,
) => Promise<RenderResult>;

// ─── Plugin ─────────────────────────────────────────────────────

export interface Plugin {
	name: string;
	description?: string;
	/** Lower = earlier. Default: 50. Routing plugins use 20-30. */
	priority?: number;
	configSchema?: ZodType;

	// registration
	middleware?: MiddlewareFn<BotContext>[];
	commands?: Record<string, CommandHandler | CommandDefinition>;
	/** Keys are grammy filter queries, e.g. `"message:photo"`. See: https://grammy.dev/guide/filter-queries */
	handlers?: Record<string, (ctx: BotContext) => void | Promise<void>>;
	tools?: ToolDefinition[];

	// hooks

	/** Determine scope + project + optional response target. Chain: first non-null wins. */
	resolveContext?: (
		ctx: BotContext,
		pluginCtx: PluginContext,
	) =>
		| { scope: string; project: string; target?: ResponseTarget }
		| null
		| Promise<{
				scope: string;
				project: string;
				target?: ResponseTarget;
		  } | null>;

	/** Gate access. Any returning true = allowed. */
	authCheck?: (
		userId: string,
		pluginConfig: unknown,
		ctx: BotContext,
	) => boolean;

	/** Called before agent query starts. Throw to abort (e.g. rate limiting). */
	beforeQuery?: (opts: QueryOpts, ctx: BotContext) => void | Promise<void>;

	afterQuery?: (result: QueryResult, ctx: BotContext) => void | Promise<void>;

	/** Customize response rendering. See {@link Renderer}. */
	renderer?: Renderer;

	// lifecycle
	/** Called on plugin load. signal fires after 5s timeout if register() hangs. */
	register?(ctx: PluginContext, signal: AbortSignal): void | Promise<void>;
	dispose?(): void | Promise<void>;
}

// ─── Type-safe helpers (definePlugin, defineTool) ───────────────

export function defineTool<TSchema extends z.ZodType>(def: {
	name: string;
	description: string;
	schema: TSchema;
	scope?: "self" | "all" | string[];
	handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<string>;
}): ToolDefinition {
	return def as ToolDefinition;
}

/** Plugin with configSchema — pluginConfig is typed from schema */
export function definePlugin<TConfig extends z.ZodType>(
	options: Omit<Plugin, "configSchema" | "authCheck" | "tools"> & {
		configSchema: TConfig;
		authCheck?: (
			userId: string,
			pluginConfig: z.infer<TConfig>,
			ctx: BotContext,
		) => boolean;
		tools?: ToolDefinition[];
	},
): Plugin;
/** Plugin without configSchema */
export function definePlugin(
	options: Omit<Plugin, "authCheck" | "tools"> & {
		authCheck?: (
			userId: string,
			pluginConfig: undefined,
			ctx: BotContext,
		) => boolean;
		tools?: ToolDefinition[];
	},
): Plugin;
export function definePlugin(options: Record<string, unknown>): Plugin {
	return options as unknown as Plugin;
}
