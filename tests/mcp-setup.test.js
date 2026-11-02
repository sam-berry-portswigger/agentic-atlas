import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assistantSetup } from "../shared/mcp-setup.js";
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
  assert.match(setup.prompt, /do not install a separate skill or rules entry/);
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

test("one setup connects every platform to the board without a second skill or prompt", () => {
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
    assert.match(
      setup.prompt,
      /do not install a separate skill or rules entry/,
    );
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
      /Do not claim proactive board use has been verified/,
    );
    for (const tool of [
      "atlas_tasks",
      "atlas_create_task",
      "atlas_update_task",
      "atlas_streams",
      "atlas_report_session",
    ])
      assert.ok(setup.prompt.includes(tool));
    assert.doesNotMatch(
      setup.prompt,
      /Move your task to doing/,
      "workflow is supplied by the server, not duplicated in setup",
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
