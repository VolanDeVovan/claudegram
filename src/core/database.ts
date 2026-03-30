import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "@logtape/logtape";

const log = getLogger(["bot", "database"]);

const MIGRATIONS = [
	// version 1: initial
	`CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		project_name TEXT NOT NULL,
		created_at TEXT NOT NULL,
		last_used TEXT NOT NULL,
		turns INTEGER DEFAULT 0,
		cost_usd REAL DEFAULT 0,
		is_active INTEGER DEFAULT 1
	)`,
	`CREATE INDEX idx_sessions_user ON sessions(user_id)`,
	`CREATE INDEX idx_sessions_project ON sessions(project_name)`,
	`CREATE UNIQUE INDEX idx_sessions_active ON sessions(user_id, project_name) WHERE is_active = 1`,
	`CREATE TABLE user_state (
		user_id TEXT PRIMARY KEY,
		active_project TEXT NOT NULL DEFAULT 'self'
	)`,
];

export function initDatabase(dbPath: string): Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");

	db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`);

	const row = db
		.query<{ version: number }, []>(
			"SELECT MAX(version) as version FROM schema_version",
		)
		.get();
	const currentVersion = row?.version ?? 0;

	for (let i = currentVersion; i < MIGRATIONS.length; i++) {
		const sql = MIGRATIONS[i] as string;
		db.exec(sql);
		db.exec(
			`INSERT INTO schema_version (version, applied_at) VALUES (${i + 1}, '${new Date().toISOString()}')`,
		);
		log.info("Applied migration {version}", { version: i + 1 });
	}

	if (currentVersion < MIGRATIONS.length) {
		log.info("Database migrated from v{from} to v{to}", {
			from: currentVersion,
			to: MIGRATIONS.length,
		});
	}

	return db;
}
