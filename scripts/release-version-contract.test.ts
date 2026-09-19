import { expect, test } from "bun:test";

import { assertReleaseVersionContract } from "./release-version-contract.ts";

const packageSource = JSON.stringify({ version: "0.4.0" });
const cargoSource = `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.4.0"\nedition = "2024"\n`;
const manifests = {
  "crates/xcb-cli/Cargo.toml": `[dependencies]\nxcb-core = { version = "0.4.0", path = "../xcb-core" }\nxcb-runtime = { version = "0.4.0", path = "../xcb-runtime" }\n`,
};

test("release source versions bind the package, native binary and internal crates", () => {
  expect(assertReleaseVersionContract(packageSource, cargoSource, manifests)).toBe("0.4.0");
  expect(() => assertReleaseVersionContract(JSON.stringify({ version: "0.5.0" }), cargoSource, manifests))
    .toThrow("versions differ");
  expect(() => assertReleaseVersionContract(packageSource, cargoSource, {
    "crates/xcb-cli/Cargo.toml": `[dependencies]\nxcb-core = { version = "0.1.0", path = "../xcb-core" }\n`,
  })).toThrow("pins internal xcb version");
  expect(() => assertReleaseVersionContract(JSON.stringify({ version: "latest" }), cargoSource, manifests))
    .toThrow("stable version");
});


test("internal dependency version checks are independent of TOML field order", () => {
  for (const definition of [
    'xcb-core = { path = "../xcb-core", version = "0.1.0" }',
    'xcb-core = {\n path = "../xcb-core",\n version = "0.1.0"\n}',
    'xcb-core = { path = "../xcb-core" }',
  ]) {
    expect(() => assertReleaseVersionContract(packageSource, cargoSource, {
      "crates/xcb-cli/Cargo.toml": `[dependencies]\n${definition}\n`,
    })).toThrow("pins internal xcb version");
  }
});
