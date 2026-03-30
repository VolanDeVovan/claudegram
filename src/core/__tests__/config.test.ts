import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import { ConfigManager } from "../config.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-config");
const CONFIG_PATH = join(TEST_DIR, "config.jsonc");

beforeEach(async () => {
	mkdirSync(TEST_DIR, { recursive: true });
	await configure({ sinks: {}, loggers: [], reset: true });
	writeFileSync(
		CONFIG_PATH,
		`{
  // Test config
  "botToken": "test-token",
  "owner": "123456",
  "projects": [{"name": "self", "path": "/tmp/test"}],
  "defaultProject": "self",
  "model": "claude-sonnet-4",
  "maxTurns": 10,
  "sessionTimeoutHours": 24,
  "plugins": {}
}`,
	);
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("ConfigManager", () => {
	test("loads and parses config", () => {
		const config = new ConfigManager(CONFIG_PATH);
		expect(config.data.botToken).toBe("test-token");
		expect(config.data.owner).toBe("123456");
		expect(config.data.model).toBe("claude-sonnet-4");
		expect(config.data.projects).toHaveLength(1);
		expect(config.data.projects[0]?.name).toBe("self");
	});

	test("get by key path", () => {
		const config = new ConfigManager(CONFIG_PATH);
		expect(config.get<string>("owner")).toBe("123456");
		expect(config.get<string>("model")).toBe("claude-sonnet-4");
		expect(config.get<unknown[]>("projects")).toHaveLength(1);
	});

	test("get nested key path", () => {
		const config = new ConfigManager(CONFIG_PATH);
		expect(config.get<Record<string, unknown>>("plugins")).toEqual({});
	});

	test("set updates config and preserves comments", () => {
		const config = new ConfigManager(CONFIG_PATH);
		config.set("model", "claude-opus-4");
		expect(config.data.model).toBe("claude-opus-4");

		// Re-read from file
		const config2 = new ConfigManager(CONFIG_PATH);
		expect(config2.data.model).toBe("claude-opus-4");

		// Check comments preserved
		const { readFileSync } = require("node:fs");
		const content = readFileSync(CONFIG_PATH, "utf-8");
		expect(content).toContain("// Test config");
	});

	test("set validates values", () => {
		const config = new ConfigManager(CONFIG_PATH);
		// maxTurns must be a number
		expect(() => config.set("maxTurns", "not a number")).toThrow();
	});

	test("getSchema returns field descriptions", () => {
		const config = new ConfigManager(CONFIG_PATH);
		const schema = config.getSchema();
		expect(schema.botToken).toContain("string");
		expect(schema.model).toContain("string");
		expect(schema.maxTurns).toContain("number");
	});

	test("static exists works", () => {
		expect(ConfigManager.exists(CONFIG_PATH)).toBe(true);
		expect(ConfigManager.exists("/nonexistent/path")).toBe(false);
	});

	test("static create writes config file", () => {
		const newPath = join(TEST_DIR, "new-config.jsonc");
		ConfigManager.create(newPath, {
			botToken: "new-token",
			owner: "999",
			projects: [{ name: "self", path: "/tmp" }],
		});
		expect(existsSync(newPath)).toBe(true);
		const config = new ConfigManager(newPath);
		expect(config.data.botToken).toBe("new-token");
		expect(config.data.owner).toBe("999");
	});

	test("reload re-reads from disk", () => {
		const config = new ConfigManager(CONFIG_PATH);
		expect(config.data.model).toBe("claude-sonnet-4");

		// Modify file externally
		config.set("model", "claude-opus-4");
		const config2 = new ConfigManager(CONFIG_PATH);
		expect(config2.data.model).toBe("claude-opus-4");

		config2.reload();
		expect(config2.data.model).toBe("claude-opus-4");
	});
});
