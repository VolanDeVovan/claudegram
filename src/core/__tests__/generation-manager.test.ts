import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import { GenerationManager } from "../generation-manager.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-gen");
const GEN_DIR = join(TEST_DIR, "generations");
const PLUGINS_DIR = join(TEST_DIR, "plugins");

beforeEach(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(PLUGINS_DIR, { recursive: true });
	await configure({ sinks: {}, loggers: [], reset: true });
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("GenerationManager", () => {
	test("creates generation snapshot", () => {
		writeFileSync(join(PLUGINS_DIR, "test.ts"), "export default {}");
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		const num = gm.create("test generation");
		expect(num).toBe(1);
		expect(gm.getCurrent()).toBe(1);

		const gens = gm.list();
		expect(gens).toHaveLength(1);
		expect(gens[0]?.description).toBe("test generation");
		expect(gens[0]?.plugins).toContain("test");
	});

	test("creates multiple generations", () => {
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "export default {}");
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);

		gm.create("first");
		writeFileSync(join(PLUGINS_DIR, "b.ts"), "export default {}");
		gm.create("second");

		expect(gm.getCurrent()).toBe(2);
		expect(gm.list()).toHaveLength(2);
	});

	test("rollback restores plugins", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// version 1");
		gm.create("v1");

		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// version 2");
		writeFileSync(join(PLUGINS_DIR, "b.ts"), "// new file");
		gm.create("v2");

		// Rollback to v1
		gm.rollback(1);
		expect(gm.getCurrent()).toBe(1);
		expect(readFileSync(join(PLUGINS_DIR, "a.ts"), "utf-8")).toBe(
			"// version 1",
		);
		expect(existsSync(join(PLUGINS_DIR, "b.ts"))).toBe(false);
	});

	test("diff shows unified diff between two generations", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// v1\n");
		gm.create("v1");

		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// v2\n");
		gm.create("v2");

		const diff = gm.diff(1, 2);
		expect(diff).toContain("--- gen-1/plugins/a.ts");
		expect(diff).toContain("+++ gen-2/plugins/a.ts");
		expect(diff).toContain("@@");
		expect(diff).toContain("-// v1");
		expect(diff).toContain("+// v2");
	});

	test("diff shows content for added and removed files", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		writeFileSync(join(PLUGINS_DIR, "old.ts"), "// old\n");
		gm.create("v1");

		rmSync(join(PLUGINS_DIR, "old.ts"));
		writeFileSync(join(PLUGINS_DIR, "new.ts"), "// new\n");
		gm.create("v2");

		const diff = gm.diff(1, 2);
		expect(diff).toContain("+// new");
		expect(diff).toContain("-// old");
	});

	test("diff returns no changes for identical generations", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// same\n");
		gm.create("v1");
		gm.create("v2");

		expect(gm.diff(1, 2)).toBe("No changes");
	});

	test("diff compares generation against current plugins/ when to is omitted", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// v1\n");
		gm.create("v1");

		// Edit live plugins without creating a generation
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// v2 live\n");

		const diff = gm.diff(1);
		expect(diff).toContain("--- gen-1/plugins/a.ts");
		expect(diff).toContain("+++ plugins (current)/a.ts");
		expect(diff).toContain("-// v1");
		expect(diff).toContain("+// v2 live");
	});

	test("diff with no args compares first generation vs current", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// original\n");
		gm.create("v1");

		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// latest\n");
		gm.create("v2");

		// Edit live
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// live edit\n");

		const diff = gm.diff();
		expect(diff).toContain("--- gen-1/plugins/a.ts");
		expect(diff).toContain("plugins (current)/a.ts");
		expect(diff).toContain("-// original");
		expect(diff).toContain("+// live edit");
	});

	test("diff handles directory-based plugins", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		mkdirSync(join(PLUGINS_DIR, "myplugin"), { recursive: true });
		writeFileSync(join(PLUGINS_DIR, "myplugin", "index.ts"), "// v1\n");
		writeFileSync(join(PLUGINS_DIR, "myplugin", "utils.ts"), "// utils\n");
		gm.create("v1");

		writeFileSync(join(PLUGINS_DIR, "myplugin", "index.ts"), "// v2\n");
		gm.create("v2");

		const diff = gm.diff(1, 2);
		expect(diff).toContain("myplugin/index.ts");
		expect(diff).toContain("-// v1");
		expect(diff).toContain("+// v2");
		// utils.ts unchanged — should NOT appear
		expect(diff).not.toContain("utils.ts");
	});

	test("rollback to nonexistent generation throws", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		expect(() => gm.rollback(999)).toThrow("Generation 999 not found");
	});

	test("getCurrent returns 0 when no generations", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		expect(gm.getCurrent()).toBe(0);
	});
});
