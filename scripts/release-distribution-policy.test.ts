import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  assertNativeAssetBytes,
  assertReleaseAssetBytes,
  nativeAssetFilePairs,
  parseGitHubRelease,
  parseNpmRelease,
  releaseArchiveName,
  releaseDistribution,
  releasePackageForName,
  releaseVersionForCurrentAdmission,
  rootReleasePackage,
} from "./release-distribution-policy";

const version = "0.8.1";
const tarball = new TextEncoder().encode("exact package bytes");
const tarballDigest = createHash("sha256").update(tarball).digest("hex");
const checksum = new TextEncoder().encode(`${tarballDigest}  ${releaseArchiveName(version)}\n`);
const checksumDigest = createHash("sha256").update(checksum).digest("hex");
const npmUser = {
  email: "npm-oidc-no-reply@github.com",
  name: "GitHub Actions",
  trustedPublisher: {
    id: "github",
    oidcConfigId: "oidc:12345678-1234-1234-1234-123456789abc",
  },
};
const nativeArchiveBytes = new TextEncoder().encode("native xcb archive bytes");
const nativeArchiveDigest = createHash("sha256").update(nativeArchiveBytes).digest("hex");
const nativeChecksumBytes = new TextEncoder().encode(`${nativeArchiveDigest}\n`);
const nativeChecksumDigest = createHash("sha256").update(nativeChecksumBytes).digest("hex");

function nativePair(base: string): [object, object] {
  const url = `https://github.com/hraness/xcb/releases/download/v${version}`;
  return [
    {
      browser_download_url: `${url}/${base}.tar.gz`,
      digest: `sha256:${nativeArchiveDigest}`,
      id: 10,
      name: `${base}.tar.gz`,
      size: nativeArchiveBytes.byteLength,
      state: "uploaded",
    },
    {
      browser_download_url: `${url}/${base}.tar.gz.sha256`,
      digest: `sha256:${nativeChecksumDigest}`,
      id: 11,
      name: `${base}.tar.gz.sha256`,
      size: nativeChecksumBytes.byteLength,
      state: "uploaded",
    },
  ];
}

function release(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    assets: [
      {
        browser_download_url: `https://github.com/hraness/xcb/releases/download/v${version}/${releaseArchiveName(version)}`,
        digest: `sha256:${tarballDigest}`,
        id: 1,
        name: releaseArchiveName(version),
        size: tarball.byteLength,
        state: "uploaded",
      },
      {
        browser_download_url: `https://github.com/hraness/xcb/releases/download/v${version}/SHA256SUMS`,
        digest: `sha256:${checksumDigest}`,
        id: 2,
        name: "SHA256SUMS",
        size: checksum.byteLength,
        state: "uploaded",
      },
    ],
    draft: false,
    body: `Automated public release of @hraness/xcb@${version} from v${version}.`,
    immutable: true,
    name: `XCB v${version}`,
    prerelease: false,
    tag_name: `v${version}`,
    ...overrides,
  };
}

describe("public release distribution policy", () => {
  test("derives an older admitted release from its tag instead of newer current-main version metadata", () => {
    expect(releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/xcb",
      version: "9.9.9",
    }, "v0.8.1")).toBe("0.8.1");
    expect(() => releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/not-xcb",
    }, "v0.8.1")).toThrow("wrong public package");
    expect(() => releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/xcb",
    }, "latest")).toThrow("canonical stable version");
  });

  test("derives the exact scoped npm pack filename", () => {
    expect(releaseArchiveName(version)).toBe("hraness-xcb-0.8.1.tgz");
    expect(() => releaseArchiveName("latest")).toThrow("release version");
  });

  test("binds the closed package descriptor to its tag, archive, and manifest", () => {
    expect(releasePackageForName("@hraness/xcb")).toBe(rootReleasePackage);
    expect(() => releasePackageForName("@hraness/other")).toThrow("manifest identity");
    expect(() => releasePackageForName("xcb")).toThrow("manifest identity");
    expect(() => releasePackageForName("constructor")).toThrow("manifest identity");
    expect(() => releasePackageForName("hasOwnProperty")).toThrow("manifest identity");

    const root = releaseDistribution(rootReleasePackage);
    expect(root.releaseArchiveName(version)).toBe(releaseArchiveName(version));
    expect(root.releaseArchiveName("0.1.0")).toBe("hraness-xcb-0.1.0.tgz");
    expect(root.stableTag.exec(`v${version}`)?.[1]).toBe(version);
    expect(root.stableTag.test(`xcb-v${version}`)).toBe(false);
    expect(root.stableTag.test("v0.1.0-rc.1")).toBe(false);
    expect(() => root.releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/xcb",
    }, `xcb-v${version}`)).toThrow("canonical stable version");
  });

  test("requires MIT npm identity and public-repository provenance", () => {
    const parsed = parseNpmRelease({
      _npmUser: npmUser,
      name: "@hraness/xcb",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fxcb@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/xcb/-/xcb-${version}.tgz`,
      },
    }, version);
    expect(parsed.integrity).toBe("sha512-QUJDRA==");
    expect(() => parseNpmRelease({
      _npmUser: npmUser,
      name: "@hraness/xcb",
      version,
      license: "MIT",
      dist: {
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/xcb/-/xcb-${version}.tgz`,
      },
    }, version)).toThrow("attestations");
    expect(() => parseNpmRelease({
      _npmUser: npmUser,
      name: "@hraness/xcb",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@attacker%2fxcb@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/xcb/-/xcb-${version}.tgz`,
      },
    }, version)).toThrow("provenance");
    expect(() => parseNpmRelease({
      _npmUser: {
        ...npmUser,
        trustedPublisher: { id: "github", oidcConfigId: "not-a-uuid" },
      },
      name: "@hraness/xcb",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fxcb@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/xcb/-/xcb-${version}.tgz`,
      },
    }, version)).toThrow("trusted-publisher provenance");
    const exactRelease = {
      name: "@hraness/xcb",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fxcb@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/xcb/-/xcb-${version}.tgz`,
      },
    };
    for (const badUser of [
      undefined,
      { ...npmUser, name: "token publisher" },
      { ...npmUser, email: "publisher@example.invalid" },
      { ...npmUser, trustedPublisher: { ...npmUser.trustedPublisher, id: "other" } },
    ]) {
      expect(() => parseNpmRelease({ ...exactRelease, _npmUser: badUser }, version)).toThrow();
    }
  });

  test("requires two exact immutable GitHub artifacts and their bytes", () => {
    const parsed = parseGitHubRelease(release(), version);
    expect(parsed.natives).toHaveLength(0);
    expect(() => assertReleaseAssetBytes(
      parsed,
      tarball,
      checksum,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
    )).not.toThrow();
    expect(() => parseGitHubRelease(release({ assets: [] }), version)).toThrow("two exact release artifacts");
  });

  test("admits native archive/checksum pairs bound to the exact release version", () => {
    const parsed = parseGitHubRelease(release({
      assets: [...release().assets, ...nativePair("xcb-0.8.1-linux-x86_64"), ...nativePair("xcb-0.8.1-darwin-aarch64")],
    }), version);
    expect(parsed.natives).toHaveLength(2);
    expect(parsed.natives[0]?.archive.name).toBe("xcb-0.8.1-linux-x86_64.tar.gz");
    expect(parsed.natives[1]?.archive.name).toBe("xcb-0.8.1-darwin-aarch64.tar.gz");
    const pair = parsed.natives.find((candidate) => candidate.archive.name === "xcb-0.8.1-linux-x86_64.tar.gz");
    expect(pair?.checksum.name).toBe("xcb-0.8.1-linux-x86_64.tar.gz.sha256");
    expect(() => assertNativeAssetBytes(
      pair!,
      nativeArchiveBytes,
      nativeChecksumBytes,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
    )).not.toThrow();
  });

  test("rejects malformed, unpaired, foreign, and unbounded native assets", () => {
    const compatAssets = release().assets;
    const pair = nativePair("xcb-0.8.1-linux-x86_64");
    const foreignVersion = nativePair("xcb-0.8.2-linux-x86_64");
    for (const assets of [
      [pair[0]], // archive without adjacent checksum
      [pair[1]], // checksum without archive
      [pair[0], pair[1], pair[0]], // duplicate archive name
      foreignVersion, // native version must equal the release version
      nativePair("xcb-v0.8.1-linux-x86_64"),
      nativePair("xcb-0.8.1-Linux-x86_64"),
      nativePair("xcb-0.8.1-linux-x86_64.tgz"),
      nativePair("agentmixer-v0.8.1-linux-x86_64"),
      nativePair("xcb-0.8.1-linux"),
      [{ ...pair[0], name: "SHA256SUMS" }, pair[1]],
      [{ ...pair[0], browser_download_url: "https://example.invalid/x" }, pair[1]],
    ]) {
      expect(() => parseGitHubRelease(release({
        assets: [...compatAssets, ...assets],
      }), version)).toThrow();
    }
    expect(() => parseGitHubRelease(release({
      assets: [...compatAssets, pair[0], nativePair("xcb-0.8.1-darwin-aarch64")[0]],
    }), version)).toThrow("adjacent archive or checksum");
    expect(() => parseGitHubRelease(release({
      assets: [...compatAssets, ...foreignVersion],
    }), version)).toThrow("xcb-0.8.1-<os>-<arch>");
    // Odd asset counts and counts beyond the native bound fail before parsing.
    expect(() => parseGitHubRelease(release({
      assets: [...compatAssets, pair[0], pair[1], nativePair("xcb-0.8.1-darwin-aarch64")[0]],
    }), version)).toThrow("complete native pairs");
    const unbounded = Array.from({ length: 17 }, (_, index) =>
      nativePair(`xcb-0.8.1-os${index}-x86_64`)).flat();
    expect(() => parseGitHubRelease(release({
      assets: [...compatAssets, ...unbounded],
    }), version)).toThrow("complete native pairs");
  });

  test("native file pairing validates the exact asset name set", () => {
    expect(nativeAssetFilePairs([
      "xcb-0.8.1-linux-x86_64.tar.gz",
      "xcb-0.8.1-linux-x86_64.tar.gz.sha256",
      "xcb-0.8.1-darwin-aarch64.tar.gz.sha256",
      "xcb-0.8.1-darwin-aarch64.tar.gz",
    ], version)).toEqual([
      { archive: "xcb-0.8.1-linux-x86_64.tar.gz", checksum: "xcb-0.8.1-linux-x86_64.tar.gz.sha256" },
      { archive: "xcb-0.8.1-darwin-aarch64.tar.gz", checksum: "xcb-0.8.1-darwin-aarch64.tar.gz.sha256" },
    ]);
    expect(nativeAssetFilePairs([], version)).toEqual([]);
    for (const names of [
      ["xcb-0.8.1-linux-x86_64.tar.gz"],
      ["xcb-0.8.1-linux-x86_64.tar.gz.sha256"],
      ["xcb-0.8.2-linux-x86_64.tar.gz", "xcb-0.8.2-linux-x86_64.tar.gz.sha256"],
      ["xcb-0.8.1-linux-x86_64.tar.gz", "xcb-0.8.1-linux-x86_64.tar.gz"],
      ["xcb-0.8.1-linux-x86_64.tar.gz", "other.sha256"],
    ]) {
      expect(() => nativeAssetFilePairs(names, version)).toThrow();
    }
  });

  test("native byte assertion binds digest, size, and checksum text", () => {
    const pair = parseGitHubRelease(release({
      assets: [...release().assets, ...nativePair("xcb-0.8.1-linux-x86_64")],
    }), version).natives[0]!;
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    expect(() => assertNativeAssetBytes(
      pair, nativeArchiveBytes, nativeChecksumBytes, sha256,
    )).not.toThrow();
    expect(() => assertNativeAssetBytes(
      pair, nativeArchiveBytes, tarball, sha256,
    )).toThrow("size or digest");
    const wrongText = new TextEncoder().encode(`${"0".repeat(64)}\n`);
    const wrongTextPair = {
      archive: pair.archive,
      checksum: {
        ...pair.checksum,
        digest: `sha256:${sha256(wrongText)}`,
        size: wrongText.byteLength,
      },
    };
    expect(() => assertNativeAssetBytes(
      wrongTextPair, nativeArchiveBytes, wrongText, sha256,
    )).toThrow("does not describe");
    const wrongDigestPair = {
      archive: { ...pair.archive, digest: `sha256:${"0".repeat(64)}` },
      checksum: pair.checksum,
    };
    expect(() => assertNativeAssetBytes(
      wrongDigestPair, nativeArchiveBytes, nativeChecksumBytes, sha256,
    )).toThrow("size or digest");
  });
});
