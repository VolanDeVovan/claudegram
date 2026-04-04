import { join } from "node:path";
import { JsonStore } from "./json-store.ts";

export interface ScopeStore {
	get<T = unknown>(scope: string, key: string): Promise<T | null>;
	set(scope: string, key: string, value: unknown): Promise<void>;
	delete(scope: string, key: string): Promise<void>;
}

export class JsonScopeStore implements ScopeStore {
	private stores = new Map<string, JsonStore<Record<string, unknown>>>();
	private dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private getStore(scope: string): JsonStore<Record<string, unknown>> {
		let store = this.stores.get(scope);
		if (!store) {
			const safeName = encodeURIComponent(scope);
			store = new JsonStore(join(this.dir, `${safeName}.json`), {});
			this.stores.set(scope, store);
		}
		return store;
	}

	async get<T = unknown>(scope: string, key: string): Promise<T | null> {
		const data = await this.getStore(scope).read();
		return (data[key] as T) ?? null;
	}

	async set(scope: string, key: string, value: unknown): Promise<void> {
		await this.getStore(scope).update((data) => ({ ...data, [key]: value }));
	}

	async delete(scope: string, key: string): Promise<void> {
		await this.getStore(scope).update((data) => {
			const { [key]: _, ...rest } = data;
			return rest;
		});
	}
}
