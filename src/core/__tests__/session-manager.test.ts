import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import { ConfigManager } from "../config.ts";
import { initDatabase } from "../database.ts";
import { SessionManager } from "../session-manager.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-session");
const DB_PATH = join(TEST_DIR, "test.db");
const CONFIG_PATH = join(TEST_DIR, "config.jsonc");

beforeEach(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	await configure({ sinks: {}, loggers: [], reset: true });
	writeFileSync(
		CONFIG_PATH,
		JSON.stringify({
			botToken: "test",
			owner: "123",
			projects: [{ name: "self", path: "/tmp" }],
			defaultProject: "self",
			model: "claude-sonnet-4",
			maxTurns: 10,
			maxSessionsPerUser: 10,
			sessionTimeoutHours: 24,
			plugins: {},
		}),
	);
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("SessionManager", () => {
	test("creates and retrieves session", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		sm.createSession("sess-1", "user-1", "self");
		const active = sm.getActive("user-1", "self");
		expect(active).not.toBeNull();
		expect(active!.id).toBe("sess-1");
		expect(active!.projectName).toBe("self");
		expect(active!.isActive).toBe(true);
		db.close();
	});

	test("deactivates session on clearSession", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		sm.createSession("sess-1", "user-1", "self");
		sm.clearSession("user-1", "self");
		expect(sm.getActive("user-1", "self")).toBeNull();
		db.close();
	});

	test("lists sessions for user", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		sm.createSession("sess-1", "user-1", "self");
		sm.createSession("sess-2", "user-1", "api");
		const list = sm.list("user-1");
		expect(list).toHaveLength(2);
		db.close();
	});

	test("activate switches active session", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		sm.createSession("sess-1", "user-1", "self");
		sm.clearSession("user-1", "self");
		sm.createSession("sess-2", "user-1", "self");

		// sess-2 is active now
		expect(sm.getActive("user-1", "self")!.id).toBe("sess-2");

		// Activate sess-1
		sm.activate("sess-1");
		expect(sm.getActive("user-1", "self")!.id).toBe("sess-1");
		db.close();
	});

	test("getActiveProject returns default when no state", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		expect(sm.getActiveProject("user-1")).toBe("self");
		db.close();
	});

	test("setActiveProject persists", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		sm.setActiveProject("user-1", "api-backend");
		expect(sm.getActiveProject("user-1")).toBe("api-backend");
		db.close();
	});

	test("updateSession modifies turns and cost", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		sm.createSession("sess-1", "user-1", "self");
		sm.updateSession("sess-1", 5, 0.05);

		const session = sm.getActive("user-1", "self");
		expect(session!.turns).toBe(5);
		expect(session!.costUsd).toBeCloseTo(0.05);
		db.close();
	});

	test("cancelQuery returns false when no active query", () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		expect(sm.cancelQuery("user-1", "self")).toBe(false);
		db.close();
	});

	test("withSessionLock provides abort signal", async () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		let receivedSignal = false;
		await sm.withSessionLock("user-1", "self", async (signal) => {
			receivedSignal = signal instanceof AbortSignal;
		});
		expect(receivedSignal).toBe(true);
		db.close();
	});

	test("withSessionLock serializes calls for same key", async () => {
		const db = initDatabase(DB_PATH);
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(db, config);

		const order: number[] = [];

		const p1 = sm.withSessionLock("user-1", "self", async () => {
			await new Promise((r) => setTimeout(r, 50));
			order.push(1);
		});
		const p2 = sm.withSessionLock("user-1", "self", async () => {
			order.push(2);
		});

		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
		db.close();
	});
});
