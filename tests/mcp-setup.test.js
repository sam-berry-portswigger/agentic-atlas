import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assistantSetup } from "../shared/mcp-setup.js";
import { atlasSkill, atlasDefaultRule } from "../shared/atlas-skill.js";
const launch = {
  command: "/Applications/Node's runtime/node",
  args: ["/tmp/Atlas's $(printf changed)/server/mcp.js"],
  env: { ATLAS_DATA_DIR: "/tmp/Atlas's private index" },
};
const projects = [
  "desktop",
  "model_brain_imaging",
  "O'Brien $(printf changed)",
];
function words(command) {
  const result = spawnSync(
    "/bin/sh",
    ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\0").slice(0, -1);
}
test("setup configuration preserves project restrictions and this installation's paths", () => {
  const setup = assistantSetup(
    launch,
    projects,
    "claude-desktop",
    "/Users/example/Library/Application Support/Claude/claude_desktop_config.json",
  );
  const entry = JSON.parse(setup.config).mcpServers.atlas;
  assert.equal(entry.command, launch.command);
  assert.deepEqual(entry.args, launch.args);
  assert.deepEqual(JSON.parse(entry.env.ATLAS_MCP_PROJECTS), projects);
  assert.equal(entry.env.ATLAS_DATA_DIR, launch.env.ATLAS_DATA_DIR);
  assert.match(setup.prompt, /merge the atlas entry/);
  assert.equal(setup.skill.content, atlasSkill());
  assert.match(setup.prompt, /atlas_report_session/);
});
test("CLI setup quotes apostrophes, spaces and shell substitutions literally", () => {
  const claude = words(
    assistantSetup(launch, projects, "claude-code", "").command,
  );
  assert.deepEqual(claude.slice(0, 4), ["claude", "mcp", "add-json", "atlas"]);
  const entry = JSON.parse(claude[4]);
  assert.equal(entry.command, launch.command);
  assert.deepEqual(entry.args, launch.args);
  assert.deepEqual(JSON.parse(entry.env.ATLAS_MCP_PROJECTS), projects);
  const codex = words(assistantSetup(launch, projects, "codex", "").command);
  assert.deepEqual(codex.slice(0, 4), ["codex", "mcp", "add", "atlas"]);
  assert.ok(codex.includes(`ATLAS_MCP_PROJECTS=${JSON.stringify(projects)}`));
  assert.deepEqual(codex.slice(codex.indexOf("--") + 1), [
    launch.command,
    ...launch.args,
  ]);
});
test("ChatGPT gets a connection brief rather than an unsupported install command", () => {
  const setup = assistantSetup(launch, projects, "chatgpt", "");
  assert.equal(setup.command, "");
  assert.equal(setup.skill, null);
  assert.match(setup.prompt, /Atlas currently provides stdio only/);
  assert.match(setup.prompt, /do not claim it is connected/);
});

test("all sessions is unrestricted, including when replacing an older restricted configuration", () => {
  const previous = {
    ...launch,
    env: { ...launch.env, ATLAS_MCP_PROJECTS: '["old-project"]' },
  };
  const setup = assistantSetup(previous, null, "claude-desktop", "");
  const entry = JSON.parse(setup.config).mcpServers.atlas;
  assert.equal(Object.hasOwn(entry.env, "ATLAS_MCP_PROJECTS"), false);
  assert.match(setup.prompt, /entire Atlas index/);
  assert.match(setup.prompt, /projects indexed later/);
  assert.match(setup.prompt, /Remove any previous ATLAS_MCP_PROJECTS/);
  const cli = words(assistantSetup(previous, null, "codex", "").command);
  assert.ok(!cli.some((word) => word.startsWith("ATLAS_MCP_PROJECTS=")));
  const deny = JSON.parse(
    assistantSetup(launch, [], "claude-desktop", "").config,
  ).mcpServers.atlas;
  assert.equal(
    deny.env.ATLAS_MCP_PROJECTS,
    "[]",
    "an explicit empty restriction never means all sessions",
  );
});

test("one setup includes a portable skill and persistent default-use guidance for supported clients", () => {
  for (const client of ["claude-desktop", "claude-code", "codex"]) {
    const setup = assistantSetup(
      launch,
      ["desktop"],
      client,
      "/tmp/claude.json",
    );
    assert.equal(Object.hasOwn(setup, "boardPrompt"), false);
    assert.match(setup.prompt, /only from these projects: \["desktop"\]/);
    assert.match(
      setup.prompt,
      /includes search, work streams and shared tasks/,
    );
    assert.equal(setup.skill.content, atlasSkill());
    assert.equal(setup.skill.defaultRule, atlasDefaultRule());
    assert.ok(setup.prompt.includes(setup.skill.content));
    assert.ok(setup.prompt.includes(setup.skill.defaultRule));
    assert.doesNotMatch(setup.prompt, /do not install a separate skill/);
    assert.match(
      setup.prompt,
      /Do not read session contents or create test tasks/,
    );
    assert.ok(
      setup.prompt.includes(
        `Verify the connection in ${setup.label}, not just in the assistant performing this setup`,
      ),
    );
    assert.match(setup.prompt, /report verification as pending/);
    assert.match(
      setup.prompt,
      /Report connection, skill installation and default-use instruction verification separately/,
    );
    for (const tool of [
      "atlas_tasks",
      "atlas_create_task",
      "atlas_update_task",
      "atlas_streams",
      "atlas_report_session",
    ])
      assert.ok(setup.prompt.includes(tool));
    assert.match(setup.skill.content, /^---\nname: atlas\n/);
    assert.match(
      setup.prompt,
      /must not remove an allowlist or broaden permissions/,
    );
  }
  const desktop = assistantSetup(
    launch,
    null,
    "claude-desktop",
    "/tmp/claude.json",
  );
  assert.match(desktop.prompt, /including desktop extensions/);
  assert.match(desktop.prompt, /Do not add a second Atlas connection/);
});

test("skill installation distinguishes local Code/Codex skills from Desktop account skills", () => {
  const code = assistantSetup(launch, null, "claude-code", "");
  assert.match(code.prompt, /~\/\.claude\/skills\/atlas\/SKILL.md/);
  assert.match(code.prompt, /~\/\.claude\/CLAUDE.md/);
  assert.match(code.prompt, /following symlinks/);
  const codex = assistantSetup(launch, null, "codex", "");
  assert.match(codex.prompt, /~\/\.agents\/skills\/atlas\/SKILL.md/);
  assert.match(codex.prompt, /respecting CODEX_HOME/);
  const desktop = assistantSetup(
    launch,
    null,
    "claude-desktop",
    "/tmp/claude.json",
  );
  assert.match(desktop.prompt, /Customize > Skills/);
  assert.match(
    desktop.prompt,
    /writing one alone does not install a Claude Desktop chat skill/,
  );
  assert.match(desktop.prompt, /pending, not installed/);
});

test("existing atlas-board installs can retain their name without widening access or embedding local paths", () => {
  const content = atlasSkill("atlas-board");
  assert.match(content, /^---\nname: atlas-board\n/);
  assert.ok(atlasDefaultRule("atlas-board").includes("atlas-board skill"));
  assert.doesNotMatch(
    content,
    /ATLAS_MCP_PROJECTS|\/Users\/|claude-embeddings/,
  );
  assert.throws(() => atlasSkill("../other-skill"), /Unsupported/);
  assert.throws(() => atlasDefaultRule("../other-skill"), /Unsupported/);
  // The workflow stays portable; the setup's connection enforces its own scope.
  assert.equal(
    assistantSetup(launch, [], "claude-code", "").skill.content,
    content.replace("name: atlas-board", "name: atlas"),
  );
});
