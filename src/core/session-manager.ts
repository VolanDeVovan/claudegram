import type { Database } from "bun:sqlite";
import { getLogger } from "@logtape/logtape";
import type { ConfigManager } from "./config.ts";
import type { MessageChannel } from "./message-channel.ts";
import type { SessionAPI, SessionInfo } from "./plugin-api.ts";

const log = getLogger(["bot", "session"]);

export class SessionManager implements SessionAPI {
	private db: Database;
	private config: ConfigManager;
	private sessionLocks = new Map<string, Promise<void>>();
	private activeControllers = new Map<string, AbortController>();
	private activeChannels = new Map<string, MessageChannel>();

	constructor(db: Database, config: ConfigManager) {
		this.db = db;
		this.config = config;
	}

	private lockKey(userId: string, project: string): string {
		return `${userId}:${project}`;
	}

	private isExpired(lastUsed: string): boolean {
		const hours = (Date.now() - new Date(lastUsed).getTime()) / 3600_000;
		return hours > this.config.data.sessionTimeoutHours;
	}

	// ── SessionAPI ──

	list(userId: string, projectName?: string): SessionInfo[] {
		const query = projectName
			? this.db
					.query<SessionRow, [string, string]>(
						"SELECT * FROM sessions WHERE user_id = ? AND project_name = ? ORDER BY last_used DESC",
					)
					.all(userId, projectName)
			: this.db
					.query<SessionRow, [string]>(
						"SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used DESC",
					)
					.all(userId);

		return query.map(rowToInfo);
	}

	activate(sessionId: string): void {
		const session = this.db
			.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
			.get(sessionId);
		if (!session) throw new Error(`Session ${sessionId} not found`);

		// Deactivate current active session for this user+project
		this.db
			.query(
				"UPDATE sessions SET is_active = 0 WHERE user_id = ? AND project_name = ? AND is_active = 1",
			)
			.run(session.user_id, session.project_name);

		// Activate target
		this.db
			.query("UPDATE sessions SET is_active = 1, last_used = ? WHERE id = ?")
			.run(new Date().toISOString(), sessionId);

		log.info("Session {id} activated for user {user} project {project}", {
			id: sessionId,
			user: session.user_id,
			project: session.project_name,
		});
	}

	getActive(userId: string, projectName: string): SessionInfo | null {
		const row = this.db
			.query<SessionRow, [string, string]>(
				"SELECT * FROM sessions WHERE user_id = ? AND project_name = ? AND is_active = 1",
			)
			.get(userId, projectName);
		return row ? rowToInfo(row) : null;
	}

	// ── Session lifecycle ──

	getActiveSessionId(userId: string, projectName: string): string | null {
		const row = this.db
			.query<SessionRow, [string, string]>(
				"SELECT * FROM sessions WHERE user_id = ? AND project_name = ? AND is_active = 1",
			)
			.get(userId, projectName);

		if (!row) return null;
		if (this.isExpired(row.last_used)) {
			this.deactivateSession(row.id);
			log.info("Session {id} expired", { id: row.id });
			return null;
		}
		return row.id;
	}

	deactivateSession(sessionId: string): void {
		this.db
			.query("UPDATE sessions SET is_active = 0 WHERE id = ?")
			.run(sessionId);
	}

	createSession(sessionId: string, userId: string, projectName: string): void {
		const now = new Date().toISOString();
		// Deactivate any existing active session
		this.db
			.query(
				"UPDATE sessions SET is_active = 0 WHERE user_id = ? AND project_name = ? AND is_active = 1",
			)
			.run(userId, projectName);
		this.db
			.query(
				"INSERT INTO sessions (id, user_id, project_name, created_at, last_used, turns, cost_usd, is_active) VALUES (?, ?, ?, ?, ?, 0, 0, 1)",
			)
			.run(sessionId, userId, projectName, now, now);
		log.info("Session {id} created for user {user} project {project}", {
			id: sessionId,
			user: userId,
			project: projectName,
		});
	}

	updateSession(sessionId: string, turns: number, costUsd: number): void {
		this.db
			.query(
				"UPDATE sessions SET last_used = ?, turns = ?, cost_usd = ? WHERE id = ?",
			)
			.run(new Date().toISOString(), turns, costUsd, sessionId);
	}

	clearSession(userId: string, projectName: string): void {
		this.db
			.query(
				"UPDATE sessions SET is_active = 0 WHERE user_id = ? AND project_name = ? AND is_active = 1",
			)
			.run(userId, projectName);
		log.info("Session cleared for user {user} project {project}", {
			user: userId,
			project: projectName,
		});
	}

	// ── User state ──

	getActiveProject(userId: string): string {
		const row = this.db
			.query<{ active_project: string }, [string]>(
				"SELECT active_project FROM user_state WHERE user_id = ?",
			)
			.get(userId);
		return row?.active_project ?? this.config.data.defaultProject;
	}

	setActiveProject(userId: string, project: string): void {
		this.db
			.query(
				"INSERT INTO user_state (user_id, active_project) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET active_project = ?",
			)
			.run(userId, project, project);
	}

	// ── Concurrency ──

	async withSessionLock<T>(
		userId: string,
		project: string,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const key = this.lockKey(userId, project);
		const controller = new AbortController();
		this.activeControllers.set(key, controller);

		const prev = this.sessionLocks.get(key) ?? Promise.resolve();
		const execute = async (): Promise<T> => {
			try {
				return await fn(controller.signal);
			} finally {
				this.activeControllers.delete(key);
			}
		};

		const next = prev.then(execute, execute);
		this.sessionLocks.set(
			key,
			next.then(
				() => {},
				() => {},
			),
		);
		return next;
	}

	// ── Message channels (streaming input) ──

	getActiveChannel(
		userId: string,
		project: string,
	): MessageChannel | undefined {
		return this.activeChannels.get(this.lockKey(userId, project));
	}

	setActiveChannel(
		userId: string,
		project: string,
		channel: MessageChannel,
	): void {
		this.activeChannels.set(this.lockKey(userId, project), channel);
	}

	removeActiveChannel(userId: string, project: string): void {
		this.activeChannels.delete(this.lockKey(userId, project));
	}

	cancelQuery(userId: string, project: string): boolean {
		const key = this.lockKey(userId, project);

		// Flush and close the message channel (discards pending messages)
		const channel = this.activeChannels.get(key);
		if (channel) {
			channel.flush();
			this.activeChannels.delete(key);
		}

		const controller = this.activeControllers.get(key);
		if (controller) {
			controller.abort();
			return true;
		}
		return false;
	}
}

interface SessionRow {
	id: string;
	user_id: string;
	project_name: string;
	created_at: string;
	last_used: string;
	turns: number;
	cost_usd: number;
	is_active: number;
}

function rowToInfo(row: SessionRow): SessionInfo {
	return {
		id: row.id,
		projectName: row.project_name,
		createdAt: row.created_at,
		lastUsed: row.last_used,
		turns: row.turns,
		costUsd: row.cost_usd,
		isActive: row.is_active === 1,
	};
}
