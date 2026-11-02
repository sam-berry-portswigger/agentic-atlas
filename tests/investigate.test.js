import test from "node:test";
import assert from "node:assert/strict";
import {
  investigationInput,
  investigationPlan,
  INVESTIGATION_LIMITS,
} from "../server/investigate.js";
test("planner input is capped even for maximum questions, context and query history", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    text: "evidence ".repeat(1000),
    project: "desktop",
    role: "assistant",
    timestamp: "2026-10-27T00:00:00Z",
  }));
  const prompt = investigationInput(
    "q".repeat(4000),
    "c".repeat(4000),
    rows,
    Array(6).fill("query ".repeat(1000)),
    1,
  );
  assert.ok(prompt.length <= INVESTIGATION_LIMITS.plannerCharacters);
  assert.ok(JSON.parse(prompt).evidence.length);
});
test("planner queries are bounded, deduplicated and malformed plans are rejected", () => {
  const seen = new Set(["previous query"]);
  const plan = investigationPlan(
    JSON.stringify({
      done: false,
      queries: [
        "previous query",
        "new query",
        "NEW QUERY",
        "x".repeat(301),
        "other query",
        "third query",
        "fourth query",
      ],
    }),
    seen,
    2,
  );
  assert.deepEqual(plan.queries, ["new query", "other query"]);
  assert.equal(investigationPlan("not JSON", seen, 3), null);
  assert.equal(
    investigationPlan('{"done":"true","queries":[]}', seen, 3),
    null,
  );
});

test(
  "agent searches, reads full decisions, supersedes older CSV plans and respects cancellation",
  { timeout: 15000 },
  async () => {
    const http = await import("node:http");
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    let cancelled = 0;
    const calls = [];
    const mock = http.createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      const data = JSON.parse(body);
      calls.push({ route: req.url, ...data });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/embed")
        return res.end(
          JSON.stringify({
            embeddings: [/activation race/i.test(data.input) ? [0, 1] : [1, 0]],
          }),
        );
      const input = JSON.parse(data.prompt);
      if (
        data.system.startsWith("Review provisional findings") ||
        data.system.startsWith("Reconcile the current status")
      ) {
        const decisions = (
          input.checks ||
          input.findings.map((finding) => ({
            finding,
            evidence: input.evidence,
          }))
        ).map(({ finding, evidence }) => ({
          id: finding.id,
          state: evidence.some((row) => row.id === "decision")
            ? "superseded"
            : "unknown",
          note: "sample metrics is sufficient for release; CSV is no longer required.",
          sources: evidence.some((row) => row.id === "decision")
            ? ["decision"]
            : evidence.slice(0, 1).map((row) => row.id),
        }));
        return res.end(
          JSON.stringify({ response: JSON.stringify({ decisions }) }),
        );
      }
      if (/cancel|deadline/.test(input.question)) {
        res.on("close", () => {
          if (!res.writableEnded) cancelled++;
        });
        res.write("{");
        return;
      }
      if (
        input.question === "Generally, what have I left unresolved this week?"
      ) {
        if (input.round === 0)
          return res.end(
            JSON.stringify({
              response: JSON.stringify({
                done: false,
                findings: [
                  {
                    subject: "CSV model",
                    state: "open",
                    assessment:
                      "An older plan proposes building an CSV model; later scope is unverified.",
                    sourceIds: ["csvplan"],
                    checkQuery: "CSV model release decision",
                  },
                ],
                actions: [{ type: "read", ids: ["csvplan"] }],
              }),
            }),
          );
        const decision = input.evidence.find((row) => row.id === "decision");
        assert.ok(
          decision?.text.includes("sample metrics is sufficient for release"),
          "reasoning reads the full decision, beyond the first 500 characters",
        );
        return res.end(
          JSON.stringify({
            response: JSON.stringify({
              done: true,
              findings: [
                {
                  subject: "CSV model",
                  state: input.round > 1 ? "open" : "superseded",
                  assessment:
                    "The later user decision removes the modelling requirement; sample metrics is sufficient for release.",
                  sourceIds: input.round > 1 ? ["csvplan"] : ["decision"],
                  checkQuery: "CSV model release decision",
                },
              ],
              actions:
                input.round === 1 ? [{ type: "read", ids: ["decision"] }] : [],
            }),
          }),
        );
      }
      res.end(
        JSON.stringify({
          response: JSON.stringify(
            input.round === 0
              ? { done: false, queries: ["activation race", "ACTIVATION RACE"] }
              : { done: true, queries: [] },
          ),
        }),
      );
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const script = `
 import assert from 'node:assert/strict';
 import {DatabaseSync} from 'node:sqlite';
 import {vectorBuffer} from './server/db.js';
 import {investigate,INVESTIGATION_LIMITS} from './server/investigate.js';
 import {retrieveSearchEvidence} from './server/search-retrieval.js';
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,model TEXT,vector BLOB);CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED,text)');
 const add=(id,text,vector,project='app',date='2026-10-20T12:00:00Z')=>{db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,project,'Plan','assistant',date,text,'embeddinggemma',vectorBuffer(vector));db.prepare('INSERT INTO chunks_fts VALUES(?,?)').run(id,text);};
 for(let i=0;i<40;i++)add('plan'+i,'Battle testing planned activation-race scenarios. Plan number '+i+'.',[1,0]);
 add('outcome','Activation race resolved. Retesting passed, verified in the final report.',[0,1]);
 add('future','Activation race has future secret data.',[0,1],'app','2026-12-01T12:00:00Z');
 add('private','Activation race private data must never be returned.',[0,1],'private');
 const scope={project:'app',end:'2026-10-27T00:00:00Z'};
 const query='What was the result of battle testing?';
 const initial=await retrieveSearchEvidence(db,{query,...scope});
 assert.ok(!initial.results.some(row=>row.id==='outcome'));
 assert.ok(!initial.recent.some(row=>row.id==='outcome'));
 const investigated=await investigate(db,{query,...scope});
 assert.ok(investigated.results.some(row=>row.id==='outcome'),'follow-up query discovers evidence missing initially');
 assert.ok(investigated.results.every(row=>row.project==='app'&&row.timestamp<scope.end));
 assert.equal(investigated.investigation.queries.length,2);assert.equal(investigated.investigation.rounds,2);assert.equal(investigated.investigation.reason,'sufficient');
 await assert.rejects(investigate(db,{query:'cancel investigation',...scope},{signal:AbortSignal.timeout(100)}),{name:'TimeoutError'});
 const timed=await investigate(db,{query:'deadline investigation',...scope},{limits:{...INVESTIGATION_LIMITS,milliseconds:100}});
 assert.equal(timed.investigation.reason,'time-budget');assert.ok(timed.results.length);assert.equal(timed.investigation.limited,true);

 add('csvplan','We need to build an CSV model and request the data owner role before release.',[1,0],'app','2026-10-24T12:00:00Z');
 const decision='Discussion context and release notes. '.repeat(25)+'We will not build that. Mike confirmed data reaching sample metrics is sufficient for release.';
 db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)').run('decision','csvplan','app','Plan','user','2026-10-27T10:00:00Z',decision,'embeddinggemma',vectorBuffer([0,1]));
 db.prepare('INSERT INTO chunks_fts VALUES(?,?)').run('decision',decision);
 const status=await investigate(db,{query:'Generally, what have I left unresolved this week?',project:'app',end:'2026-10-28T00:00:00Z'});
 const finding=status.investigation.findings.find(item=>item.subject==='CSV model');
 assert.equal(finding.state,'superseded');assert.ok(status.investigation.reads.includes('csvplan'));assert.ok(status.investigation.reads.includes('decision'));
 assert.ok(status.investigation.rounds>=3,'new data is assessed, read, and reassessed before answering');
 assert.ok(status.priority.some(row=>row.id==='decision'));
 const {searchContext,buildSearchAnswerRequest}=await import('./server/search-answer.js');
 const selected=searchContext(db,status.results,{project:'app',end:'2026-10-28T00:00:00Z'},4000,{recent:status.recent,priority:status.priority});
 assert.ok(selected.sources.some(row=>row.id==='decision'),'decisive later correction survives the final context cap');
 const request=buildSearchAnswerRequest('mock','Generally, what have I left unresolved this week?',{},selected.sources,{investigation:status.investigation,evidenceThrough:'2026-10-27T10:00:00Z'});
 assert.ok(request.prompt.includes('sample metrics is sufficient for release'));assert.equal(JSON.parse(request.prompt).investigation.findings.find(item=>item.subject==='CSV model').state,'superseded');
 db.close();console.log('verified');
`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 0, output);
      assert.ok(output.includes("verified"));
      assert.ok(
        cancelled >= 2,
        "both cancellation and retrieval deadline abort local model work",
      );
      assert.ok(
        calls
          .filter((call) => call.route === "/api/embed")
          .some((call) => /activation race/i.test(call.input)),
      );
    } finally {
      child.kill();
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
    }
  },
);

test("investigation rejects invented findings and source reads outside retrieved scope", () => {
  const plan = investigationPlan(
    JSON.stringify({
      done: false,
      findings: [
        {
          subject: "Fake",
          state: "resolved",
          assessment: "Uncited assertion",
          sourceIds: ["private"],
        },
        {
          subject: "Real",
          state: "open",
          assessment: "Needs verification",
          sourceIds: ["allowed"],
        },
      ],
      actions: [{ type: "read", ids: ["private", "allowed"] }],
    }),
    new Set(),
    3,
    new Set(["allowed"]),
  );
  assert.deepEqual(plan.reads, ["allowed"]);
  assert.equal(plan.findings.length, 1);
  assert.equal(plan.findings[0].subject, "Real");
});
