import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getLogger } from "@logtape/logtape";
import {
	applyEdits,
	type FormattingOptions,
	modify,
	parse,
} from "jsonc-parser";
import { z } from "zod";

const log = getLogger(["bot", "config"]);

const McpServerSchema = z.union([
	z.object({
		name: z.string(),
		type: z.enum(["http", "sse"]),
		url: z.string(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
	z.object({
		name: z.string(),
		command: z.string(),
		args: z.array(z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
	}),
]);

const ProjectSchema = z.object({
	name: z.string(),
	path: z.string(),
	description: z.string().optional(),
	model: z.string().optional(),
	mcpServers: z.array(McpServerSchema).optional(),
});

export const BaseConfigSchema = z.object({
	botToken: z.string(),
	owner: z.string(),
	projects: z.array(ProjectSchema).default([]),
	defaultProject: z.string().default("self"),
	model: z.string().default("sonnet"),
	maxTurns: z.number().default(200),
	sessionTimeoutHours: z.number().default(24),
	plugins: z.record(z.string(), z.unknown()).default({}),
	coreTools: z
		.record(
			z.string(),
			z.union([z.literal("self"), z.literal("all"), z.array(z.string())]),
		)
		.default({}),
});

export type BotConfig = z.infer<typeof BaseConfigSchema>;

const FORMATTING: FormattingOptions = {
	tabSize: 2,
	insertSpaces: true,
	eol: "\n",
};

export class ConfigManager {
	private filePath: string;
	private rawContent: string;
	private parsed: BotConfig;
	private pluginSchemas = new Map<string, z.ZodType>();

	constructor(filePath: string) {
		this.filePath = filePath;
		this.rawContent = readFileSync(filePath, "utf-8");
		this.parsed = BaseConfigSchema.parse(parse(this.rawContent));
	}

	get data(): BotConfig {
		return this.parsed;
	}

	get<T = unknown>(key?: string): T {
		if (!key) return this.parsed as T;
		const parts = key.split(".");
		let current: unknown = this.parsed;
		for (const part of parts) {
			if (current == null || typeof current !== "object") return undefined as T;
			current = (current as Record<string, unknown>)[part];
		}
		return current as T;
	}

	private static readonly CORE_TOOL_NAMES = new Set([
		"config_get",
		"config_set",
		"plugin_list",
		"reload_plugins",
		"generation_list",
		"generation_rollback",
		"generation_diff",
	]);

	set(key: string, value: unknown): void {
		const path = key.split(".");

		// Validate plugin configs against their schemas
		if (path[0] === "plugins" && path.length >= 2) {
			const pluginName = path[1] as string;
			const schema = this.pluginSchemas.get(pluginName);
			if (schema && path.length === 2) {
				schema.parse(value);
			}
		}

		// Validate coreTools entries
		if (path[0] === "coreTools" && path.length === 2) {
			const toolName = path[1] as string;
			if (!ConfigManager.CORE_TOOL_NAMES.has(toolName)) {
				throw new Error(
					`Unknown core tool '${toolName}'. Valid tools: ${[...ConfigManager.CORE_TOOL_NAMES].join(", ")}`,
				);
			}
			this.validateCoreToolScope(toolName, value);
		}

		// Validate full coreTools object
		if (
			path[0] === "coreTools" &&
			path.length === 1 &&
			typeof value === "object" &&
			value !== null
		) {
			for (const [toolName, scope] of Object.entries(
				value as Record<string, unknown>,
			)) {
				if (!ConfigManager.CORE_TOOL_NAMES.has(toolName)) {
					throw new Error(
						`Unknown core tool '${toolName}'. Valid tools: ${[...ConfigManager.CORE_TOOL_NAMES].join(", ")}`,
					);
				}
				this.validateCoreToolScope(toolName, scope);
			}
		}

		// Apply edit preserving JSONC comments
		const edits = modify(this.rawContent, path, value, {
			formattingOptions: FORMATTING,
		});
		this.rawContent = applyEdits(this.rawContent, edits);
		writeFileSync(this.filePath, this.rawContent, "utf-8");

		// Re-parse
		this.parsed = BaseConfigSchema.parse(parse(this.rawContent));
		log.info("Config changed: {key} = {value}", {
			key,
			value: JSON.stringify(value),
		});
	}

	private validateCoreToolScope(toolName: string, scope: unknown): void {
		if (scope === "self" || scope === "all") return;
		if (!Array.isArray(scope)) {
			throw new Error(
				`Invalid scope for core tool '${toolName}': must be "self", "all", or an array of project names`,
			);
		}
		const projectNames = new Set(this.parsed.projects.map((p) => p.name));
		for (const name of scope) {
			if (typeof name !== "string") {
				throw new Error(
					`Invalid scope for core tool '${toolName}': array must contain strings`,
				);
			}
			if (!projectNames.has(name)) {
				throw new Error(
					`Unknown project '${name}' in scope for core tool '${toolName}'. Known projects: ${[...projectNames].join(", ") || "(none)"}`,
				);
			}
		}
	}

	reload(): void {
		this.rawContent = readFileSync(this.filePath, "utf-8");
		this.parsed = BaseConfigSchema.parse(parse(this.rawContent));
	}

	registerPluginSchema(name: string, schema: z.ZodType): void {
		this.pluginSchemas.set(name, schema);
	}

	getPluginSchemas(): Map<string, z.ZodType> {
		return this.pluginSchemas;
	}

	getSchema(): Record<string, string> {
		const descriptions: Record<string, string> = {
			botToken: "string — Telegram bot token from @BotFather",
			owner: "string — Owner Telegram user ID (full access)",
			projects:
				"array — List of projects [{name, path, description?, model?, mcpServers?}]",
			defaultProject: "string — Default active project (default: 'self')",
			model:
				"string — Claude model alias (sonnet, opus, haiku) or full ID (default: 'sonnet')",
			maxTurns: "number — Max conversation turns per query (default: 200)",
			sessionTimeoutHours: "number — Session timeout in hours (default: 24)",
			plugins: "object — Plugin-specific configuration (keyed by plugin name)",
			coreTools:
				'object — Override visibility scope for built-in tools. Keys: tool name (config_get, config_set, plugin_list, reload_plugins, generation_list, generation_rollback, generation_diff). Values: "self" (only in self project), "all" (all projects), or ["proj1","proj2"] (specific projects). Default scope for all core tools is "self". Example: {"plugin_list": "all"} makes plugin_list available in every project.',
		};

		for (const [name, _schema] of this.pluginSchemas) {
			descriptions[`plugins.${name}`] = `object — Config for plugin '${name}'`;
		}

		return descriptions;
	}

	static exists(filePath: string): boolean {
		return existsSync(filePath);
	}

	static create(filePath: string, config: Record<string, unknown>): void {
		const content = `{
  // Telegram bot token from @BotFather
  "botToken": ${JSON.stringify(config.botToken)},

  // Owner Telegram user ID (full access, cannot be removed)
  "owner": ${JSON.stringify(config.owner)},

  // Projects
  "projects": ${JSON.stringify(config.projects, null, 2).split("\n").join("\n  ")},
  "defaultProject": "self",

  // Claude model — alias (sonnet, opus, haiku) or full ID (claude-sonnet-4-6)
  "model": "sonnet",
  "maxTurns": 200,

  // Sessions
  "sessionTimeoutHours": 24,

  // Plugin-specific configs
  "plugins": {}
}
`;
		writeFileSync(filePath, content, "utf-8");
	}
}
