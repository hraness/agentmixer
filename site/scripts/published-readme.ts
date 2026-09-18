/** Bind installation coordinates to the admitted release, preserving all other prose. */
export function publishedReadme(source: string, sourceVersion: string, publishedVersion: string | null): string {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(sourceVersion)
    || sourceVersion.split(".").some((part) => BigInt(part) > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new TypeError("README installation version must be a canonical stable version.");
  }
  if (publishedVersion === null) {
    return source;
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(publishedVersion)
    || publishedVersion.split(".").some((part) => BigInt(part) > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new TypeError("README installation version must be a canonical stable version.");
  }
  const archive = (version: string) => `https://github.com/hraness/xcb/releases/download/v${version}/hraness-xcb-${version}.tgz`;
  const escaped = sourceVersion.replaceAll(".", "\\.");
  return source.replaceAll(archive(sourceVersion), archive(publishedVersion))
    .replace(new RegExp(`hraness/xcb#v${escaped}(?![\\w.-])`, "gu"), `hraness/xcb#v${publishedVersion}`)
    .replace(new RegExp(`@hraness/xcb@${escaped}(?![\\w.-])`, "gu"), `@hraness/xcb@${publishedVersion}`);
}
