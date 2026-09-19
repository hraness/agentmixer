import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const STABLE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function manifestVersion(source: string): string {
  const value = JSON.parse(source) as { version?: unknown };
  if (typeof value.version !== "string" || !STABLE.test(value.version)) {
    throw new Error("package.json version is not one stable version.");
  }
  return value.version;
}

function workspaceVersion(source: string): string {
  const marker = "[workspace.package]";
  const start = source.indexOf(marker);
  const remainder = start < 0 ? "" : source.slice(start + marker.length);
  const nextSection = remainder.search(/\n\[/u);
  const section = nextSection < 0 ? remainder : remainder.slice(0, nextSection);
  const version = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(section)?.[1];
  if (version === undefined || !STABLE.test(version)) {
    throw new Error("Cargo workspace version is not one stable version.");
  }
  return version;
}

export function assertReleaseVersionContract(
  packageSource: string,
  cargoSource: string,
  internalManifests: Readonly<Record<string, string>>,
): string {
  const packageVersion = manifestVersion(packageSource);
  const cargoVersion = workspaceVersion(cargoSource);
  if (packageVersion !== cargoVersion) {
    throw new Error(`Public package ${packageVersion} and native workspace ${cargoVersion} versions differ.`);
  }
  for (const [path, source] of Object.entries(internalManifests)) {
    for (const match of source.matchAll(/^xcb-(?:core|runtime|tui)\s*=\s*\{([^}]+)\}/gmu)) {
      const version = /\bversion\s*=\s*"([^"]+)"/u.exec(match[1]!)?.[1];
      if (version !== packageVersion) {
        throw new Error(`${path} pins internal xcb version ${version ?? "(missing)"}, expected ${packageVersion}.`);
      }
    }
  }
  return packageVersion;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const manifestPaths = [
    "crates/xcb-cli/Cargo.toml",
    "crates/xcb-runtime/Cargo.toml",
    "crates/xcb-tui/Cargo.toml",
  ];
  const [packageSource, cargoSource, ...sources] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "Cargo.toml"), "utf8"),
    ...manifestPaths.map(async path => await readFile(resolve(root, path), "utf8")),
  ]);
  const version = assertReleaseVersionContract(
    packageSource,
    cargoSource,
    Object.fromEntries(manifestPaths.map((path, index) => [path, sources[index]!])) as Readonly<Record<string, string>>,
  );
  process.stdout.write(`Release source versions agree at ${version}.\n`);
}
