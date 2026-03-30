import type { Database } from "bun:sqlite";
import type { Bot, Context, MiddlewareFn } from "grammy";
import type { ZodType, z } from "zod";
import type { ConfigManager } from "./config.ts";

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
	| { type: "done"; finalText: string };

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
}

// ─── Query Options ──────────────────────────────────────────────

export interface QueryOpts {
	message: string;
	userId: string;
	project: string;
	images?: Array<{ mediaType: string; data: string }>;
	signal?: AbortSignal;
}

// ─── Plugin Context ─────────────────────────────────────────────

export interface PluginContext {
	bot: Bot<BotContext>;
	config: ConfigManager;
	db: Database;
	query: (opts: QueryOpts) => AsyncIterable<QueryEvent>;
	sessions: SessionAPI;
}

// ─── Bot Context (grammy context extended) ──────────────────────

export interface BotContext extends Context {
	pluginContext: PluginContext;
}

// ─── Tools (MCP) ────────────────────────────────────────────────

export interface ToolDefinition {
	name: string;
	description: string;
	schema: ZodType;
	handler: (input: unknown, ctx: PluginContext) => Promise<string>;
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
	responseRenderer?: (
		events: AsyncIterable<QueryEvent>,
		target: ResponseTarget,
		bot: Bot<BotContext>,
	) => Promise<void>;
	approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;

	// lifecycle
	register?(ctx: PluginContext): void | Promise<void>;
	dispose?(): void | Promise<void>;
}

// ─── Type-safe helpers (definePlugin, defineTool) ───────────────

export function defineTool<TSchema extends z.ZodType>(def: {
	name: string;
	description: string;
	schema: TSchema;
	handler: (input: z.infer<TSchema>, ctx: PluginContext) => Promise<string>;
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
