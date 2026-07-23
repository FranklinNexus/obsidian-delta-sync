import { access, readFile } from "node:fs/promises";
import process from "node:process";

/**
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>}
 */
const readJsonObject = async (path) => {
  const value = /** @type {unknown} */ (JSON.parse(await readFile(path, "utf8")));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
};
const [manifest, packageJson, versions] = await Promise.all([
  readJsonObject("manifest.json"),
  readJsonObject("package.json"),
  readJsonObject("versions.json"),
]);

const errors = [];
const versionPattern = /^\d+\.\d+\.\d+$/u;
const pluginId = typeof manifest.id === "string" ? manifest.id : "";
const manifestVersion = typeof manifest.version === "string" ? manifest.version : "";
const minAppVersion = typeof manifest.minAppVersion === "string" ? manifest.minAppVersion : "";
const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";

if (!/^[a-z0-9-]+$/u.test(pluginId)) {
  errors.push("manifest id must contain only lowercase letters, numbers, and hyphens");
}
if (pluginId.includes("obsidian")) {
  errors.push('manifest id must not contain "obsidian"');
}
if (!versionPattern.test(manifestVersion)) {
  errors.push("manifest version must use x.y.z format");
}
if (packageVersion !== manifestVersion) {
  errors.push("package.json and manifest.json versions do not match");
}
if (versions[manifestVersion] !== minAppVersion) {
  errors.push("versions.json does not map the current version to minAppVersion");
}

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag !== undefined && tag !== manifestVersion) {
  errors.push(`tag ${tag} does not match manifest version ${manifestVersion}`);
}

for (const path of ["main.js", "manifest.json", "styles.css", "README.md", "LICENSE"]) {
  try {
    await access(path);
  } catch {
    errors.push(`required release file is missing: ${path}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Release ${manifestVersion} for ${pluginId} is internally consistent.\n`);
}
