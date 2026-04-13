import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import type { ConfigManager } from "./config.ts";
import * as git from "./git.ts";
import type { ToolContext } from "./plugin-api.ts";
import type { LoadedPlugins } from "./plugin-loader.ts";
import {
	type ApplyResult,
	applyRollback,
	applyUpdate,
	type BotRuntime,
	gracefulExit,
	preflight,
	type TracePush,
} from "./update.ts";
import type { NotifyTarget } from "./update-state.ts";

const log = getLogger(["bot", "core-tools"]);

type McpResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

/**
 * Core tool definition. Handlers receive the full per-query `ToolContext` so
 * they can operate against the invoking scope/project/chat rather than
 * guessing — see `generation_rollback` for why that matters.
 */
export type CoreToolDef = Omit<SdkMcpToolDefinition, "handler"> & {
	scope: "self" | "all" | string[];
	handler: (
		args: Record<string, unknown>,
		ctx: ToolContext,
	) => Promise<McpResult>;
};

function targetFromContext(ctx: ToolContext): NotifyTarget | null {
	if (ctx.chatId == null) return null;
	return {
		chatId: ctx.chatId,
		messageThreadId: ctx.messageThreadId,
	};
}

const TRACE_STDOUT_CAP = 4096;

function capStdout(s: string): string {
	if (s.length <= TRACE_STDOUT_CAP) return s;
	return `${s.slice(0, TRACE_STDOUT_CAP)}\n...[truncated]`;
}

function createTrace(): { trace: string[]; push: TracePush } {
	const trace: string[] = [];
	const push: TracePush = (cmd, stdout, stderr) => {
		trace.push(`$ ${cmd}`);
		const out = (stdout ?? "").trimEnd();
		if (out) trace.push(capStdout(out));
		const err = (stderr ?? "").trimEnd();
		if (err) trace.push(err);
		trace.push("");
	};
	return { trace, push };
}

function textResult(text: string, isError = false): McpResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
	};
}

function formatApplyResult(opts: {
	trace: string[];
	result: ApplyResult;
	apiChanged: boolean;
	apiDiff: string;
}): string {
	const { trace, result, apiChanged, apiDiff } = opts;
	// Count before capping so the header reflects the real commit count even
	// when the displayed list is truncated.
	const commitCount = result.commitLog
		? result.commitLog.split("\n").length
		: 0;
	const cappedLog = result.commitLog ? capStdout(result.commitLog) : "";
	const commitLines = cappedLog
		? cappedLog
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n")
		: "  (no commits in range)";
	const apiNote = apiChanged
		? `src/core/plugin-api.ts CHANGED in this update:\n${capStdout(apiDiff)}`
		: "src/core/plugin-api.ts: unchanged in this update.";

	return [
		"═══ UPDATE APPLIED ═══",
		`${result.prevHead.slice(0, 7)} → ${result.newHead.slice(0, 7)} (${commitCount} commit(s))`,
		"",
		"Commits applied:",
		commitLines,
		"",
		apiNote,
		"",
		"═══ NEXT STEPS ═══",
		'Look at the commits above. If you see ANY of the following — launch the migration-agent via the Task tool with subagent_type: "migration-agent":',
		"  - 'BREAKING:' or 'BREAKING CHANGE:' in commit messages",
		"  - changes to src/core/plugin-api.ts (signatures, renames, removed exports)",
		"  - new required hooks/fields/methods on the Plugin interface",
		"  - anything you're unsure about that touches the plugin contract",
		"",
		`Pass the sub-agent a prompt naming prevHead (${result.prevHead.slice(0, 7)}) and newHead (${result.newHead.slice(0, 7)}) and asking it to migrate plugins/.`,
		"",
		"If the commits clearly don't affect plugins (internal refactor, docs, core-only fixes), skip migration and respond to the user directly.",
		"",
		"The bot will restart automatically when your turn ends. Do NOT call reload_plugins (or any other plugin reload) after migration — it runs against the old in-memory plugin-api.ts and will fail on cached imports. The post-restart reload picks up the migrated plugins automatically. Just finish your reply.",
		"",
		"═══ COMMAND TRACE ═══",
		trace.join("\n").trimEnd(),
	].join("\n");
}

const APPLY_UPDATE_DESCRIPTION = `Apply available bot updates. Pulls new code, runs bun install, then schedules a graceful restart that fires when your turn ends.

REQUIRES explicit user confirmation — always call check_updates first, present commits to the user in their own words, and only call this after the user has confirmed they want to apply.

Returns a structured report listing the applied commits and instructions for post-update plugin migration. Read it carefully — if any commit could affect the plugin API, you MUST launch the migration-agent via the Task tool before your turn ends. The bot will restart automatically when your turn finishes; broken plugins will fail to load on the new runtime if you skip migration.`;

const APPLY_UPDATE_GRACEFUL_EXIT_MS = 15 * 60_000;

export function createCoreTools(
	config: ConfigManager,
	getLoadedPlugins: () => LoadedPlugins,
	reloadFn: () => Promise<{ loaded: string[]; errors: string[] }>,
	runtime: BotRuntime,
): CoreToolDef[] {
	const { generations } = runtime;
	const tools: CoreToolDef[] = [
		{
			scope: "self",
			name: "config_get",
			description:
				"Get bot configuration. Without key: returns full config with field descriptions. With key: returns specific value (dot-path, e.g. 'plugins.auth.allowedUsers').",
			inputSchema: {
				key: z.string().optional().describe("Dot-path config key"),
			},
			handler: async (args) => {
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
			scope: "self",
			name: "config_set",
			description:
				"Set a bot configuration value. Key is a dot-path (e.g. 'model', 'plugins.auth.allowedUsers'). Validates via Zod schema. Preserves JSONC comments.",
			inputSchema: {
				key: z.string().describe("Dot-path config key"),
				value: z.unknown().describe("New value"),
			},
			handler: async (args) => {
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
			scope: "self",
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
			scope: "self",
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
			scope: "self",
			name: "generation_list",
			description: "List all plugin generation snapshots with descriptions.",
			inputSchema: {},
			handler: async () => {
				const gens = generations.list();
				const current = generations.getCurrent();
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
			scope: "self",
			name: "generation_rollback",
			description: "Rollback plugins to a specific generation snapshot.",
			inputSchema: {
				generation: z.number().describe("Generation number to rollback to"),
			},
			handler: async (args, ctx) => {
				const gen = Number(args.generation);
				const target = targetFromContext(ctx);
				if (!target) {
					return textResult(
						"generation_rollback must be called from a chat-bound query (no chat_id in tool context).",
						true,
					);
				}
				try {
					const result = await applyRollback(
						runtime,
						gen,
						ctx.scope,
						ctx.project,
						target,
						reloadFn,
					);
					return textResult(result.message);
				} catch (e) {
					return textResult(
						`Rollback error: ${e instanceof Error ? e.message : String(e)}`,
						true,
					);
				}
			},
		},
		{
			scope: "self",
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
			handler: async (args) => {
				try {
					const from = args.from != null ? Number(args.from) : undefined;
					const to = args.to != null ? Number(args.to) : undefined;
					const diff = generations.diff(from, to);
					return textResult(diff);
				} catch (e) {
					return textResult(
						`Diff error: ${e instanceof Error ? e.message : String(e)}`,
						true,
					);
				}
			},
		},
		{
			scope: "self",
			name: "check_updates",
			description:
				"Check if bot updates are available. Runs `git fetch` against the current branch's upstream and lists any pending commits. Returns the command trace so you can show the user exactly what ran. To apply updates, call apply_update after the user confirms.",
			inputSchema: {},
			handler: async () => {
				const { trace, push } = createTrace();

				const fetched = git.fetch(runtime.rootDir);
				push(fetched.command, "", fetched.stderr);
				if (!fetched.ok) {
					return textResult(
						`git fetch failed:\n${fetched.stderr}\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
						true,
					);
				}

				const pre = preflight(runtime.rootDir);
				if (!pre.ok) {
					return textResult(
						`${pre.reason ?? "Pre-flight check failed."}\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
						true,
					);
				}

				const pending = git.pendingCommits(runtime.rootDir);
				push(pending.command, pending.stdout || "(no commits)");
				if (!pending.stdout) {
					return textResult(
						`Already up to date.\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
					);
				}

				// Impact analysis: diff plugin-api.ts between HEAD and upstream.
				// If the public plugin surface changes, migration-agent will
				// rewrite plugin files — which is strictly more invasive than
				// a plain update and needs separate user awareness.
				const apiDiff = git.diffPath(
					runtime.rootDir,
					"HEAD",
					"@{u}",
					"src/core/plugin-api.ts",
				);
				push(apiDiff.command, apiDiff.stdout || "(no changes)");
				const apiChanged = apiDiff.stdout.length > 0;

				const impactBlock = apiChanged
					? [
							"",
							"═══ IMPACT ═══",
							"This update modifies src/core/plugin-api.ts.",
							"If applied, the migration-agent will REWRITE plugin files in plugins/ to match the new API.",
							"BEFORE calling apply_update, tell the user plainly that their plugin files will be modified and get explicit confirmation for the migration — not just for the update itself.",
						].join("\n")
					: "";

				return textResult(
					`Updates available:\n\n${pending.stdout}${impactBlock}\n\nTo apply, call apply_update after the user confirms.\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
				);
			},
		},
		{
			scope: "self",
			name: "apply_update",
			description: APPLY_UPDATE_DESCRIPTION,
			inputSchema: {},
			handler: async (_args, ctx) => {
				const target = targetFromContext(ctx);
				if (!target) {
					return textResult(
						"apply_update must be called from a chat-bound query (no chat_id in tool context).",
						true,
					);
				}

				const { trace, push } = createTrace();

				const fetched = git.fetch(runtime.rootDir);
				push(fetched.command, "", fetched.stderr);
				if (!fetched.ok) {
					return textResult(
						`git fetch failed:\n${fetched.stderr}\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
						true,
					);
				}

				const pre = preflight(runtime.rootDir);
				if (!pre.ok) {
					return textResult(
						`${pre.reason ?? "Pre-flight check failed."}\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
						true,
					);
				}

				const pending = git.pendingCommits(runtime.rootDir);
				push(pending.command, pending.stdout || "(no commits)");
				if (!pending.stdout) {
					return textResult(
						`Already up to date. Nothing to apply.\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
					);
				}

				let result: ApplyResult;
				try {
					result = await applyUpdate(
						runtime,
						ctx.scope,
						ctx.project,
						target,
						push,
					);
				} catch (e) {
					return textResult(
						`Update failed: ${e instanceof Error ? e.message : String(e)}\n\n═══ COMMAND TRACE ═══\n${trace.join("\n").trimEnd()}`,
						true,
					);
				}

				// Schedule the restart NOW, before we format anything. applyUpdate
				// has already written new code and deps to disk; if a subsequent
				// step in this handler throws (diffPath, string formatting, etc.)
				// we must not leave the process running on the old in-memory
				// runtime against a new on-disk tree. gracefulExit is fire-and-
				// forget — it polls activeQueries and waits for this query to
				// finish before calling process.exit(42), so scheduling it earlier
				// doesn't fire it earlier. 15-minute cap is generous enough for
				// any reasonable migration pass the agent runs via the Task tool.
				gracefulExit(runtime, APPLY_UPDATE_GRACEFUL_EXIT_MS).catch((e) =>
					log.error("gracefulExit error: {error}", {
						error: e instanceof Error ? e.message : String(e),
					}),
				);

				const apiDiff = git.diffPath(
					runtime.rootDir,
					result.prevHead,
					result.newHead,
					"src/core/plugin-api.ts",
				);
				push(apiDiff.command, apiDiff.stdout || "(no changes)");
				const apiChanged = apiDiff.stdout.length > 0;

				return textResult(
					formatApplyResult({
						trace,
						result,
						apiChanged,
						apiDiff: apiDiff.stdout,
					}),
				);
			},
		},
	];

	return tools;
}
