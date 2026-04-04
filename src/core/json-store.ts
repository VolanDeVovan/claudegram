import { mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname } from "node:path";
import { getLogger } from "@logtape/logtape";

const log = getLogger(["bot", "json-store"]);

async function atomicWrite(path: string, data: unknown): Promise<void> {
	const tmp = `${path}.${Date.now()}.tmp`;
	await Bun.write(tmp, JSON.stringify(data, null, 2));
	await rename(tmp, path);
}

export class JsonStore<T> {
	private path: string;
	private defaultValue: T;
	private cache: T | null = null;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(path: string, defaultValue: T) {
		this.path = path;
		this.defaultValue = defaultValue;
		mkdirSync(dirname(path), { recursive: true });
	}

	async read(): Promise<T> {
		if (this.cache !== null) return this.cache;
		const file = Bun.file(this.path);
		if (!(await file.exists())) return this.defaultValue;
		this.cache = (await file.json()) as T;
		return this.cache;
	}

	async update(fn: (data: T) => T): Promise<void> {
		this.writeLock = this.writeLock
			.then(async () => {
				const data = await this.read();
				const updated = fn(data);
				await atomicWrite(this.path, updated);
				this.cache = updated;
			})
			.catch((err) => {
				this.cache = null;
				log.error("JsonStore write error for {path}: {error}", {
					path: this.path,
					error: err instanceof Error ? err.message : String(err),
				});
				throw err;
			});
		await this.writeLock;
	}
}
