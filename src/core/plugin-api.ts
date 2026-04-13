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
 * Streaming events from Claude SDK query.
 *
 * `callId` links tool_start and tool_end — use a Map<callId, input> in
 * renderMiddleware to associate tool output with its input.
 */
export type QueryEvent =
	| { type: "text_delta"; delta: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "tool_start"; callId: string; tool: string; input: unknown }
	| { type: "tool_end"; callId: string; tool: string; output: string }
	| { type: "done"; finalText: string; turns: number };

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

	/**
	 * Customize response rendering. Works like Express middleware — call `next(events)`
	 * to pass through, or consume events yourself to replace rendering entirely.
	 *
	 * ```typescript
	 * async renderMiddleware(events, target, bot, next) {
	 *   // Transform: wrap events in your own async generator
	 *   async function* filtered() {
	 *     for await (const e of events) {
	 *       if (e.type !== "thinking_delta") yield e;
	 *     }
	 *   }
	 *   await next(filtered());
	 * }
	 * ```
	 */
	renderMiddleware?: (
		events: AsyncIterable<QueryEvent>,
		target: ResponseTarget,
		bot: Bot<BotContext>,
		next: (events: AsyncIterable<QueryEvent>) => Promise<void>,
	) => Promise<void>;

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
