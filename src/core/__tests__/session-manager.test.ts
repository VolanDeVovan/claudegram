import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import { ConfigManager } from "../config.ts";
import { SessionManager } from "../session-manager.ts";

const TEST_DIR = join(import.meta.dir, ".test-data-session");
const SESSIONS_PATH = join(TEST_DIR, "sessions.json");
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
			sessionTimeoutHours: 24,
			plugins: {},
		}),
	);
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("SessionManager", () => {
	test("creates and retrieves session", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		await sm.createSession("sess-1", "user-1", "self");
		const active = await sm.getActive("user-1", "self");
		expect(active).not.toBeNull();
		expect(active?.id).toBe("sess-1");
		expect(active?.projectName).toBe("self");
		expect(active?.isActive).toBe(true);
	});

	test("deactivates session on clearSession", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		await sm.createSession("sess-1", "user-1", "self");
		await sm.clearSession("user-1", "self");
		expect(await sm.getActive("user-1", "self")).toBeNull();
	});

	test("lists sessions for scope", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		await sm.createSession("sess-1", "user-1", "self");
		await sm.createSession("sess-2", "user-1", "api");
		const list = await sm.list("user-1");
		expect(list).toHaveLength(2);
	});

	test("activate switches active session", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		await sm.createSession("sess-1", "user-1", "self");
		await sm.clearSession("user-1", "self");
		await sm.createSession("sess-2", "user-1", "self");

		// sess-2 is active now
		expect((await sm.getActive("user-1", "self"))?.id).toBe("sess-2");

		// Activate sess-1
		await sm.activate("sess-1");
		expect((await sm.getActive("user-1", "self"))?.id).toBe("sess-1");
	});

	test("updateSession modifies turns and cost", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		await sm.createSession("sess-1", "user-1", "self");
		await sm.updateSession("sess-1", 5, 0.05);

		const session = await sm.getActive("user-1", "self");
		expect(session?.turns).toBe(5);
		expect(session?.costUsd).toBeCloseTo(0.05);
	});

	test("cancelQuery returns false when no active query", () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		expect(sm.cancelQuery("user-1", "self")).toBe(false);
	});

	test("withSessionLock provides abort signal", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		let receivedSignal = false;
		await sm.withSessionLock("user-1", "self", async (signal) => {
			receivedSignal = signal instanceof AbortSignal;
		});
		expect(receivedSignal).toBe(true);
	});

	test("withSessionLock serializes calls for same key", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

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
	});

	test("different scopes are isolated", async () => {
		const config = new ConfigManager(CONFIG_PATH);
		const sm = new SessionManager(SESSIONS_PATH, config);

		await sm.createSession("sess-1", "user-1", "self");
		await sm.createSession("sess-2", "chat-123:user-1", "self");

		expect(await sm.list("user-1")).toHaveLength(1);
		expect(await sm.list("chat-123:user-1")).toHaveLength(1);
		expect((await sm.getActive("user-1", "self"))?.id).toBe("sess-1");
		expect((await sm.getActive("chat-123:user-1", "self"))?.id).toBe("sess-2");
	});
});
