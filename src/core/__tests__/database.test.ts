import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import { initDatabase } from "../database.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-db");
const DB_PATH = join(TEST_DIR, "test.db");

beforeEach(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	await configure({ sinks: {}, loggers: [], reset: true });
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Database", () => {
	test("creates database and runs migrations", () => {
		const db = initDatabase(DB_PATH);
		expect(existsSync(DB_PATH)).toBe(true);

		// Check tables exist
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all()
			.map((r) => r.name);

		expect(tables).toContain("sessions");
		expect(tables).toContain("user_state");
		expect(tables).toContain("schema_version");
	});

	test("migrations are idempotent", () => {
		const db1 = initDatabase(DB_PATH);
		db1.close();
		// Running again should not fail
		const db2 = initDatabase(DB_PATH);

		const version = db2
			.query<{ version: number }, []>(
				"SELECT MAX(version) as version FROM schema_version",
			)
			.get();
		expect(version?.version).toBeGreaterThan(0);
		db2.close();
	});

	test("can insert and query sessions", () => {
		const db = initDatabase(DB_PATH);
		const now = new Date().toISOString();

		db.query(
			"INSERT INTO sessions (id, user_id, project_name, created_at, last_used) VALUES (?, ?, ?, ?, ?)",
		).run("session-1", "user-1", "self", now, now);

		const row = db
			.query<{ id: string; user_id: string }, [string]>(
				"SELECT * FROM sessions WHERE id = ?",
			)
			.get("session-1");

		expect(row?.id).toBe("session-1");
		expect(row?.user_id).toBe("user-1");
		db.close();
	});

	test("can insert and query user_state", () => {
		const db = initDatabase(DB_PATH);

		db.query(
			"INSERT INTO user_state (user_id, active_project) VALUES (?, ?)",
		).run("user-1", "api-backend");

		const row = db
			.query<{ active_project: string }, [string]>(
				"SELECT active_project FROM user_state WHERE user_id = ?",
			)
			.get("user-1");

		expect(row?.active_project).toBe("api-backend");
		db.close();
	});
});
