import { getLogger } from "@logtape/logtape";
import type { ConfigManager } from "./config.ts";
import { JsonStore } from "./json-store.ts";
import type { MessageChannel } from "./message-channel.ts";
import type { SessionAPI, SessionInfo } from "./plugin-api.ts";

const log = getLogger(["bot", "session"]);

export class SessionManager implements SessionAPI {
	private store: JsonStore<SessionInfo[]>;
	private config: ConfigManager;
	private sessionLocks = new Map<string, Promise<void>>();
	private activeControllers = new Map<string, AbortController>();
	private activeChannels = new Map<string, MessageChannel>();

	constructor(sessionsPath: string, config: ConfigManager) {
		this.store = new JsonStore(sessionsPath, []);
		this.config = config;
	}

	private lockKey(scope: string, project: string): string {
		return `${scope}:${project}`;
	}

	private isExpired(lastUsed: string): boolean {
		const hours = (Date.now() - new Date(lastUsed).getTime()) / 3600_000;
		return hours > this.config.data.sessionTimeoutHours;
	}

	// ── SessionAPI ──

	async list(scope: string, projectName?: string): Promise<SessionInfo[]> {
		const all = await this.store.read();
		return all
			.filter(
				(s) =>
					s.scope === scope && (!projectName || s.projectName === projectName),
			)
			.sort(
				(a, b) =>
					new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
			);
	}

	async activate(sessionId: string): Promise<void> {
		await this.store.update((sessions) => {
			const target = sessions.find((s) => s.id === sessionId);
			if (!target) throw new Error(`Session ${sessionId} not found`);

			return sessions.map((s) => {
				if (
					s.scope === target.scope &&
					s.projectName === target.projectName &&
					s.isActive
				) {
					return { ...s, isActive: false };
				}
				if (s.id === sessionId) {
					return {
						...s,
						isActive: true,
						lastUsed: new Date().toISOString(),
					};
				}
				return s;
			});
		});

		log.info("Session {id} activated", { id: sessionId });
	}

	async getActive(
		scope: string,
		projectName: string,
	): Promise<SessionInfo | null> {
		const all = await this.store.read();
		return (
			all.find(
				(s) => s.scope === scope && s.projectName === projectName && s.isActive,
			) ?? null
		);
	}

	// ── Session lifecycle ──

	async getActiveSessionId(
		scope: string,
		projectName: string,
	): Promise<string | null> {
		const session = await this.getActive(scope, projectName);
		if (!session) return null;
		if (this.isExpired(session.lastUsed)) {
			await this.deactivateSession(session.id);
			log.info("Session {id} expired", { id: session.id });
			return null;
		}
		return session.id;
	}

	async deactivateSession(sessionId: string): Promise<void> {
		await this.store.update((sessions) =>
			sessions.map((s) => (s.id === sessionId ? { ...s, isActive: false } : s)),
		);
	}

	async createSession(
		sessionId: string,
		scope: string,
		projectName: string,
	): Promise<void> {
		const maxSessions = this.config.data.maxSessions;
		const now = new Date().toISOString();
		await this.store.update((sessions) => {
			// Deactivate existing active sessions for this scope+project
			const updated = sessions.map((s) =>
				s.scope === scope && s.projectName === projectName && s.isActive
					? { ...s, isActive: false }
					: s,
			);
			updated.push({
				id: sessionId,
				scope,
				projectName,
				createdAt: now,
				lastUsed: now,
				turns: 0,
				costUsd: 0,
				isActive: true,
			});
			// Prune: keep active + newest inactive up to maxSessions
			if (updated.length > maxSessions) {
				const active = updated.filter((s) => s.isActive);
				const inactive = updated
					.filter((s) => !s.isActive)
					.sort(
						(a, b) =>
							new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
					);
				return [...active, ...inactive].slice(0, maxSessions);
			}
			return updated;
		});
		log.info("Session {id} created for scope {scope} project {project}", {
			id: sessionId,
			scope,
			project: projectName,
		});
	}

	async updateSession(
		sessionId: string,
		turns: number,
		costUsd: number,
	): Promise<void> {
		await this.store.update((sessions) =>
			sessions.map((s) =>
				s.id === sessionId
					? { ...s, lastUsed: new Date().toISOString(), turns, costUsd }
					: s,
			),
		);
	}

	async clearSession(scope: string, projectName: string): Promise<void> {
		await this.store.update((sessions) =>
			sessions.map((s) =>
				s.scope === scope && s.projectName === projectName && s.isActive
					? { ...s, isActive: false }
					: s,
			),
		);
		log.info("Session cleared for scope {scope} project {project}", {
			scope,
			project: projectName,
		});
	}

	// ── Concurrency ──

	async withSessionLock<T>(
		scope: string,
		project: string,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const key = this.lockKey(scope, project);
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

	getActiveChannel(scope: string, project: string): MessageChannel | undefined {
		return this.activeChannels.get(this.lockKey(scope, project));
	}

	setActiveChannel(
		scope: string,
		project: string,
		channel: MessageChannel,
	): void {
		this.activeChannels.set(this.lockKey(scope, project), channel);
	}

	removeActiveChannel(scope: string, project: string): void {
		this.activeChannels.delete(this.lockKey(scope, project));
	}

	cancelQuery(scope: string, project: string): boolean {
		const key = this.lockKey(scope, project);

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
