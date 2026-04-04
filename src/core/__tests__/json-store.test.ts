import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JsonStore } from "../json-store.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-json-store");

beforeEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("JsonStore", () => {
	test("returns default value when file does not exist", async () => {
		const store = new JsonStore(join(TEST_DIR, "missing.json"), { count: 0 });
		expect(await store.read()).toEqual({ count: 0 });
	});

	test("update writes and caches", async () => {
		const path = join(TEST_DIR, "data.json");
		const store = new JsonStore(path, { count: 0 });

		await store.update((d) => ({ count: d.count + 1 }));
		expect(await store.read()).toEqual({ count: 1 });

		// Verify persisted to disk
		const raw = JSON.parse(await Bun.file(path).text());
		expect(raw.count).toBe(1);
	});

	test("serializes concurrent writes", async () => {
		const path = join(TEST_DIR, "concurrent.json");
		const store = new JsonStore(path, { count: 0 });

		// Launch multiple concurrent updates
		const promises = Array.from({ length: 10 }, (_, i) =>
			store.update((d) => ({ count: d.count + 1 })),
		);
		await Promise.all(promises);

		expect(await store.read()).toEqual({ count: 10 });
	});

	test("works with arrays", async () => {
		const path = join(TEST_DIR, "array.json");
		const store = new JsonStore<string[]>(path, []);

		await store.update((arr) => [...arr, "a"]);
		await store.update((arr) => [...arr, "b"]);

		expect(await store.read()).toEqual(["a", "b"]);
	});

	test("new instance reads from disk", async () => {
		const path = join(TEST_DIR, "persist.json");
		const store1 = new JsonStore(path, { value: "" });
		await store1.update(() => ({ value: "hello" }));

		const store2 = new JsonStore(path, { value: "" });
		expect(await store2.read()).toEqual({ value: "hello" });
	});
});
