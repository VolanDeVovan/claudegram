import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ConfigManager } from "./config.ts";
import type { GenerationManager } from "./generation-manager.ts";
import type { LoadedPlugins } from "./plugin-loader.ts";

export function createCoreTools(
	config: ConfigManager,
	generationManager: GenerationManager,
	getLoadedPlugins: () => LoadedPlugins,
	reloadFn: () => Promise<{ loaded: string[]; errors: string[] }>,
): SdkMcpToolDefinition[] {
	return [
		{
			name: "config_get",
			description:
				"Get bot configuration. Without key: returns full config with field descriptions. With key: returns specific value (dot-path, e.g. 'plugins.auth.allowedUsers').",
			inputSchema: {
				key: z.string().optional().describe("Dot-path config key"),
			},
			handler: async (args: Record<string, unknown>) => {
				const key = args.key as string | undefined;
				if (key) {
					const value = config.get(key);
					const schema = config.getSchema();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{ key, value, type: schema[key] ?? "unknown" },
									null,
									2,
								),
							},
						],
					};
				}

				// Full config (without botToken for security)
				const data = { ...config.data, botToken: "[REDACTED]" };
				const schema = config.getSchema();
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ config: data, schema }, null, 2),
						},
					],
				};
			},
		},
		{
			name: "config_set",
			description:
				"Set a bot configuration value. Key is a dot-path (e.g. 'model', 'plugins.auth.allowedUsers'). Validates via Zod schema. Preserves JSONC comments.",
			inputSchema: {
				key: z.string().describe("Dot-path config key"),
				value: z.unknown().describe("New value"),
			},
			handler: async (args: Record<string, unknown>) => {
				const key = String(args.key);
				const value = args.value;
				try {
					const oldValue = config.get(key);
					config.set(key, value);
					return {
						content: [
							{
								type: "text" as const,
								text: `Config updated: ${key}\nOld: ${JSON.stringify(oldValue)}\nNew: ${JSON.stringify(value)}`,
							},
						],
					};
				} catch (e) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: ${e instanceof Error ? e.message : String(e)}`,
							},
						],
						isError: true,
					};
				}
			},
		},
		{
			name: "plugin_list",
			description:
				"List active plugins loaded from plugins/ and available templates from src/templates/.",
			inputSchema: {},
			handler: async () => {
				const loaded = getLoadedPlugins();
				const active = loaded.plugins.map((p) => ({
					name: p.name,
					description: p.description ?? "(no description)",
					priority: p.priority ?? 50,
				}));

				// List available templates
				const { readdirSync, existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				const templatesDir = join(import.meta.dir, "..", "templates");
				let templates: string[] = [];
				if (existsSync(templatesDir)) {
					templates = readdirSync(templatesDir)
						.filter((f: string) => f.endsWith(".ts"))
						.map((f: string) => f.replace(/\.ts$/, ""));
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ active, templates, errors: loaded.errors },
								null,
								2,
							),
						},
					],
				};
			},
		},
		{
			name: "reload_plugins",
			description:
				"Hot-reload all plugins from plugins/. Creates a generation snapshot before reload. Returns list of loaded plugins and errors.",
			inputSchema: {},
			handler: async () => {
				const result = await reloadFn();
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			},
		},
		{
			name: "generation_list",
			description: "List all plugin generation snapshots with descriptions.",
			inputSchema: {},
			handler: async () => {
				const gens = generationManager.list();
				const current = generationManager.getCurrent();
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ current, generations: gens }, null, 2),
						},
					],
				};
			},
		},
		{
			name: "generation_rollback",
			description: "Rollback plugins to a specific generation snapshot.",
			inputSchema: {
				generation: z.number().describe("Generation number to rollback to"),
			},
			handler: async (args: Record<string, unknown>) => {
				const gen = Number(args.generation);
				try {
					generationManager.rollback(gen);
					const result = await reloadFn();
					return {
						content: [
							{
								type: "text" as const,
								text: `Rolled back to generation ${gen}. Reload result: ${JSON.stringify(result)}`,
							},
						],
					};
				} catch (e) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Rollback error: ${e instanceof Error ? e.message : String(e)}`,
							},
						],
						isError: true,
					};
				}
			},
		},
		{
			name: "generation_diff",
			description:
				"Show unified diff between generations or current plugins state. Omit 'to' to compare against live plugins/. Omit 'from' to use the first generation. Omit both to see full change history (first generation vs current).",
			inputSchema: {
				from: z
					.number()
					.optional()
					.describe("Source generation number (omit to use first generation)"),
				to: z
					.number()
					.optional()
					.describe(
						"Target generation number (omit to compare against current plugins/)",
					),
			},
			handler: async (args: Record<string, unknown>) => {
				try {
					const from = args.from != null ? Number(args.from) : undefined;
					const to = args.to != null ? Number(args.to) : undefined;
					const diff = generationManager.diff(from, to);
					return {
						content: [{ type: "text" as const, text: diff }],
					};
				} catch (e) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Diff error: ${e instanceof Error ? e.message : String(e)}`,
							},
						],
						isError: true,
					};
				}
			},
		},
	] as SdkMcpToolDefinition[];
}
