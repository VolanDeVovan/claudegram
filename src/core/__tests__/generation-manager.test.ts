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

	test("diff shows changes between generations", () => {
		const gm = new GenerationManager(GEN_DIR, PLUGINS_DIR);
		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// v1");
		gm.create("v1");

		writeFileSync(join(PLUGINS_DIR, "a.ts"), "// v2");
		writeFileSync(join(PLUGINS_DIR, "b.ts"), "// new");
		gm.create("v2");

		const diff = gm.diff(1, 2);
		expect(diff).toContain("a.ts");
		expect(diff).toContain("b.ts");
		expect(diff).toContain("modified");
		expect(diff).toContain("added");
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
