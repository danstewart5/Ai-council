// Local tests: run `node test/test.js`. Mocks fetch — no network or API key needed.
const assert = require("assert");
const path = require("path");

process.env.OPENROUTER_API_KEY = "test-key";
delete process.env.MONTHLY_BUDGET;

const fn = require(path.join(__dirname, "../netlify/functions/council/council.js"));
const { COUNCIL, FINAL, MAX_TOKENS } = require(path.join(__dirname, "../netlify/functions/council/models.js"));
const { renderMarkdown } = require(path.join(__dirname, "../public/md.js"));

const calls = [];
let failModel = null;
let statusOverride = null;

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url, body, auth: opts.headers.Authorization });
  if (statusOverride) {
    return { ok: false, status: statusOverride, json: async () => ({ error: { message: "nope" } }) };
  }
  if (body.model === failModel) {
    return { ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) };
  }
  const cost = { [COUNCIL[0].id]: 0.001, [COUNCIL[1].id]: 0.002, [COUNCIL[2].id]: 0.004, [FINAL.id]: 0.02 }[body.model];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: `answer from ${body.model}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, cost },
    }),
  };
};

const post = (b) => fn.handler({ httpMethod: "POST", body: JSON.stringify(b) }).then((r) => ({ ...r, data: JSON.parse(r.body) }));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

(async () => {
  // GET config
  let r = await fn.handler({ httpMethod: "GET" });
  let d = JSON.parse(r.body);
  assert.strictEqual(d.budget, 20);
  assert.strictEqual(d.keyConfigured, true);
  assert.strictEqual(d.modes.quick.length, 2);
  assert.strictEqual(d.modes.full.length, 3);
  process.env.MONTHLY_BUDGET = "35.5";
  d = JSON.parse((await fn.handler({ httpMethod: "GET" })).body);
  assert.strictEqual(d.budget, 35.5);
  process.env.MONTHLY_BUDGET = "abc";
  d = JSON.parse((await fn.handler({ httpMethod: "GET" })).body);
  assert.strictEqual(d.budget, 20);

  // Round 1 full: 3 parallel calls, usage requested, caps applied, cost summed
  calls.length = 0;
  r = await post({ round: 1, mode: "full", question: "What is 2+2?" });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(calls.length, 3);
  calls.forEach((c) => {
    assert.strictEqual(c.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.deepStrictEqual(c.body.usage, { include: true });
    assert.strictEqual(c.body.max_tokens, MAX_TOKENS.round1);
    assert.strictEqual(c.auth, "Bearer test-key");
  });
  close(r.data.cost, 0.007);
  const r1 = r.data.answers;

  // Round 1 quick: 2 calls
  calls.length = 0;
  r = await post({ round: 1, mode: "quick", question: "Hi" });
  assert.strictEqual(calls.length, 2);
  close(r.data.cost, 0.003);
  assert.deepStrictEqual(calls.map((c) => c.body.model), [COUNCIL[0].id, COUNCIL[1].id]);

  // Round 2: each model sees the others' answers but its own as "earlier answer"
  calls.length = 0;
  r = await post({ round: 2, mode: "full", question: "What is 2+2?", previous: r1 });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(calls.length, 3);
  calls.forEach((c) => {
    const msg = c.body.messages[1].content;
    assert.strictEqual(c.body.max_tokens, MAX_TOKENS.round2);
    const othersPart = msg.split("Other council members' answers:")[1];
    assert.ok(!othersPart.includes(`answer from ${c.body.model}`), "own answer should not be in 'others'");
    COUNCIL.filter((m) => m.id !== c.body.model).forEach((m) => assert.ok(othersPart.includes(`answer from ${m.id}`)));
  });
  close(r.data.cost, 0.007);

  // Round 3: one call to final model
  calls.length = 0;
  r = await post({ round: 3, mode: "full", question: "What is 2+2?", previous: r.data.answers });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.model, FINAL.id);
  assert.strictEqual(calls[0].body.max_tokens, MAX_TOKENS.final);
  close(r.data.cost, 0.02);
  assert.ok(r.data.final.text.includes(FINAL.id));

  // Final prompt asks for a clear recommendation to approve
  assert.ok(/approve/i.test(calls[0].body.messages[0].content));
  assert.ok(/### Recommendation/.test(calls[0].body.messages[0].content));
  const finalText = r.data.final.text;

  // Critique: cheap models critique the final answer in light of feedback, in parallel, round-2 cap
  calls.length = 0;
  r = await post({ round: "critique", mode: "full", question: "Q", finalText, feedback: "too generic, focus on Nanaimo trades" });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.data.round, "critique");
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls.map((c) => c.body.model), COUNCIL.map((m) => m.id));
  calls.forEach((c) => {
    assert.strictEqual(c.body.max_tokens, MAX_TOKENS.round2);
    assert.deepStrictEqual(c.body.usage, { include: true });
    const msg = c.body.messages[1].content;
    assert.ok(msg.includes(finalText) && msg.includes("Nanaimo trades"));
  });
  close(r.data.cost, 0.007);
  const critiques = r.data.answers;

  // Critique in quick mode uses 2 models
  calls.length = 0;
  r = await post({ round: "critique", mode: "quick", question: "Q", finalText, feedback: "fb" });
  assert.strictEqual(calls.length, 2);
  close(r.data.cost, 0.003);

  // Revise without critiques: one Opus call with question, council answers, previous final, feedback
  calls.length = 0;
  r = await post({ round: "revise", mode: "full", question: "Original Q", previous: r1, finalText, feedback: "shorter please" });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.data.round, "revise");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.model, FINAL.id);
  assert.strictEqual(calls[0].body.max_tokens, MAX_TOKENS.final);
  let msg = calls[0].body.messages[1].content;
  assert.ok(msg.includes("Original Q") && msg.includes(finalText) && msg.includes("shorter please"));
  COUNCIL.forEach((m) => assert.ok(msg.includes(`answer from ${m.id}`)));
  assert.ok(!msg.includes("Council critiques"));
  assert.ok(/approve/i.test(calls[0].body.messages[0].content));
  close(r.data.cost, 0.02);

  // Revise with critiques included
  calls.length = 0;
  r = await post({ round: "revise", mode: "full", question: "Q", previous: r1, finalText, feedback: "fb", critiques });
  msg = calls[0].body.messages[1].content;
  assert.ok(msg.includes("Council critiques"));
  close(r.data.cost, 0.02);

  // Revise/critique validation
  assert.strictEqual((await post({ round: "revise", mode: "full", question: "Q", finalText, feedback: " " })).statusCode, 400);
  assert.strictEqual((await post({ round: "critique", mode: "full", question: "Q", feedback: "x" })).statusCode, 400);
  assert.strictEqual((await post({ round: "bogus", mode: "full", question: "Q" })).statusCode, 400);

  // Revise failure (402) -> 502 with friendly message
  statusOverride = 402;
  r = await post({ round: "revise", mode: "quick", question: "Q", previous: [], finalText, feedback: "fb" });
  assert.strictEqual(r.statusCode, 502);
  assert.ok(/credits/.test(r.data.error));
  statusOverride = null;

  // Partial failure in round 1: still 200, failing model has error, cost of others summed
  failModel = COUNCIL[1].id;
  r = await post({ round: 1, mode: "full", question: "x" });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(r.data.answers[1].error);
  close(r.data.cost, 0.005);
  failModel = null;

  // Previous answers from models not in this mode are ignored (quick ignores model 3)
  calls.length = 0;
  r = await post({ round: 3, mode: "quick", question: "x", previous: [{ model: COUNCIL[2].id, text: "hi" }] });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(calls.length, 0);

  // All fail with 401 -> 502 + friendly key message
  statusOverride = 401;
  r = await post({ round: 1, mode: "quick", question: "x" });
  assert.strictEqual(r.statusCode, 502);
  assert.ok(/API key/.test(r.data.error));
  statusOverride = 402;
  r = await post({ round: 3, mode: "quick", question: "x", previous: [{ model: COUNCIL[0].id, text: "hi" }] });
  assert.strictEqual(r.statusCode, 502);
  assert.ok(/credits/.test(r.data.error));
  statusOverride = null;

  // Validation
  assert.strictEqual((await post({ round: 1, mode: "huge", question: "x" })).statusCode, 400);
  assert.strictEqual((await post({ round: 1, mode: "quick", question: "  " })).statusCode, 400);
  assert.strictEqual((await post({ round: 9, mode: "quick", question: "x" })).statusCode, 400);
  assert.strictEqual((await post({ round: 1, mode: "quick", question: "x".repeat(7000) })).statusCode, 400);
  assert.strictEqual((await fn.handler({ httpMethod: "POST", body: "{bad" })).statusCode, 400);
  assert.strictEqual((await fn.handler({ httpMethod: "PUT" })).statusCode, 405);

  // Missing key
  delete process.env.OPENROUTER_API_KEY;
  r = await post({ round: 1, mode: "quick", question: "x" });
  assert.strictEqual(r.statusCode, 500);
  assert.ok(/OPENROUTER_API_KEY/.test(r.data.error));
  d = JSON.parse((await fn.handler({ httpMethod: "GET" })).body);
  assert.strictEqual(d.keyConfigured, false);

  // Markdown renderer: escapes HTML, renders basics, blocks javascript: links
  const html = renderMarkdown(
    "# Title\n**bold** and *it* and `code`\n\n- a\n- b\n\n1. one\n2. two\n\n<script>alert(1)</script>\n[x](javascript:alert(1)) [ok](https://example.com)\n```\n<b>raw</b>\n```"
  );
  assert.ok(html.includes("<h3>Title</h3>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>it</em>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("<ul><li>a</li><li>b</li></ul>"));
  assert.ok(html.includes("<ol><li>one</li><li>two</li></ol>"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!/href="javascript/.test(html));
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(html.includes("<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>"));

  console.log("All tests passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
