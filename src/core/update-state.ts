import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

// Pure types + I/O — deliberately has no runtime dependencies beyond node
// builtins so both the bot process and the start.ts supervisor can import it
// without pulling in grammy/SDK.

/**
 * Exit code the bot uses to signal "update applied, please restart me" to the
 * start.ts supervisor. Lives here (not in update.ts) so the supervisor can
 * import it without pulling grammy/SDK transitively through update.ts.
 */
export const EXIT_CODE_RESTART = 42;

export type UpdateType = "update" | "rollback" | "crash-rollback";

/**
 * Where the startup notification should land after a restart.
 *
 * Captured at the moment the apply_update tool runs so the restart reply goes
 * to the chat/topic that actually requested the operation, rather than
 * guessing from `scope` (which is an abstract ownership key — it happens to
 * equal the owner's DM chat_id today but that's an implementation detail of
 * the core fallback resolver).
 */
export interface NotifyTarget {
	chatId: number;
	messageThreadId?: number;
}

export interface UpdateState {
	/** Git HEAD at the moment the update/rollback was initiated. */
	prevHead: string;
	type: UpdateType;
	/**
	 * For rollback: git HEAD the working tree was reset to *before* exit.
	 * The restart notification verifies `currentHead === targetHash` on boot
	 * to confirm the reset actually took effect. Unused for update/crash-rollback.
	 */
	targetHash?: string;
	/** Scope that triggered the op — for pushContext after restart. */
	scope: string;
	/** Project that triggered the op — for pushContext after restart. */
	project: string;
	/** Chat/topic the restart notification should be sent to. */
	target: NotifyTarget;
}

function statePath(dataDir: string): string {
	return join(dataDir, ".update-state");
}

export function readUpdateState(dataDir: string): UpdateState | null {
	const path = statePath(dataDir);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as UpdateState;
	} catch {
		return null;
	}
}

export function writeUpdateState(dataDir: string, state: UpdateState): void {
	const path = statePath(dataDir);
	const payload = JSON.stringify(state, null, 2);
	// Open → write → fsync → close, all on one writable fd. `writeFileSync`
	// plus a separate read-only fsync would work on Linux but is incorrect
	// elsewhere (BSD rejects fsync on O_RDONLY with EBADF). Doing the whole
	// sequence against one O_WRONLY fd is the portable flush pattern. We
	// truncate with "w" so a shorter payload doesn't leave stale bytes from
	// a previous longer one.
	//
	// Without this flush, a hard kill between the write and the subsequent
	// process.exit() can lose the state record — the page cache never makes
	// it to disk, the supervisor respawns blind, and the user never learns
	// the update was interrupted.
	const fd = openSync(path, "w");
	try {
		writeSync(fd, payload);
		try {
			fsyncSync(fd);
		} catch {
			// Some filesystems (tmpfs, certain NFS configs) reject fsync —
			// durability downgrades to whatever the kernel decides to flush
			// later. Not fatal for the update flow; the data is at least in
			// the page cache.
		}
	} finally {
		closeSync(fd);
	}
}

export function clearUpdateState(dataDir: string): void {
	const path = statePath(dataDir);
	if (existsSync(path)) unlinkSync(path);
}
