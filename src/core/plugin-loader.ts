import { existsSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { Composer } from "grammy";
import type { ConfigManager } from "./config.ts";
import type { BotContext, Plugin, PluginContext } from "./plugin-api.ts";

const log = getLogger(["bot", "plugin-loader"]);

/**
 * Evict all plugin files from Bun's module cache.
 *
 * Bun ignores query-string cache busters on file:// URLs,
 * so we clear require.cache entries for the entire plugins directory
 * before re-importing. This covers single-file plugins, directory
 * plugins, and their nested dependencies.
 */
function evictPluginCache(pluginsDir: string): void {
	const absolute = resolve(pluginsDir);
	let evicted = 0;
	for (const key of Object.keys(require.cache)) {
		if (key.startsWith(absolute)) {
			delete require.cache[key];
			evicted++;
		}
	}
	if (evicted > 0) {
		log.info("Evicted {count} modules from cache", { count: evicted });
	}
}

function discoverPluginPaths(pluginsDir: string): string[] {
	if (!existsSync(pluginsDir)) return [];
	const entries = readdirSync(pluginsDir, { withFileTypes: true });
	const paths: string[] = [];

	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		const full = join(pluginsDir, entry.name);
		if (entry.isFile() && extname(entry.name) === ".ts") {
			paths.push(full);
		} else if (entry.isDirectory()) {
			const index = join(full, "index.ts");
			if (existsSync(index)) paths.push(index);
		}
	}
	return paths;
}

export interface LoadedPlugins {
	plugins: Plugin[];
	errors: Array<{ path: string; error: string }>;
	resolveTarget: Plugin["resolveTarget"] | null;
	approvalHandlers: Array<{
		priority: number;
		handler: NonNullable<Plugin["approvalHandler"]>;
	}>;
	authChecks: Array<{
		plugin: Plugin;
		check: NonNullable<Plugin["authCheck"]>;
	}>;
	afterQueryHooks: Array<{
		priority: number;
		handler: NonNullable<Plugin["afterQuery"]>;
	}>;
	renderMiddlewares: Array<{
		priority: number;
		handler: NonNullable<Plugin["renderMiddleware"]>;
	}>;
	tools: Array<{ plugin: string; tool: NonNullable<Plugin["tools"]>[number] }>;
	commands: Map<
		string,
		{
			plugin: string;
			handler: (ctx: BotContext) => void | Promise<void>;
			description?: string;
		}
	>;
}

export async function loadPlugins(
	pluginsDir: string,
	pluginCtx: PluginContext,
	config: ConfigManager,
): Promise<LoadedPlugins> {
	const paths = discoverPluginPaths(pluginsDir);
	const result: LoadedPlugins = {
		plugins: [],
		errors: [],
		resolveTarget: null,
		approvalHandlers: [],
		authChecks: [],
		afterQueryHooks: [],
		renderMiddlewares: [],
		tools: [],
		commands: new Map(),
	};

	evictPluginCache(pluginsDir);

	const loaded: Array<{ plugin: Plugin; path: string }> = [];

	for (const path of paths) {
		try {
			const mod = (await import(resolve(path))) as { default: Plugin };
			const plugin = mod.default;
			if (!plugin?.name) {
				result.errors.push({ path, error: "Missing plugin name" });
				log.warn("Plugin at {path} skipped: missing name", { path });
				continue;
			}
			loaded.push({ plugin, path });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			result.errors.push({ path, error: msg });
			log.error("Plugin at {path} failed to import: {error}", {
				path,
				error: msg,
			});
		}
	}

	// Sort by priority (lower = earlier)
	loaded.sort((a, b) => (a.plugin.priority ?? 50) - (b.plugin.priority ?? 50));

	for (const { plugin, path } of loaded) {
		try {
			// Register plugin config schema
			if (plugin.configSchema) {
				config.registerPluginSchema(plugin.name, plugin.configSchema);
			}

			// Call register() with AbortSignal — plugin can check signal.aborted
			// to bail out of long operations. We also race against a timeout so
			// a plugin that ignores the signal can't hang the loader.
			if (plugin.register) {
				const signal = AbortSignal.timeout(5000);
				const timeout = new Promise<"timeout">((resolve) => {
					signal.addEventListener("abort", () => resolve("timeout"), {
						once: true,
					});
				});
				const winner = await Promise.race([
					plugin.register(pluginCtx, signal),
					timeout,
				]);
				if (winner === "timeout") {
					log.warn("Plugin {plugin}: register() timed out", {
						plugin: plugin.name,
					});
					continue;
				}
			}

			// Collect exclusive hooks
			if (plugin.resolveTarget) {
				if (result.resolveTarget) {
					log.warn(
						"Plugin {plugin} skipped: resolveTarget already registered",
						{ plugin: plugin.name },
					);
					continue;
				}
				result.resolveTarget = plugin.resolveTarget;
			}

			// Chain hooks
			if (plugin.approvalHandler) {
				result.approvalHandlers.push({
					priority: plugin.priority ?? 50,
					handler: plugin.approvalHandler,
				});
			}

			if (plugin.authCheck) {
				result.authChecks.push({ plugin, check: plugin.authCheck });
			}

			// Collect afterQuery hooks
			if (plugin.afterQuery) {
				result.afterQueryHooks.push({
					priority: plugin.priority ?? 50,
					handler: plugin.afterQuery,
				});
			}

			// Collect render middlewares (+ auto-wrap deprecated responseRenderer)
			if (plugin.responseRenderer && !plugin.renderMiddleware) {
				log.warn(
					"Plugin {plugin}: responseRenderer is deprecated, use renderMiddleware",
					{ plugin: plugin.name },
				);
				const renderer = plugin.responseRenderer;
				result.renderMiddlewares.push({
					priority: plugin.priority ?? 50,
					handler: (events, target, bot, _next) =>
						renderer(events, target, bot),
				});
			}
			if (plugin.renderMiddleware) {
				result.renderMiddlewares.push({
					priority: plugin.priority ?? 50,
					handler: plugin.renderMiddleware,
				});
			}

			// Collect tools
			if (plugin.tools) {
				for (const tool of plugin.tools) {
					result.tools.push({ plugin: plugin.name, tool });
				}
			}

			// Collect commands
			if (plugin.commands) {
				for (const [name, def] of Object.entries(plugin.commands)) {
					const handler = typeof def === "function" ? def : def.handler;
					const description =
						typeof def === "function" ? undefined : def.description;
					result.commands.set(name, {
						plugin: plugin.name,
						handler,
						description,
					});
				}
			}

			result.plugins.push(plugin);
			log.info("Plugin {plugin} loaded (priority: {priority})", {
				plugin: plugin.name,
				priority: plugin.priority ?? 50,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			result.errors.push({ path, error: msg });
			log.error("Plugin {plugin} failed in register: {error}", {
				plugin: plugin.name,
				error: msg,
			});
		}
	}

	// Sort by priority
	result.approvalHandlers.sort((a, b) => a.priority - b.priority);
	result.afterQueryHooks.sort((a, b) => a.priority - b.priority);
	result.renderMiddlewares.sort((a, b) => a.priority - b.priority);

	log.info("Loaded {count} plugins: {names}", {
		count: result.plugins.length,
		names: result.plugins
			.map((p) => `${p.name} (p:${p.priority ?? 50})`)
			.join(", "),
	});

	return result;
}

export function buildMiddleware(loaded: LoadedPlugins): Composer<BotContext> {
	const composer = new Composer<BotContext>();

	// Register plugin middleware — errors propagate naturally.
	// Plugins must handle their own errors (swallowing + calling next()
	// is dangerous: auth middleware that throws = error swallowed = access granted).
	for (const plugin of loaded.plugins) {
		if (plugin.middleware) {
			for (const mw of plugin.middleware) {
				composer.use(mw);
			}
		}
	}

	// Register commands from plugins
	for (const [name, { plugin, handler }] of loaded.commands) {
		composer.command(name, async (ctx) => {
			try {
				await handler(ctx);
			} catch (e) {
				log.error("Plugin {plugin} command /{name} error: {error}", {
					plugin,
					name,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		});
	}

	// Register handlers (grammy filter queries)
	for (const plugin of loaded.plugins) {
		if (plugin.handlers) {
			for (const [filterQuery, handler] of Object.entries(plugin.handlers)) {
				composer.on(
					filterQuery as Parameters<typeof composer.on>[0],
					async (ctx) => {
						try {
							await handler(ctx);
						} catch (e) {
							log.error("Plugin {plugin} handler {filter} error: {error}", {
								plugin: plugin.name,
								filter: filterQuery,
								error: e instanceof Error ? e.message : String(e),
							});
						}
					},
				);
			}
		}
	}

	return composer;
}

export async function disposePlugins(plugins: Plugin[]): Promise<void> {
	for (const plugin of plugins) {
		if (plugin.dispose) {
			try {
				await plugin.dispose();
				log.info("Plugin {plugin} disposed", { plugin: plugin.name });
			} catch (e) {
				log.error("Plugin {plugin} dispose error: {error}", {
					plugin: plugin.name,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}
}
