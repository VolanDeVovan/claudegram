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

const log = getLogger(["bot", "generation"]);

interface GenerationMeta {
	generation: number;
	timestamp: string;
	description: string;
	plugins: string[];
}

const MAX_GENERATIONS = 50;

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

	create(description: string): number {
		const current = this.getCurrent();
		const next = current + 1;
		const genDir = this.genPath(next);

		mkdirSync(join(genDir, "plugins"), { recursive: true });

		if (existsSync(this.pluginsDir)) {
			cpSync(this.pluginsDir, join(genDir, "plugins"), { recursive: true });
		}

		const meta: GenerationMeta = {
			generation: next,
			timestamp: new Date().toISOString(),
			description,
			plugins: this.getPluginNames(),
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

	rollback(generation: number): void {
		const genDir = this.genPath(generation);
		if (!existsSync(genDir)) {
			throw new Error(`Generation ${generation} not found`);
		}

		// Clear current plugins
		if (existsSync(this.pluginsDir)) {
			rmSync(this.pluginsDir, { recursive: true });
		}
		mkdirSync(this.pluginsDir, { recursive: true });

		// Copy from generation
		const src = join(genDir, "plugins");
		if (existsSync(src)) {
			cpSync(src, this.pluginsDir, { recursive: true });
		}

		writeFileSync(this.currentFile(), String(generation));
		log.info("Rolled back to generation {num}", { num: generation });
	}

	diff(from: number, to: number): string {
		const fromDir = join(this.genPath(from), "plugins");
		const toDir = join(this.genPath(to), "plugins");

		const fromFiles = this.listFiles(fromDir);
		const toFiles = this.listFiles(toDir);

		const allFiles = new Set([...fromFiles, ...toFiles]);
		const lines: string[] = [];

		for (const file of [...allFiles].sort()) {
			const inFrom = fromFiles.includes(file);
			const inTo = toFiles.includes(file);

			if (!inFrom) {
				lines.push(`+ ${file} (added)`);
			} else if (!inTo) {
				lines.push(`- ${file} (removed)`);
			} else {
				const fromContent = readFileSync(join(fromDir, file), "utf-8");
				const toContent = readFileSync(join(toDir, file), "utf-8");
				if (fromContent !== toContent) {
					lines.push(`~ ${file} (modified)`);
				}
			}
		}

		return lines.length > 0 ? lines.join("\n") : "No changes";
	}

	private listFiles(dir: string): string[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { recursive: true, withFileTypes: false }).map(
			String,
		);
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
