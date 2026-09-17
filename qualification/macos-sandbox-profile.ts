/** Experimental fixture only. This is not a production qualification or launch option. */
export function syntheticMacSandbox(input: { executable: string; scratch: readonly string[]; port: number; createParents?: readonly string[]; runtimeSurface?: boolean }): string {
  if (process.platform !== "darwin" || !Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("INVALID_SYNTHETIC_SANDBOX");
  const literal = (path: string) => {
    if (!path.startsWith("/") || /[\x00-\x1f"\\]/u.test(path)) throw new Error("INVALID_SYNTHETIC_SANDBOX_PATH");
    return `"${path}"`;
  };
  return `(version 1)
(deny default)
(allow process-exec (literal ${literal(input.executable)}))
(allow file-read* (literal ${literal(input.executable)})
  (subpath "/System/Library") (subpath "/usr/lib") (subpath "/Library/Apple/System/Library")
  (subpath "/System/Cryptexes/OS")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (literal "/dev/null"))
(allow file-read-data file-write-data (literal "/dev/fd/0") (literal "/dev/fd/1") (literal "/dev/fd/2"))
(allow file-map-executable (literal ${literal(input.executable)})
  (subpath "/System/Library") (subpath "/usr/lib") (subpath "/System/Cryptexes/OS") (subpath "/System/Volumes/Preboot/Cryptexes/OS"))
(allow file-read* (literal "/") (path-ancestors "/System/Cryptexes/OS") (path-ancestors "/System/Volumes/Preboot/Cryptexes/OS"))
${input.scratch.map(path => `(allow file-read* file-write* (subpath ${literal(path)}))`).join("\n")}
(allow file-read-metadata (path-ancestors ${literal(input.executable)})${input.scratch.map(path => ` (path-ancestors ${literal(path)})`).join("")})
${(input.createParents ?? []).map(path => `(allow file-read-metadata (literal ${literal(path)}))`).join("\n")}
${input.runtimeSurface ? `(allow process-fork)
(allow file-read* (literal "/dev/dtracehelper")
  (literal "/etc/resolv.conf") (literal "/private/etc/resolv.conf") (literal "/etc/hosts") (literal "/private/etc/hosts")
  (subpath "/etc") (subpath "/private/etc") (subpath "/var/db/timezone") (subpath "/private/var/db/timezone")
  (subpath "/usr/share") (subpath "/Library/Preferences") (subpath "/Library/Apple") (subpath "/System/Cryptexes/App"))
(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/private") (literal "/Users") (literal "/Library")
  (literal "/tmp") (literal "/private/tmp") (literal "/private/etc") (literal "/private/var") (literal "/System") (literal "/usr") (literal "/home"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.SystemConfiguration.DNSConfiguration"))
(allow file-ioctl (literal "/dev/null") (subpath "/dev/fd"))
` : ""}(allow sysctl-read)
(allow process-info* (target self))
(allow signal (target self))
${input.runtimeSurface ? `(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog"))
` : ""}(allow network-outbound (remote tcp "localhost:${input.port}"))
`;
}
