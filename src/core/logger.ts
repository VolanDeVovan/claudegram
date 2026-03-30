import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getRotatingFileSink } from "@logtape/file";
import {
	configure,
	getConsoleSink,
	getLogger,
	jsonLinesFormatter,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";

export async function initLogger(logDir: string): Promise<void> {
	const logFile = `${logDir}/bot.log`;
	mkdirSync(dirname(logFile), { recursive: true });

	await configure({
		sinks: {
			file: getRotatingFileSink(logFile, {
				formatter: jsonLinesFormatter,
				maxSize: 5 * 1024 * 1024,
				maxFiles: 3,
			}),
			console: getConsoleSink({
				formatter: getPrettyFormatter({
					timestamp: "time",
					wordWrap: false,
					categoryWidth: 20,
					properties: true,
				}),
			}),
		},
		loggers: [
			{
				category: ["logtape", "meta"],
				lowestLevel: "warning",
				sinks: ["console"],
			},
			{
				category: ["bot"],
				lowestLevel: "debug",
				sinks: ["file", "console"],
			},
		],
	});
}

export { getLogger };
