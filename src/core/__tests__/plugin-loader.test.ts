import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import type { PluginContext } from "../plugin-api.ts";
import {
	buildMiddleware,
	disposePlugins,
	loadPlugins,
} from "../plugin-loader.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-plugins");
const PLUGINS_DIR = join(TEST_DIR, "plugins");

const mockPluginCtx = {
	bot: {} as any,
	config: { registerPluginSchema: () => {} } as any,
	db: {} as any,
	query: (() => {}) as any,
	sessions: {} as any,
} satisfies PluginContext;

const mockConfig = {
	registerPluginSchema: () => {},
} as any;

beforeEach(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(PLUGINS_DIR, { recursive: true });
	await configure({ sinks: {}, loggers: [], reset: true });
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Plugin Loader", () => {
	test("loads plugin from .ts file", async () => {
		writeFileSync(
			join(PLUGINS_DIR, "test-plugin.ts"),
			`export default {
				name: "test-plugin",
				description: "A test plugin",
				priority: 30,
			};`,
		);

		const loaded = await loadPlugins(PLUGINS_DIR, mockPluginCtx, mockConfig);
		expect(loaded.plugins).toHaveLength(1);
		expect(loaded.plugins[0]!.name).toBe("test-plugin");
		expect(loaded.errors).toHaveLength(0);
	});

	test("sorts plugins by priority", async () => {
		writeFileSync(
			join(PLUGINS_DIR, "a.ts"),
			`export default { name: "a", priority: 50 };`,
		);
		writeFileSync(
			join(PLUGINS_DIR, "b.ts"),
			`export default { name: "b", priority: 10 };`,
		);
		writeFileSync(
			join(PLUGINS_DIR, "c.ts"),
			`export default { name: "c", priority: 30 };`,
		);

		const loaded = await loadPlugins(PLUGINS_DIR, mockPluginCtx, mockConfig);
		expect(loaded.plugins.map((p) => p.name)).toEqual(["b", "c", "a"]);
	});

	test("skips plugin without name", async () => {
		writeFileSync(
			join(PLUGINS_DIR, "bad.ts"),
			`export default { description: "no name" };`,
		);

		const loaded = await loadPlugins(PLUGINS_DIR, mockPluginCtx, mockConfig);
		expect(loaded.plugins).toHaveLength(0);
		expect(loaded.errors).toHaveLength(1);
	});

	test("collects commands from plugins", async () => {
		writeFileSync(
			join(PLUGINS_DIR, "cmd.ts"),
			`export default {
				name: "cmd-plugin",
				commands: {
					hello: async (ctx) => {},
					world: {
						description: "World command",
						handler: async (ctx) => {},
					},
				},
			};`,
		);

		const loaded = await loadPlugins(PLUGINS_DIR, mockPluginCtx, mockConfig);
		expect(loaded.commands.has("hello")).toBe(true);
		expect(loaded.commands.has("world")).toBe(true);
		expect(loaded.commands.get("world")!.description).toBe("World command");
	});

	test("collects authCheck hooks", async () => {
		writeFileSync(
			join(PLUGINS_DIR, "auth.ts"),
			`export default {
				name: "auth",
				authCheck: (userId, cfg, ctx) => userId === "allowed",
			};`,
		);

		const loaded = await loadPlugins(PLUGINS_DIR, mockPluginCtx, mockConfig);
		expect(loaded.authChecks).toHaveLength(1);
	});

	test("handles plugins without name gracefully", async () => {
		writeFileSync(
			join(PLUGINS_DIR, "broken.ts"),
			`export default { description: "no name field" };`,
		);

		const loaded = await loadPlugins(PLUGINS_DIR, mockPluginCtx, mockConfig);
		expect(loaded.plugins).toHaveLength(0);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]!.error).toContain("Missing plugin name");
	});

	test("calls dispose on plugins", async () => {
		let disposed = false;
		const plugins = [
			{
				name: "disposable",
				dispose: async () => {
					disposed = true;
				},
			},
		];

		await disposePlugins(plugins);
		expect(disposed).toBe(true);
	});

	test("builds middleware composer from plugins", async () => {
		writeFileSync(
			join(PLUGINS_DIR, "mw.ts"),
			`export default {
				name: "mw-plugin",
				middleware: [async (ctx, next) => { await next(); }],
			};`,
		);

		const loaded = await loadPlugins(PLUGINS_DIR, mockPluginCtx, mockConfig);
		const composer = buildMiddleware(loaded);
		// Composer should be created without errors
		expect(composer).toBeDefined();
		expect(composer.middleware).toBeDefined();
	});

	test("returns empty result for nonexistent plugins dir", async () => {
		const loaded = await loadPlugins(
			"/nonexistent/dir",
			mockPluginCtx,
			mockConfig,
		);
		expect(loaded.plugins).toHaveLength(0);
		expect(loaded.errors).toHaveLength(0);
	});
});
