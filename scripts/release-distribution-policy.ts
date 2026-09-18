type JsonRecord = Record<string, unknown>;

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const OIDC_CONFIG_ID = /^oidc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const NATIVE_ARCHIVE = /^xcb-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-([a-z0-9]{1,32})-([a-z0-9_]{1,32})\.tar\.gz$/u;
const NATIVE_CHECKSUM_SUFFIX = ".sha256";
const MAXIMUM_NATIVE_ASSET_PAIRS = 16;

/** One publishable package coordinate. tagPrefix namespaces its immutable
 * release tags ("v" for this repository's package); title prefixes the GitHub
 * Release name. Every field is a closed constant — no caller input may extend
 * this set. */
export type ReleasePackage = Readonly<{
  name: string;
  repository: string;
  tagPrefix: string;
  title: string;
  workflowPath: string;
}>;

export const publicPackageName = "@hraness/xcb";
export const publicRepository = "hraness/xcb";
export const rootReleasePackage: ReleasePackage = Object.freeze({
  name: publicPackageName,
  repository: publicRepository,
  tagPrefix: "v",
  title: "XCB",
  workflowPath: ".github/workflows/release.yml",
});
const releasePackages: ReadonlyMap<string, ReleasePackage> = new Map([
  [rootReleasePackage.name, rootReleasePackage],
]);

/** Resolve the closed package descriptor for a staged manifest name. The
 * staged writer reads its own package.json; an unknown name fails closed so a
 * foreign manifest can never publish through this repository's authority. */
export function releasePackageForName(name: string): ReleasePackage {
  const descriptor = releasePackages.get(name);
  if (descriptor === undefined) {
    throw new Error("The public package manifest identity is invalid.");
  }
  return descriptor;
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

export type NpmReleaseCoordinate = Readonly<{
  integrity: string;
  shasum: string;
  tarball: string;
}>;

export type GitHubReleaseAsset = Readonly<{
  browserDownloadUrl: string;
  digest: string;
  id: number;
  name: string;
  size: number;
}>;

export type GitHubNativeAssetPair = Readonly<{
  archive: GitHubReleaseAsset;
  checksum: GitHubReleaseAsset;
}>;

export type GitHubReleaseCoordinate = Readonly<{
  checksum: GitHubReleaseAsset;
  natives: readonly GitHubNativeAssetPair[];
  tarball: GitHubReleaseAsset;
}>;

/** Pair one complete set of `xcb-<version>-<os>-<arch>.tar.gz` archive names
 * with their adjacent `.sha256` checksum names for the exact release version.
 * Every name must belong to a complete pair; anything else fails closed. */
export function nativeAssetFilePairs(
  names: readonly string[],
  version: string,
): readonly Readonly<{ archive: string; checksum: string }>[] {
  if (!SEMVER.test(version)) throw new Error("Native release asset version is invalid.");
  const pairs = new Map<string, { archive?: string; checksum?: string }>();
  for (const name of names) {
    const isChecksum = name.endsWith(NATIVE_CHECKSUM_SUFFIX);
    const base = isChecksum ? name.slice(0, -NATIVE_CHECKSUM_SUFFIX.length) : name;
    const match = NATIVE_ARCHIVE.exec(base);
    if (match === null || match[1] !== version) {
      throw new Error(`Native release asset ${name} is not one exact xcb-${version}-<os>-<arch>.tar.gz name.`);
    }
    const pair = pairs.get(base) ?? {};
    const key = isChecksum ? "checksum" : "archive";
    if (pair[key] !== undefined) throw new Error(`Duplicate native release asset ${name}.`);
    pair[key] = name;
    pairs.set(base, pair);
    if (pairs.size > MAXIMUM_NATIVE_ASSET_PAIRS) {
      throw new Error("Native release assets exceed their bounded pair count.");
    }
  }
  return Object.freeze([...pairs.values()].map((pair) => {
    if (pair.archive === undefined || pair.checksum === undefined) {
      throw new Error("Native release asset is missing its adjacent archive or checksum.");
    }
    return Object.freeze({ archive: pair.archive, checksum: pair.checksum });
  }));
}

export function releaseDistribution(releasePackage: ReleasePackage) {
  if (!SCOPED_PACKAGE.test(releasePackage.name)) throw new Error("Release package name is not one exact scoped coordinate.");
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(releasePackage.tagPrefix)) {
    throw new Error("Release package tag prefix is not one literal namespace.");
  }
  const unscoped = releasePackage.name.slice(releasePackage.name.indexOf("/") + 1);
  const scopeOwner = releasePackage.name.slice(1, releasePackage.name.indexOf("/"));
  const stableTag = new RegExp(`^${releasePackage.tagPrefix}(${SEMVER.source.slice(1, -1)})$`, "u");

  function releaseVersionForCurrentAdmission(manifestValue: unknown, verifiedTag: string): string {
    const manifest = record(manifestValue, "current-main release admission manifest");
    if (manifest.name !== releasePackage.name || manifest.license !== "MIT") {
      throw new Error("Current-main release admission code has the wrong public package or license identity.");
    }
    const match = stableTag.exec(verifiedTag);
    if (match?.[1] === undefined) throw new Error("Verified release tag is not one canonical stable version.");
    return match[1];
  }

  function releaseArchiveName(version: string): string {
    text(version, SEMVER, "release version");
    return `${scopeOwner}-${unscoped}-${version}.tgz`;
  }

  function parseNpmRelease(
    value: unknown,
    version: string,
    options: Readonly<{ requireProvenance: boolean }> = { requireProvenance: true },
  ): NpmReleaseCoordinate {
    text(version, SEMVER, "npm release version");
    const release = record(value, "npm release");
    if (release.name !== releasePackage.name || release.version !== version || release.license !== "MIT") {
      throw new Error(`npm ${releasePackage.name}@${version} has the wrong package identity or license.`);
    }
    const dist = record(release.dist, "npm release dist");
    const expectedTarball = `https://registry.npmjs.org/${releasePackage.name}/-/${unscoped}-${version}.tgz`;
    if (dist.tarball !== expectedTarball) throw new Error("npm release tarball URL is not canonical.");
    const coordinate = Object.freeze({
      integrity: text(dist.integrity, SHA512_INTEGRITY, "npm release integrity"),
      shasum: text(dist.shasum, SHA1, "npm release SHA-1"),
      tarball: expectedTarball,
    });
    if (options.requireProvenance) {
      const npmUser = record(release._npmUser, "npm trusted publisher identity");
      const trustedPublisher = record(npmUser.trustedPublisher, "npm trusted publisher");
      const attestations = record(dist.attestations, "npm release provenance attestations");
      const provenance = record(attestations.provenance, "npm release provenance");
      const expectedAttestationUrl =
        `https://registry.npmjs.org/-/npm/v1/attestations/${releasePackage.name.replaceAll("/", "%2f")}@${version}`;
      if (
        provenance.predicateType !== "https://slsa.dev/provenance/v1"
        || attestations.url !== expectedAttestationUrl
        || npmUser.name !== "GitHub Actions"
        || npmUser.email !== "npm-oidc-no-reply@github.com"
        || trustedPublisher.id !== "github"
        || typeof trustedPublisher.oidcConfigId !== "string"
        || !OIDC_CONFIG_ID.test(trustedPublisher.oidcConfigId)
      ) {
        throw new Error("npm release trusted-publisher provenance is missing or invalid.");
      }
    }
    return coordinate;
  }

  function parseAsset(value: unknown, expectedName: string, tag: string): GitHubReleaseAsset {
    const asset = record(value, `GitHub Release asset ${expectedName}`);
    const expectedUrl = `https://github.com/${releasePackage.repository}/releases/download/${tag}/${expectedName}`;
    if (asset.name !== expectedName || asset.state !== "uploaded" || asset.browser_download_url !== expectedUrl) {
      throw new Error(`GitHub Release asset ${expectedName} has the wrong identity or state.`);
    }
    return Object.freeze({
      browserDownloadUrl: expectedUrl,
      digest: text(asset.digest, SHA256_DIGEST, `GitHub Release asset ${expectedName} digest`),
      id: positiveInteger(asset.id, `GitHub Release asset ${expectedName} id`),
      name: expectedName,
      size: positiveInteger(asset.size, `GitHub Release asset ${expectedName} size`),
    });
  }

  function parseGitHubRelease(value: unknown, version: string): GitHubReleaseCoordinate {
    text(version, SEMVER, "GitHub release version");
    const tag = `${releasePackage.tagPrefix}${version}`;
    const release = record(value, "GitHub Release");
    if (
      release.tag_name !== tag
      || release.name !== `${releasePackage.title} ${tag}`
      || release.body !== `Automated public release of ${releasePackage.name}@${version} from ${tag}.`
      || release.draft !== false
      || release.prerelease !== false
      || release.immutable !== true
    ) {
      throw new Error(`GitHub Release ${tag} is not exact, published, and immutable.`);
    }
    if (
      !Array.isArray(release.assets)
      || release.assets.length < 2
      || release.assets.length > 2 + 2 * MAXIMUM_NATIVE_ASSET_PAIRS
      || release.assets.length % 2 !== 0
    ) {
      throw new Error(
        `GitHub Release ${tag} must contain the two exact release artifacts and complete native pairs.`,
      );
    }
    const byName = new Map(release.assets.map((asset) => {
      const item = record(asset, "GitHub Release asset");
      return [item.name, asset] as const;
    }));
    if (byName.size !== release.assets.length) {
      throw new Error(`GitHub Release ${tag} contains duplicate asset names.`);
    }
    const archiveName = releaseArchiveName(version);
    const nativeNames: string[] = [];
    for (const name of byName.keys()) {
      if (name === archiveName || name === "SHA256SUMS") continue;
      if (typeof name !== "string") {
        throw new Error(`GitHub Release ${tag} contains an asset without an exact name.`);
      }
      nativeNames.push(name);
    }
    const natives = nativeAssetFilePairs(nativeNames, version).map((pair) => Object.freeze({
      archive: parseAsset(byName.get(pair.archive), pair.archive, tag),
      checksum: parseAsset(byName.get(pair.checksum), pair.checksum, tag),
    }));
    const tarball = parseAsset(byName.get(archiveName), archiveName, tag);
    const checksum = parseAsset(byName.get("SHA256SUMS"), "SHA256SUMS", tag);
    return Object.freeze({ checksum, natives: Object.freeze(natives), tarball });
  }

  return Object.freeze({
    package: releasePackage,
    releaseVersionForCurrentAdmission,
    releaseArchiveName,
    parseNpmRelease,
    parseGitHubRelease,
    stableTag,
    unscoped,
  });
}

const root = releaseDistribution(rootReleasePackage);

export function releaseVersionForCurrentAdmission(
  manifestValue: unknown,
  verifiedTag: string,
): string {
  return root.releaseVersionForCurrentAdmission(manifestValue, verifiedTag);
}

export function releaseArchiveName(version: string): string {
  return root.releaseArchiveName(version);
}

export function parseNpmRelease(
  value: unknown,
  version: string,
  options: Readonly<{ requireProvenance: boolean }> = { requireProvenance: true },
): NpmReleaseCoordinate {
  return root.parseNpmRelease(value, version, options);
}

export function parseGitHubRelease(
  value: unknown,
  version: string,
): GitHubReleaseCoordinate {
  return root.parseGitHubRelease(value, version);
}

export function assertReleaseAssetBytes(
  coordinate: GitHubReleaseCoordinate,
  tarballBytes: Uint8Array,
  checksumBytes: Uint8Array,
  sha256: (bytes: Uint8Array) => string,
): void {
  const tarballDigest = sha256(tarballBytes);
  const checksumDigest = sha256(checksumBytes);
  if (
    coordinate.tarball.size !== tarballBytes.byteLength
    || coordinate.tarball.digest !== `sha256:${tarballDigest}`
    || coordinate.checksum.size !== checksumBytes.byteLength
    || coordinate.checksum.digest !== `sha256:${checksumDigest}`
  ) throw new Error("GitHub Release asset size or digest does not match its immutable bytes.");
  const expectedChecksum = `${tarballDigest}  ${coordinate.tarball.name}\n`;
  if (new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes) !== expectedChecksum) {
    throw new Error("SHA256SUMS does not describe the exact GitHub Release tarball.");
  }
}

export function assertNativeAssetBytes(
  pair: GitHubNativeAssetPair,
  archiveBytes: Uint8Array,
  checksumBytes: Uint8Array,
  sha256: (bytes: Uint8Array) => string,
): void {
  const archiveDigest = sha256(archiveBytes);
  const checksumDigest = sha256(checksumBytes);
  if (
    pair.archive.size !== archiveBytes.byteLength
    || pair.archive.digest !== `sha256:${archiveDigest}`
    || pair.checksum.size !== checksumBytes.byteLength
    || pair.checksum.digest !== `sha256:${checksumDigest}`
  ) throw new Error(`GitHub Release asset ${pair.archive.name} size or digest does not match its immutable bytes.`);
  const expectedChecksum = `${archiveDigest}\n`;
  if (new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes) !== expectedChecksum) {
    throw new Error(`Native checksum ${pair.checksum.name} does not describe the exact archive bytes.`);
  }
}
