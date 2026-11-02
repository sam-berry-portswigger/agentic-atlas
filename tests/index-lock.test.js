import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

test("index writers exclude one another and recover dead or abandoned worker locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-lock-"));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import {writeFileSync,utimesSync,existsSync} from 'node:fs';
      import {acquireIndexLock} from ${JSON.stringify(new URL("../server/index-lock.js", import.meta.url).href)};
      const file=${JSON.stringify(path.join(root, "index.lock"))};
      const release=acquireIndexLock();
      assert.throws(()=>acquireIndexLock(),/index update is running/);
      release();assert.equal(existsSync(file),false);
      const next=acquireIndexLock();next();
      writeFileSync(file,JSON.stringify({pid:2147483647,token:'dead-process'}));
      const recovered=acquireIndexLock();recovered();
      writeFileSync(file,JSON.stringify({pid:process.pid,token:'abandoned-worker'}));
      const old=new Date(Date.now()-60000);utimesSync(file,old,old);
      const abandoned=acquireIndexLock();abandoned();
      writeFileSync(file,'');utimesSync(file,old,old);
      const incomplete=acquireIndexLock();incomplete();
      assert.equal(existsSync(file),false);
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, ATLAS_DATA_DIR: root }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
