import { join } from "node:path";
import * as git from "./src/core/git.ts";
import {
	EXIT_CODE_RESTART,
	readUpdateState,
	writeUpdateState,
} from "./src/core/update-state.ts";

// Supervisor process. Spawns `bun run src/core/server.ts` and respawns it on
// EXIT_CODE_RESTART (the code the bot process uses to signal "update applied,
// please restart me"). On any other non-zero exit we only retry if an update
// is in flight — otherwise a bug would turn into an infinite restart loop.
//
// Crash handling is deliberately simple: one rollback attempt, then give up.
// The natural "bot survived boot" signal lives in the bot itself —
// sendStartupNotification() clears .update-state on boot, so if the process
// crashes *after* that we fall through the `!state` check below and exit
// normally rather than looping.

const ROOT_DIR = import.meta.dir;
const DATA_DIR = join(ROOT_DIR, "data");

let currentProc: ReturnType<typeof Bun.spawn> | null = null;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => currentProc?.kill(sig));
}

async function main() {
	while (true) {
		currentProc = Bun.spawn(["bun", "run", "src/core/server.ts"], {
			stdio: ["inherit", "inherit", "inherit"],
			env: process.env,
			cwd: ROOT_DIR,
		});

		const code = await currentProc.exited;
		currentProc = null;

		if (code === EXIT_CODE_RESTART) continue;
		if (code === 0) process.exit(0);

		// Non-zero. Auto-rollback only if an update was in flight AND we
		// haven't already tried rolling back this cycle.
		const state = readUpdateState(DATA_DIR);
		if (!state) {
			// Ordinary bug, no update in flight — let it die rather than loop.
			console.error(
				`[start.ts] child exited with code ${code} (no update in flight) — exiting`,
			);
			process.exit(code);
		}
		if (state.type !== "update") {
			// Already tried rollback (or auto-rolled back) and still crashing — give up.
			console.error(
				`[start.ts] crash persists after ${state.type} — giving up`,
			);
			process.exit(code);
		}

		console.error(
			`[start.ts] crash after update — auto-rolling back to ${state.prevHead}`,
		);
		try {
			// Detached HEAD (branch name == "HEAD") cannot take `reset --hard`
			// cleanly the same way a regular branch can; we checkout instead.
			const branch = git.currentBranch(ROOT_DIR);
			const rollback =
				branch === "HEAD"
					? git.checkout(ROOT_DIR, state.prevHead)
					: git.resetHard(ROOT_DIR, state.prevHead);
			if (!rollback.ok) {
				throw new Error(`git rollback failed: ${rollback.stderr}`);
			}

			const install = Bun.spawnSync(["bun", "install"], {
				stdio: ["inherit", "inherit", "inherit"],
				cwd: ROOT_DIR,
			});
			if (install.exitCode !== 0) {
				console.error(
					`[start.ts] bun install failed with code ${install.exitCode} during auto-rollback — continuing anyway`,
				);
			}

			writeUpdateState(DATA_DIR, { ...state, type: "crash-rollback" });
			// loop continues — next iteration spawns the bot on the rolled-back HEAD
		} catch (e) {
			console.error("[start.ts] auto-rollback failed:", e);
			process.exit(code);
		}
	}
}

main();
