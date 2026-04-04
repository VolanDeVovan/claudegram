import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JsonScopeStore } from "../scope-store.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-scope");

beforeEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("JsonScopeStore", () => {
	test("get returns null for missing key", async () => {
		const store = new JsonScopeStore(TEST_DIR);
		expect(await store.get("user-1", "foo")).toBeNull();
	});

	test("set and get a value", async () => {
		const store = new JsonScopeStore(TEST_DIR);
		await store.set("user-1", "active_project", "backend");
		expect(await store.get("user-1", "active_project")).toBe("backend");
	});

	test("delete removes a key", async () => {
		const store = new JsonScopeStore(TEST_DIR);
		await store.set("user-1", "key1", "value1");
		await store.delete("user-1", "key1");
		expect(await store.get("user-1", "key1")).toBeNull();
	});

	test("scopes are isolated", async () => {
		const store = new JsonScopeStore(TEST_DIR);
		await store.set("user-1", "project", "a");
		await store.set("user-2", "project", "b");
		expect(await store.get("user-1", "project")).toBe("a");
		expect(await store.get("user-2", "project")).toBe("b");
	});

	test("stores complex values", async () => {
		const store = new JsonScopeStore(TEST_DIR);
		const prefs = { theme: "dark", lang: "en" };
		await store.set("user-1", "preferences", prefs);
		expect(await store.get("user-1", "preferences")).toEqual(prefs);
	});

	test("persists to disk", async () => {
		const store1 = new JsonScopeStore(TEST_DIR);
		await store1.set("user-1", "key", "persisted");

		// New store instance reads from disk
		const store2 = new JsonScopeStore(TEST_DIR);
		expect(await store2.get("user-1", "key")).toBe("persisted");
	});

	test("creates file per scope", async () => {
		const store = new JsonScopeStore(TEST_DIR);
		await store.set("user-1", "a", 1);
		await store.set("user-2", "b", 2);

		expect(existsSync(join(TEST_DIR, "user-1.json"))).toBe(true);
		expect(existsSync(join(TEST_DIR, "user-2.json"))).toBe(true);
	});
});
