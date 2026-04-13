// Thin wrappers around `git` for the update/rollback flow. Single source of
// truth for every shell-out the bot does — tests can stub one module, callers
// don't sprinkle `Bun.spawnSync(["git", ...])` across the codebase, and the
// start.ts supervisor can pull from here without dragging in grammy/SDK deps.

function run(
	args: string[],
	cwd: string,
): {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
	command: string;
} {
	const r = Bun.spawnSync(args, { cwd });
	return {
		ok: r.exitCode === 0,
		stdout: r.stdout.toString(),
		stderr: r.stderr.toString(),
		code: r.exitCode ?? -1,
		command: args.join(" "),
	};
}

export function getHead(cwd: string): string {
	return run(["git", "rev-parse", "HEAD"], cwd).stdout.trim();
}

export function currentBranch(cwd: string): string {
	return run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.trim();
}

export function hasUpstream(cwd: string): boolean {
	return run(
		["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
		cwd,
	).ok;
}

/** Porcelain status excluding `plugins/`. Empty string = clean. */
export function statusExcludingPlugins(cwd: string): string {
	return run(
		["git", "status", "--porcelain", "--", ".", ":!plugins/"],
		cwd,
	).stdout.trim();
}

/**
 * Fetch updates for the current branch's upstream.
 *
 * Bare `git fetch` (no remote arg) follows `branch.<name>.remote`, which is
 * whatever remote the upstream tracks. Hardcoding `origin` would misbehave
 * on repos whose upstream lives on a different remote.
 */
export function fetch(cwd: string): {
	ok: boolean;
	stderr: string;
	command: string;
} {
	const r = run(["git", "fetch"], cwd);
	return { ok: r.ok, stderr: r.stderr.trim(), command: r.command };
}

export function ffPull(cwd: string): {
	ok: boolean;
	stdout: string;
	stderr: string;
	command: string;
} {
	const r = run(["git", "pull", "--ff-only"], cwd);
	return {
		ok: r.ok,
		stdout: r.stdout.trim(),
		stderr: r.stderr.trim(),
		command: r.command,
	};
}

/** Commits on `@{u}` that aren't on `HEAD`, one-line format. */
export function pendingCommits(cwd: string): {
	stdout: string;
	command: string;
} {
	const r = run(["git", "log", "--oneline", "HEAD..@{u}"], cwd);
	return { stdout: r.stdout.trim(), command: r.command };
}

/** Commits in `from..to` range, `<short-hash> <subject>` per line. */
export function commitRange(cwd: string, from: string, to: string): string {
	return run(
		["git", "log", "--format=%h %s", `${from}..${to}`],
		cwd,
	).stdout.trim();
}

/** Unified diff of a single path across a commit range. */
export function diffPath(
	cwd: string,
	from: string,
	to: string,
	path: string,
): { stdout: string; command: string } {
	const r = run(["git", "diff", `${from}..${to}`, "--", path], cwd);
	return { stdout: r.stdout.trim(), command: r.command };
}

export function resetHard(
	cwd: string,
	ref: string,
): { ok: boolean; stderr: string; command: string } {
	const r = run(["git", "reset", "--hard", ref], cwd);
	return { ok: r.ok, stderr: r.stderr.trim(), command: r.command };
}

export function checkout(
	cwd: string,
	ref: string,
): { ok: boolean; stderr: string; command: string } {
	const r = run(["git", "checkout", ref], cwd);
	return { ok: r.ok, stderr: r.stderr.trim(), command: r.command };
}
