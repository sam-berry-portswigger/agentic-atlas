import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const environment = path.join(root, ".atlas", "projection-venv");
const candidates = [
  ...new Set(
    [
      process.env.ATLAS_PYTHON,
      "python3.12",
      "python3.13",
      "python3.14",
      "python3.11",
      "python3",
    ].filter(Boolean),
  ),
];
const python = candidates.find((candidate) => {
  const result = spawnSync(
    candidate,
    [
      "-c",
      "import sys;sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,14) else 1)",
    ],
    { stdio: "ignore" },
  );
  return result.status === 0;
});
if (!python) {
  console.error(
    "Install Python 3.11–3.14, then rerun npm run setup:projection. ATLAS_PYTHON can select its executable.",
  );
  process.exit(1);
}
execFileSync(python, ["-m", "venv", environment], { stdio: "inherit" });
const executable = path.join(environment, "bin", "python");
execFileSync(
  executable,
  [
    "-m",
    "pip",
    "install",
    "-r",
    path.join(root, "requirements-projection.txt"),
  ],
  { stdio: "inherit" },
);
execFileSync(
  executable,
  [
    "-c",
    "import sklearn,umap;print('Local map runtime ready: UMAP '+umap.__version__+' / scikit-learn '+sklearn.__version__)",
  ],
  { stdio: "inherit" },
);
