import { getLogger } from "@logtape/logtape";
import type { GenerationManager } from "./generation-manager.ts";
import * as git from "./git.ts";
import type { SessionManager } from "./session-manager.ts";
import {
	clearUpdateState,
	EXIT_CODE_RESTART,
	type NotifyTarget,
	readUpdateState,
	writeUpdateState,
} from "./update-state.ts";

const log = getLogger(["bot", "update"]);

const GRACEFUL_EXIT_TIMEOUT_MS = 30_000;

/**
 * The handle that update/rollback code uses to talk to the live bot process.
 *
 * Kept deliberately small: just the pieces these flows need. Fields group by
 * responsibility (paths → services → runtime signals → side effects) and every
 * field is either a pointer to long-lived state or a narrow capability. New
 * update operations should add new fields only when they genuinely can't be
 * derived from the existing ones.
 */
export interface BotRuntime {
	rootDir: string;
	dataDir: string;
	generations: GenerationManager;
	sessions: SessionManager;
	activeQueries(): number;
	stopRunner(): Promise<void>;
	notify(target: NotifyTarget, text: string): Promise<void>;
}

/**
 * Callback used by `applyUpdate` to emit each subprocess invocation into a
 * shared command trace. Callers build the trace array themselves so the tool
 * handler can mix its own commands (pre-flight fetch, post-apply diff) with
 * the ones run inside `applyUpdate`.
 */
export type TracePush = (cmd: string, stdout?: string, stderr?: string) => void;

// ── Pre-flight ──

export function preflight(rootDir: string): { ok: boolean; reason?: string } {
	const dirty = git.statusExcludingPlugins(rootDir);
	if (dirty) {
		const hasConflicts = dirty
			.split("\n")
			.some((l) => /^(U.|.U|AA|DD)/.test(l));
		return {
			ok: false,
			reason: hasConflicts
				? `Working tree has unresolved merge conflicts:\n${dirty}\n\nResolve conflicts before updating.`
				: `Working tree has uncommitted changes:\n${dirty}\n\nResolve these before updating.`,
		};
	}

	if (!git.hasUpstream(rootDir)) {
		return {
			ok: false,
			reason:
				"Current branch has no upstream. Set one with: git push -u origin <branch>",
		};
	}

	return { ok: true };
}

// ── Graceful exit ──

export async function gracefulExit(
	runtime: BotRuntime,
	timeoutMs = GRACEFUL_EXIT_TIMEOUT_MS,
): Promise<never> {
	log.info("Graceful exit initiated");

	await runtime.stopRunner();

	const start = Date.now();
	while (runtime.activeQueries() > 0) {
		if (Date.now() - start > timeoutMs) {
			log.warn("Graceful exit timeout: {count} queries still active", {
				count: runtime.activeQueries(),
			});
			break;
		}
		await new Promise((r) => setTimeout(r, 200));
	}

	process.exit(EXIT_CODE_RESTART);
}

// ── Apply ──

export interface ApplyResult {
	prevHead: string;
	newHead: string;
	commitLog: string;
}

// Module-scoped: the working tree is a shared resource for the whole process,
// so concurrency control has to live at module scope too. This single lock
// guards every mutation that touches the working tree or generation state —
// update AND rollback, because a rollback mid-update (or vice versa) would
// race on `git reset`, `plugins/`, and `.update-state`.
//
// One lock rather than two separate flags: the two operations are mutually
// exclusive, not just each-self-exclusive. Two rollbacks racing is just as
// dangerous as a rollback racing against an update.
let mutationInProgress: "update" | "rollback" | null = null;

function acquireMutationLock(kind: "update" | "rollback"): void {
	if (mutationInProgress !== null) {
		throw new Error(
			mutationInProgress === kind
				? `${kind} already in progress.`
				: `Cannot ${kind}: ${mutationInProgress} already in progress.`,
		);
	}
	mutationInProgress = kind;
}

function releaseMutationLock(): void {
	mutationInProgress = null;
}

/**
 * Atomic update operation: snapshot plugins, git pull, bun install, write state.
 *
 * On any failure the repo is reset back to `prevHead` and deps are reinstalled
 * so the working tree stays consistent — the caller can report the error to
 * the user and the bot keeps running without a restart.
 *
 * `target` is captured upfront so the post-restart startup notification lands
 * in the chat/topic that originally invoked the apply_update tool. The `push`
 * callback receives each subprocess invocation (git pull, bun install, reset
 * on failure) so the caller can build a single unified command trace without
 * scraping subprocess stdout itself.
 */
export async function applyUpdate(
	runtime: BotRuntime,
	scope: string,
	project: string,
	target: NotifyTarget,
	push: TracePush,
): Promise<ApplyResult> {
	acquireMutationLock("update");

	try {
		// Re-run preflight at apply time. The check-time preflight can go stale
		// between preview and apply: the user might edit config, a plugin might
		// commit files, etc. Rather than letting `git pull --ff-only` surface
		// an opaque git error, we refuse upfront with the same user-friendly
		// message as the check phase.
		const pre = preflight(runtime.rootDir);
		if (!pre.ok) {
			throw new Error(pre.reason ?? "Pre-flight check failed.");
		}

		const prevHead = git.getHead(runtime.rootDir);

		// Snapshot BEFORE mutating anything, so rollback has a safe point. We
		// capture the generation number so we can discard the snapshot if the
		// update aborts early — otherwise a failed update leaves a useless
		// "pre-update" generation in history.
		const snapshotGen = runtime.generations.create(
			`Pre-update snapshot at ${prevHead}`,
			prevHead,
		);

		const pull = git.ffPull(runtime.rootDir);
		push(pull.command, pull.stdout, pull.stderr);
		if (!pull.ok) {
			// No reset needed — ff-only failure leaves the working tree at
			// prevHead. Drop the orphaned snapshot so history stays clean.
			runtime.generations.discard(snapshotGen);
			throw new Error(`git pull --ff-only failed: ${pull.stderr}`);
		}

		const installCmd = ["bun", "install"];
		const install = Bun.spawnSync(installCmd, { cwd: runtime.rootDir });
		push(
			installCmd.join(" "),
			install.stdout.toString(),
			install.stderr.toString(),
		);
		if (install.exitCode !== 0) {
			// Roll the working tree back to prevHead and reinstall so node_modules
			// matches package.json again. The bot keeps running; the caller
			// surfaces the stderr back to the user.
			const stderr = install.stderr.toString().trim();
			log.warn("bun install failed after pull, resetting to {prev}", {
				prev: prevHead.slice(0, 7),
			});
			const reset = git.resetHard(runtime.rootDir, prevHead);
			push(reset.command, "", reset.stderr);
			const reinstall = Bun.spawnSync(installCmd, { cwd: runtime.rootDir });
			push(
				installCmd.join(" "),
				reinstall.stdout.toString(),
				reinstall.stderr.toString(),
			);
			// Snapshot is still useful here — it documents the pre-update
			// plugin state and could still be used via /rollback — but the
			// update itself failed, so drop it to avoid polluting history with
			// a snapshot that doesn't correspond to any real "version".
			runtime.generations.discard(snapshotGen);
			throw new Error(
				`bun install failed: ${stderr || `exit ${install.exitCode}`}. Repo reset to ${prevHead.slice(0, 7)}.`,
			);
		}

		const newHead = git.getHead(runtime.rootDir);
		const commitLog = git.commitRange(runtime.rootDir, prevHead, newHead);

		writeUpdateState(runtime.dataDir, {
			prevHead,
			type: "update",
			scope,
			project,
			target,
		});

		log.info("Update applied: {prev} -> {next}", {
			prev: prevHead.slice(0, 7),
			next: newHead.slice(0, 7),
		});

		return { prevHead, newHead, commitLog };
	} finally {
		releaseMutationLock();
	}
}

// ── Rollback with restart ──

/**
 * Reset the working tree to `targetHash`, restore `plugins/` from the
 * generation snapshot, write the restart state record, and gracefully exit.
 *
 * Order matters: git reset has to run *before* the plugin snapshot is
 * restored, because `plugins/package.json` is tracked and would otherwise
 * be clobbered back to the old-HEAD version after the snapshot write.
 * Non-tracked files in `plugins/` are gitignored, so reset leaves them
 * alone — the snapshot then overwrites them cleanly.
 *
 * Invoked by `applyRollback()` once it has determined that the target
 * generation's git HEAD differs from the live HEAD.
 */
async function rollbackWithRestart(
	runtime: BotRuntime,
	generation: number,
	targetHash: string,
	scope: string,
	project: string,
	target: NotifyTarget,
): Promise<void> {
	const prevHead = git.getHead(runtime.rootDir);

	const reset = git.resetHard(runtime.rootDir, targetHash);
	if (!reset.ok) {
		throw new Error(
			`git reset --hard ${targetHash.slice(0, 7)} failed: ${reset.stderr}`,
		);
	}

	// Restore plugins/ AFTER the reset so the snapshot wins over any
	// tracked plugin files the reset just rewrote.
	runtime.generations.rollback(generation);

	// Dependencies tracked in the repo may have changed between HEADs — best
	// effort reinstall so the post-restart process boots against a consistent
	// lockfile. A failure here doesn't abort the rollback: the user has
	// already asked to move off the current HEAD, and the supervisor will
	// still respawn from the new tree.
	const install = Bun.spawnSync(["bun", "install"], {
		cwd: runtime.rootDir,
	});
	if (install.exitCode !== 0) {
		const stderr = install.stderr.toString().trim().slice(0, 500);
		log.warn("bun install after rollback reset exited non-zero: {code}", {
			code: install.exitCode,
		});
		// Restart is imminent and we won't return to the caller, so park a
		// warning in the session buffer. The agent reads it on the next turn
		// after the restart and can tell the user to re-run install manually.
		runtime.sessions.pushContext(
			scope,
			project,
			`[rollback] bun install failed with exit code ${install.exitCode}. ` +
				"plugins/node_modules may be inconsistent — re-run `bun install` manually." +
				(stderr ? `\n\n${stderr}` : ""),
		);
	}

	writeUpdateState(runtime.dataDir, {
		prevHead,
		targetHash,
		type: "rollback",
		scope,
		project,
		target,
	});

	log.info("Rollback applied: {prev} -> {next} (gen {gen})", {
		prev: prevHead.slice(0, 7),
		next: targetHash.slice(0, 7),
		gen: generation,
	});

	await gracefulExit(runtime);
}

/**
 * Roll plugins back to a generation and either hot-reload or gracefully exit
 * for a restart, depending on whether the generation's git HEAD differs from
 * the live one.
 *
 * When a restart is needed this function does not return — the process exits
 * (EXIT_CODE_RESTART) and the caller should have already told the user
 * "restarting…" before calling. When a hot reload is sufficient it returns
 * the success message for the caller to relay.
 */
export async function applyRollback(
	runtime: BotRuntime,
	generation: number,
	scope: string,
	project: string,
	target: NotifyTarget,
	reload: () => Promise<{ loaded: string[]; errors: string[] }>,
): Promise<{ message: string }> {
	// Global mutation lock — shared with applyUpdate so the two can't race
	// on the working tree. On the cold path the lock stays held all the way
	// to process death: gracefulExit calls process.exit(42), which preempts
	// the finally below before it can run. On the throw path the finally
	// does run and releases the lock, so a failed rollback leaves the bot
	// usable rather than wedged with "rollback already in progress" forever.
	acquireMutationLock("rollback");

	try {
		// Peek at metadata first — we can't call `generations.rollback()`
		// yet because that would overwrite plugins/ before we know whether
		// a git reset is needed (and the reset has to happen first — see
		// `rollbackWithRestart` for the ordering rationale).
		const meta = runtime.generations.getMeta(generation);
		if (!meta) {
			throw new Error(`Generation ${generation} not found`);
		}

		const currentHead = git.getHead(runtime.rootDir);
		const targetHash = meta.commitHash;
		const needsRestart = targetHash != null && targetHash !== currentHead;

		if (needsRestart) {
			// Guard against an unclean working tree: a reset --hard would
			// silently discard the user's uncommitted non-plugin work.
			const dirty = git.statusExcludingPlugins(runtime.rootDir);
			if (dirty) {
				throw new Error(
					`Working tree has uncommitted changes — refusing to rollback:\n${dirty}`,
				);
			}

			await rollbackWithRestart(
				runtime,
				generation,
				targetHash,
				scope,
				project,
				target,
			);
			// unreachable — rollbackWithRestart calls process.exit()
			throw new Error("unreachable");
		}

		// Same-HEAD path: restore plugins/ and hot-reload.
		// `generations.rollback` wipes `plugins/` (including its
		// node_modules) and copies in the snapshot, which excludes
		// node_modules by design. That means the workspace deps are now
		// missing on disk — even if `plugins/package.json` is identical to
		// the live version, `bun install` still needs to run to materialise
		// `plugins/node_modules` before the hot reload tries to import
		// anything. Skipping this was the regression in the previous review.
		runtime.generations.rollback(generation);
		const install = Bun.spawnSync(["bun", "install"], {
			cwd: runtime.rootDir,
		});
		let installWarning = "";
		if (install.exitCode !== 0) {
			const stderr = install.stderr.toString().trim().slice(0, 500);
			log.warn(
				"bun install after hot-reload rollback exited non-zero: {code}",
				{ code: install.exitCode },
			);
			installWarning =
				`\n\nWARNING: bun install exited with code ${install.exitCode}. ` +
				"plugins/node_modules may be inconsistent — re-run `bun install` manually if plugins fail to load." +
				(stderr ? `\n\n${stderr}` : "");
		}
		const result = await reload();
		const plugins = result.loaded.join(", ") || "none";
		return {
			message: `Rolled back to generation ${generation}. Plugins: ${plugins}${installWarning}`,
		};
	} finally {
		releaseMutationLock();
	}
}

// ── Startup notification ──

export async function sendStartupNotification(
	runtime: BotRuntime,
): Promise<void> {
	const state = readUpdateState(runtime.dataDir);
	if (!state) return;

	// Consume the record up front so a failed send doesn't spam on every
	// subsequent boot. Anything after this is best-effort reporting.
	clearUpdateState(runtime.dataDir);

	const currentHead = git.getHead(runtime.rootDir);

	// Verify the on-disk state matches reality before sending — protects
	// against a process kill between writeUpdateState() and the exit that
	// was supposed to pick up the new HEAD. If the invariant doesn't hold,
	// log and skip rather than lying to the user.
	const verified = (() => {
		switch (state.type) {
			case "update":
				return currentHead !== state.prevHead;
			case "rollback":
				return state.targetHash != null && currentHead === state.targetHash;
			case "crash-rollback":
				return currentHead === state.prevHead;
		}
	})();
	if (!verified) {
		log.warn(
			"Startup notification: state did not verify against HEAD, skipping",
			{
				type: state.type,
				currentHead: currentHead.slice(0, 7),
			},
		);
		return;
	}

	let message: string;
	switch (state.type) {
		case "update":
			// The main agent already described the update to the user in chat
			// before the exit. Keep this short — just confirm the new HEAD and
			// point at /rollback as the escape hatch if the new runtime broke
			// something the agent didn't catch (e.g. plugins that fail to load
			// silently because migration was skipped).
			message =
				`Restarted on ${currentHead.slice(0, 7)}.\n` +
				"If anything looks broken, send /rollback to revert.";
			break;
		case "rollback":
			message =
				`Rolled back from ${state.prevHead.slice(0, 7)} to ${currentHead.slice(0, 7)}. ` +
				`Restart complete.`;
			break;
		case "crash-rollback":
			message =
				`Update failed (crash after restart).\n` +
				`Rolled back to commit ${state.prevHead.slice(0, 7)}.\n\n` +
				`The new code caused the bot to crash on startup. ` +
				`Check the commits or wait for a fix before retrying.`;
			break;
	}

	try {
		await runtime.notify(state.target, message);
		runtime.sessions.pushContext(state.scope, state.project, message);
		log.info("Startup notification sent to {scope}:{project}", {
			scope: state.scope,
			project: state.project,
		});
	} catch (e) {
		log.error("Failed to send startup notification: {error}", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}
