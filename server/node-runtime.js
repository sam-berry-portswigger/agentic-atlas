import { accessSync, realpathSync, constants } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// process.execPath resolves Homebrew's symlink into a versioned Cellar path.
// Export a stable link only when it points to this exact, working runtime.
export function stableNodeCommand(
  executable = process.execPath,
  {
    resolve = realpathSync,
    access = accessSync,
    version = (candidate) =>
      execFileSync(candidate, ["-p", "process.versions.node"], {
        encoding: "utf8",
        timeout: 2000,
      }).trim(),
  } = {},
) {
  const match = /^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/.exec(
    executable,
  );
  if (!match) return executable;
  const [, prefix, formula] = match;
  let current;
  try {
    current = resolve(executable);
  } catch {}
  for (const candidate of [
    path.join(prefix, "opt", formula, "bin/node"),
    path.join(prefix, "bin/node"),
  ]) {
    try {
      access(candidate, constants.X_OK);
      if (current && resolve(candidate) === current) return candidate;
      // The Atlas process may still be running after Homebrew removed its
      // original binary. Accept the formula's stable successor if supported.
      if (!current) {
        const [major, minor] = version(candidate).split(".").map(Number);
        if (major > 22 || (major === 22 && minor >= 13)) return candidate;
      }
    } catch {}
  }
  return executable;
}
