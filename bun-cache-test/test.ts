import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const filePath = resolve("./module.ts");
const base = pathToFileURL(filePath).href;

// First import
const { mtimeMs, size } = statSync(filePath);
const url1 = `${base}?t=${mtimeMs}&s=${size}`;
const mod1 = await import(url1);
console.log("Import 1:", mod1.value);

// Modify the file
const fs = require("node:fs");
fs.writeFileSync(filePath, 'export const value = "version-2";\n');

// Wait a bit for mtime to change
await new Promise(r => setTimeout(r, 100));

// Second import with new cache-busting params
const stat2 = statSync(filePath);
const url2 = `${base}?t=${stat2.mtimeMs}&s=${stat2.size}`;
console.log("URL1:", url1);
console.log("URL2:", url2);
console.log("URLs differ:", url1 !== url2);

const mod2 = await import(url2);
console.log("Import 2:", mod2.value);
console.log("Cache busted:", mod1.value !== mod2.value);
