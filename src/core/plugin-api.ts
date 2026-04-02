import type { Database } from "bun:sqlite";
import type { Bot, Context, MiddlewareFn } from "grammy";
import type { ZodType, z } from "zod";
import type { ConfigManager } from "./config.ts";
import type { MessageChannel } from "./message-channel.ts";

// ─── Response Target ────────────────────────────────────────────

export interface ResponseTarget {
	chatId: number;
	messageThreadId?: number;
}

// ─── Query Events (streaming from Claude) ───────────────────────

export type QueryEvent =
	| { type: "text_delta"; delta: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "tool_start"; tool: string; input: unknown }
	| { type: "tool_end"; tool: string; output: string }
	| { type: "done"; finalText: string; turns: number };

// ─── Sessions ───────────────────────────────────────────────────

export interface SessionInfo {
	id: string;
	projectName: string;
	createdAt: string;
	lastUsed: string;
	turns: number;
	costUsd: number;
	isActive: boolean;
}

export interface SessionAPI {
	list(userId: string, projectName?: string): SessionInfo[];
	activate(sessionId: string): void;
	getActive(userId: string, projectName: string): SessionInfo | null;
	getActiveProject(userId: string): string;
}

// ─── Query Result (returned by handleMessage, passed to afterQuery) ─

export interface QueryResult {
	finalText: string;
	turns: number;
	project: string;
	error?: Error;
}

// ─── Query Options ──────────────────────────────────────────────

export interface QueryOpts {
	message: string;
	userId: string;
	project: string;
	signal?: AbortSignal;
	/** Streaming prompt channel — if provided, used as AsyncIterable prompt for the SDK. */
	channel?: MessageChannel;
}

// ─── Plugin Context ─────────────────────────────────────────────

export interface PluginContext {
	bot: Bot<BotContext>;
	config: ConfigManager;
	db: Database;
	query: (opts: QueryOpts) => AsyncIterable<QueryEvent>;
	sessions: SessionAPI;
}

/** Сервисы + per-request данные. Получаешь в tool handler при каждом вызове. */
export interface ToolContext extends PluginContext {
	userId: string;
	project: string;
	cwd: string;
	chatId?: number;
	messageThreadId?: number;
}

// ─── Bot Context (grammy context extended) ──────────────────────

export interface BotContext extends Context {
	pluginContext: PluginContext;
	/** Set by plugins to override the text sent to Claude. Executor reads this ?? ctx.message.text. */
	overrideText?: string;
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

// ─── Approval ───────────────────────────────────────────────────

export interface ApprovalRequest {
	tool: string;
	input: unknown;
	description: string;
	chatId: number;
	bot: Bot<BotContext>;
}

// ─── Plugin ─────────────────────────────────────────────────────

export interface Plugin {
	name: string;
	description?: string;
	priority?: number;
	configSchema?: ZodType;

	// registration
	middleware?: MiddlewareFn<BotContext>[];
	commands?: Record<string, CommandHandler | CommandDefinition>;
	handlers?: Record<string, (ctx: BotContext) => void | Promise<void>>;
	tools?: ToolDefinition[];

	// hooks
	afterQuery?: (result: QueryResult, ctx: BotContext) => void | Promise<void>;
	authCheck?: (
		userId: string,
		pluginConfig: unknown,
		ctx: BotContext,
	) => boolean;
	resolveTarget?: (
		userId: string,
		project: string,
		ctx: BotContext,
	) => ResponseTarget;
	/** @deprecated Use renderMiddleware instead */
	responseRenderer?: (
		events: AsyncIterable<QueryEvent>,
		target: ResponseTarget,
		bot: Bot<BotContext>,
	) => Promise<void>;
	renderMiddleware?: (
		events: AsyncIterable<QueryEvent>,
		target: ResponseTarget,
		bot: Bot<BotContext>,
		next: (events: AsyncIterable<QueryEvent>) => Promise<void>,
	) => Promise<void>;
	approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;

	// lifecycle
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
