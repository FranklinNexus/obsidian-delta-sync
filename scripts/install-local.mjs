import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  throw new Error("Provide at least one vault root");
}

for (const root of roots) {
  const destination = resolve(root, ".obsidian/plugins/obsidian-docs-sync");
  await mkdir(destination, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    await cp(resolve(file), resolve(destination, file));
  }
  process.stdout.write(`Installed to ${destination}\n`);
}
