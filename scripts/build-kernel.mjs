/**
 * Compile the Rust kernel and copy the wasm into kernel/pkg,
 * which Vite imports as a static asset.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargo = process.env.CARGO ?? `${process.env.HOME}/.cargo/bin/cargo`;

const build = spawnSync(
  cargo,
  [
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    resolve(root, "kernel/Cargo.toml"),
  ],
  { stdio: "inherit", env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } },
);

if (build.status !== 0) process.exit(build.status ?? 1);

const from = resolve(root, "kernel/target/wasm32-unknown-unknown/release/io_kernel.wasm");
if (!existsSync(from)) {
  console.error("missing", from);
  process.exit(1);
}
const out = resolve(root, "web/src/wasm/io_kernel.wasm");
mkdirSync(dirname(out), { recursive: true });
copyFileSync(from, out);
console.log("wrote web/src/wasm/io_kernel.wasm");
