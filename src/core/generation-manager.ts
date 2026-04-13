import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { createTwoFilesPatch } from "diff";

const log = getLogger(["bot", "generation"]);

// Node's Dirent typings expose `parentPath`; Bun also populates `path` on older
// Node versions. Read whichever is present.
function direntParent(e: { parentPath?: string; path?: string }): string {
	return e.parentPath ?? e.path ?? "";
}

export interface GenerationMeta {
	generation: number;
	timestamp: string;
	description: string;
	plugins: string[];
	/** Git HEAD at snapshot time. Optional for legacy generations predating this field. */
	commitHash?: string;
}

const MAX_GENERATIONS = 50;

/**
 * True iff `src` names or lives inside a `node_modules` directory. Used by
 * the snapshot copy filter and the diff file walker. The obvious
 * `includes("/node_modules")` would also match legitimate names like
 * `docs/node_modules_guide.md` — hence the path-segment check.
 */
function isInNodeModules(src: string): boolean {
	return src.endsWith("/node_modules") || src.includes("/node_modules/");
}

export class GenerationManager {
	private generationsDir: string;
	private pluginsDir: string;

	constructor(generationsDir: string, pluginsDir: string) {
		this.generationsDir = generationsDir;
		this.pluginsDir = pluginsDir;
		mkdirSync(generationsDir, { recursive: true });
	}

	private genPath(num: number): string {
		return join(this.generationsDir, `gen-${String(num).padStart(3, "0")}`);
	}

	private currentFile(): string {
		return join(this.generationsDir, "current");
	}

	getCurrent(): number {
		try {
			return Number.parseInt(
				readFileSync(this.currentFile(), "utf-8").trim(),
				10,
			);
		} catch {
			return 0;
		}
	}

	private getPluginNames(): string[] {
		if (!existsSync(this.pluginsDir)) return [];
		return readdirSync(this.pluginsDir, { withFileTypes: true })
			.filter(
				(e) =>
					(e.isFile() && e.name.endsWith(".ts")) ||
					(e.isDirectory() &&
						existsSync(join(this.pluginsDir, e.name, "index.ts"))),
			)
			.map((e) => e.name.replace(/\.ts$/, ""));
	}

	/**
	 * Snapshot the current `plugins/` directory as a new generation.
	 *
	 * `commitHash` is the git HEAD at snapshot time; the caller provides it
	 * (via `git.getHead()`) so this module stays git-agnostic and testable.
	 * Omit it if git state isn't relevant (e.g. a plugin-only reload where the
	 * rollback can reuse the current HEAD).
	 */
	create(description: string, commitHash?: string): number {
		const current = this.getCurrent();
		const next = current + 1;
		const genDir = this.genPath(next);

		// Wipe any stale directory at this index before copying. After a
		// rollback the current pointer moves backwards but the higher-
		// numbered directories stay on disk (so a later rollforward could
		// reuse them). On the next create() we compute next = current+1
		// and may land right on top of a leftover — without a wipe, cpSync
		// would merge the new plugin files into whatever was there before,
		// leaving the snapshot with a mix of old and new state.
		if (existsSync(genDir)) {
			rmSync(genDir, { recursive: true, force: true });
		}
		mkdirSync(join(genDir, "plugins"), { recursive: true });

		if (existsSync(this.pluginsDir)) {
			cpSync(this.pluginsDir, join(genDir, "plugins"), {
				recursive: true,
				filter: (src) => !isInNodeModules(src),
			});
		}

		const meta: GenerationMeta = {
			generation: next,
			timestamp: new Date().toISOString(),
			description,
			plugins: this.getPluginNames(),
			commitHash,
		};
		writeFileSync(join(genDir, "meta.json"), JSON.stringify(meta, null, 2));
		writeFileSync(this.currentFile(), String(next));

		log.info("Generation {num} created: {desc}", {
			num: next,
			desc: description,
		});

		this.rotate();
		return next;
	}

	/**
	 * Drop a generation that was created but never made it into a durable
	 * state — typically a pre-update snapshot whose `/update` aborted early
	 * (dirty tree, failed `git pull`, failed `bun install`). If this was the
	 * current pointer, roll back to the previous highest numbered generation
	 * so `getCurrent()` never reports a removed gen.
	 *
	 * Safe to call on a non-existent generation — no-op. Never call this on
	 * an older generation: the rollback logic assumes generation numbers are
	 * monotonic and dropping arbitrary ones from the middle would confuse it.
	 */
	discard(generation: number): void {
		const genDir = this.genPath(generation);
		if (!existsSync(genDir)) return;

		rmSync(genDir, { recursive: true, force: true });

		if (this.getCurrent() === generation) {
			// Find the next-highest remaining generation and point at it.
			const remaining = this.list();
			const next = remaining[remaining.length - 1]?.generation ?? 0;
			writeFileSync(this.currentFile(), String(next));
		}

		log.info("Generation {num} discarded", { num: generation });
	}

	/**
	 * Read a single generation's metadata without touching `plugins/`.
	 *
	 * Callers (e.g. the rollback flow) need to inspect `commitHash` before
	 * deciding whether to do a git reset — doing it via `rollback()` would
	 * prematurely clobber the live plugins directory.
	 */
	getMeta(generation: number): GenerationMeta | null {
		const genDir = this.genPath(generation);
		if (!existsSync(genDir)) return null;
		try {
			return JSON.parse(
				readFileSync(join(genDir, "meta.json"), "utf-8"),
			) as GenerationMeta;
		} catch {
			return null;
		}
	}

	list(): GenerationMeta[] {
		if (!existsSync(this.generationsDir)) return [];
		const entries = readdirSync(this.generationsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && e.name.startsWith("gen-"))
			.sort((a, b) => a.name.localeCompare(b.name));

		return entries.map((e) => {
			const metaPath = join(this.generationsDir, e.name, "meta.json");
			try {
				return JSON.parse(readFileSync(metaPath, "utf-8")) as GenerationMeta;
			} catch {
				return {
					generation: Number.parseInt(e.name.replace("gen-", ""), 10),
					timestamp: "unknown",
					description: "unknown",
					plugins: [],
				};
			}
		});
	}

	/**
	 * Restore `plugins/` to the given generation and bump the current pointer.
	 *
	 * Callers needing the recorded `commitHash` (to decide whether a process
	 * restart is required) should call {@link getMeta} before invoking this —
	 * it deliberately doesn't return the hash because the rollback flow
	 * already reads metadata up-front to sequence git reset before the
	 * plugin-file restore.
	 */
	rollback(generation: number): void {
		const genDir = this.genPath(generation);
		if (!existsSync(genDir)) {
			throw new Error(`Generation ${generation} not found`);
		}

		if (existsSync(this.pluginsDir)) {
			rmSync(this.pluginsDir, { recursive: true });
		}
		mkdirSync(this.pluginsDir, { recursive: true });

		const src = join(genDir, "plugins");
		if (existsSync(src)) {
			cpSync(src, this.pluginsDir, { recursive: true });
		}

		writeFileSync(this.currentFile(), String(generation));
		log.info("Rolled back to generation {num}", { num: generation });
	}

	diff(from?: number, to?: number): string {
		const gens = this.list();
		const fromGen = from ?? gens[0]?.generation;
		if (fromGen == null) {
			return "No generations yet";
		}
		const fromDir = join(this.genPath(fromGen), "plugins");
		// to omitted → compare against live plugins/
		const toDir =
			to != null ? join(this.genPath(to), "plugins") : this.pluginsDir;
		const fromLabel = `gen-${fromGen}/plugins`;
		const toLabel = to != null ? `gen-${to}/plugins` : "plugins (current)";

		if (!existsSync(fromDir)) {
			throw new Error(`Generation ${fromGen} not found`);
		}
		if (to != null && !existsSync(toDir)) {
			throw new Error(`Generation ${to} not found`);
		}

		const fromFiles = this.listFiles(fromDir);
		const toFiles = this.listFiles(toDir);

		const allFiles = new Set([...fromFiles, ...toFiles]);
		const patches: string[] = [];

		for (const file of [...allFiles].sort()) {
			const inFrom = fromFiles.includes(file);
			const inTo = toFiles.includes(file);

			const fromContent = inFrom
				? readFileSync(join(fromDir, file), "utf-8")
				: "";
			const toContent = inTo ? readFileSync(join(toDir, file), "utf-8") : "";

			if (fromContent === toContent) continue;

			const patch = createTwoFilesPatch(
				`${fromLabel}/${file}`,
				`${toLabel}/${file}`,
				fromContent,
				toContent,
				undefined,
				undefined,
				{ context: 3 },
			);
			patches.push(patch);
		}

		return patches.length > 0 ? patches.join("\n") : "No changes";
	}

	private listFiles(dir: string): string[] {
		if (!dir || !existsSync(dir)) return [];
		return readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((e) => {
				if (!e.isFile()) return false;
				return !isInNodeModules(direntParent(e));
			})
			.map((e) => {
				const rel = direntParent(e).slice(dir.length).replace(/^\//, "");
				return rel ? `${rel}/${e.name}` : e.name;
			});
	}

	private rotate(): void {
		const gens = this.list();
		if (gens.length <= MAX_GENERATIONS) return;

		const toRemove = gens.slice(0, gens.length - MAX_GENERATIONS);
		for (const gen of toRemove) {
			const dir = this.genPath(gen.generation);
			rmSync(dir, { recursive: true });
			log.info("Rotated generation {num}", { num: gen.generation });
		}
	}
}
