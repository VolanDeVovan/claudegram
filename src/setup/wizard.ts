import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ConfigManager } from "@core/config.ts";
import { GenerationManager } from "@core/generation-manager.ts";
import { Bot } from "grammy";

const TEMPLATES_DIR = resolve(join(import.meta.dir, "..", "templates"));
const STARTER_TEMPLATES = ["auth.ts", "ack-reaction.ts"];

export async function runWizard(
	configPath: string,
	pluginsDir: string,
	generationsDir: string,
): Promise<void> {
	console.log("\n  Claude Telegram Bot - First Run Setup\n");
	console.log("  No config found. Let me help you set up.\n");

	// 1. Bot token
	const botToken = await ask("  1. Bot token from @BotFather:\n  > ");
	if (!botToken) {
		console.error("  Bot token is required.");
		process.exit(1);
	}

	// Validate token
	console.log("  Checking token...");
	try {
		const testBot = new Bot(botToken);
		const me = await testBot.api.getMe();
		console.log(`  Valid! Bot: @${me.username}\n`);
	} catch (e) {
		console.error(
			`  Invalid token: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	}

	// 2. Owner ID
	const owner = await ask(
		"  2. Your Telegram user ID (get from @userinfobot):\n  > ",
	);
	if (!owner || !/^\d+$/.test(owner.trim())) {
		console.error("  Valid numeric user ID is required.");
		process.exit(1);
	}

	// Create directories
	mkdirSync(dirname(configPath), { recursive: true });
	mkdirSync(pluginsDir, { recursive: true });
	mkdirSync(generationsDir, { recursive: true });

	// Create config
	ConfigManager.create(configPath, {
		botToken: botToken.trim(),
		owner: owner.trim(),
		projects: [
			{
				name: "self",
				path: process.cwd(),
				description: "This bot itself",
			},
		],
	});
	console.log(`  Config saved to ${configPath}`);

	// Copy starter templates
	if (existsSync(TEMPLATES_DIR)) {
		for (const template of STARTER_TEMPLATES) {
			const src = join(TEMPLATES_DIR, template);
			const dest = join(pluginsDir, template);
			if (existsSync(src)) {
				cpSync(src, dest);
				console.log(`  Copied template: ${template}`);
			}
		}
	}

	// Create first generation
	const genManager = new GenerationManager(generationsDir, pluginsDir);
	genManager.create("Initial setup");
	console.log("  Generation gen-001 created");

	console.log("\n  Starting bot...\n");
	rl.close();
}

const rl = require("node:readline").createInterface({
	input: process.stdin,
	output: process.stdout,
});

function ask(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(prompt, (answer: string) => {
			resolve(answer.trim());
		});
	});
}
