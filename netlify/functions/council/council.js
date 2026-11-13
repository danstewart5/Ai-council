// AI Council — Netlify Function (no dependencies, uses built-in fetch).
//
// GET  /.netlify/functions/council           -> { budget, keyConfigured, modes, final }
// POST /.netlify/functions/council
//   { round: 1, mode, question }                         -> { round, answers[], cost }
//   { round: 2, mode, question, previous: answers[] }    -> { round, answers[], cost }
//   { round: 3, mode, question, previous: answers[] }    -> { round, final, cost }
//   { round: "critique", mode, question, finalText, feedback }                      -> { round, answers[], cost }
//   { round: "revise", mode, question, previous, finalText, feedback, critiques? }  -> { round, final, cost }
//
// The frontend calls once per round so each request stays short.

const { COUNCIL, FINAL, MAX_TOKENS, MODES } = require("./models");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CALL_TIMEOUT_MS = 25000;
const MAX_QUESTION_CHARS = 6000;
const MAX_ANSWER_CHARS = 8000;
const MAX_FEEDBACK_CHARS = 2000;

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function budget() {
  const n = parseFloat(process.env.MONTHLY_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function councilFor(mode) {
  const count = MODES[mode];
  if (!count) return null;
  return COUNCIL.slice(0, count);
}

function friendlyError(status, raw) {
  const msg = (raw && (raw.error?.message || raw.message)) || "";
  if (status === 401) return "OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in Netlify.";
  if (status === 402) return "Out of OpenRouter credits (402). Add credits at openrouter.ai.";
  if (status === 429) return "Rate limited by OpenRouter (429). Wait a moment and try again.";
  if (status === 404 || /not a valid model|no endpoints/i.test(msg))
    return `Model not available on OpenRouter${msg ? `: ${msg}` : ""}. Update models.js.`;
  if (status === 408 || status === 504) return "The model took too long to respond. Try again.";
  return `OpenRouter error${status ? ` (${status})` : ""}${msg ? `: ${msg}` : ""}`;
}

async function callModel(model, messages, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "AI Council",
      },
      body: JSON.stringify({
        model: model.id,
        messages,
        max_tokens: maxTokens,
        usage: { include: true },
      }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* non-JSON body */
    }

    if (!res.ok || !data || data.error) {
      return { model: model.id, name: model.name, text: "", cost: 0, error: friendlyError(res.status, data) };
    }

    const text = data.choices?.[0]?.message?.content || "";
    const cost = Number(data.usage?.cost) || 0;
    if (!text.trim()) {
      return { model: model.id, name: model.name, text: "", cost, error: "Model returned an empty answer." };
    }
    return { model: model.id, name: model.name, text: text.trim(), cost };
  } catch (err) {
    const error = err.name === "AbortError" ? "The model took too long to respond." : `Network error: ${err.message}`;
    return { model: model.id, name: model.name, text: "", cost: 0, error };
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_R1 =
  "You are one member of an AI council. Answer the user's question directly, accurately and concisely. " +
  "Use short paragraphs or bullet points. If you are unsure about something, say so.";

const SYSTEM_R2 =
  "You are one member of an AI council. You already answered a question; now you can see the other members' answers. " +
  "First, briefly list the main weaknesses, errors or gaps you see in the other answers (and in your own). " +
  "Then write your improved final answer. Format:\n\n**Critique**\n- ...\n\n**Improved answer**\n...";

const FINAL_FORMAT =
  "Format:\n" +
  "1. Start with a heading `### Recommendation` followed by a clear, decisive recommendation in 1–3 sentences " +
  "that the user can simply approve or send back.\n" +
  "2. Then the supporting answer: the key reasoning, details and next steps, concise, using short paragraphs or bullets.\n" +
  "3. End with two short sections:\n\n### Where they agreed\n- ...\n\n### Where they disagreed\n- ...\n\n" +
  "If they did not meaningfully disagree, say so in one line. Do not mention round numbers.";

const SYSTEM_R3 =
  "You are the chair of an AI council. Several models answered a question, critiqued each other and improved their answers. " +
  "Write the single best final answer for the user, combining the strongest points and fixing any errors. " +
  "The user will review your answer and either approve it or send it back with feedback, so present a clear recommendation " +
  "they can approve, not a list of vague options.\n\n" +
  FINAL_FORMAT;

const SYSTEM_CRITIQUE =
  "You are one member of an AI council. The chair wrote a final answer, and the user sent it back with feedback. " +
  "Briefly critique the final answer in light of the user's feedback: what is missing, wrong or off-target, and concrete " +
  "suggestions for how the revision should change. Use short bullet points. Do not rewrite the whole answer.";

const SYSTEM_REVISE =
  "You are the chair of an AI council. You previously wrote a final answer to the user's question, and the user sent it back " +
  "with feedback. Write a revised final answer that directly addresses the feedback, keeping what was good and using the " +
  "council's answers (and any council critiques) where helpful. Present a clear recommendation the user can approve.\n\n" +
  FINAL_FORMAT;

function cleanPrevious(previous, allowedIds) {
  if (!Array.isArray(previous)) return [];
  return previous
    .filter((a) => a && typeof a.text === "string" && a.text.trim() && allowedIds.includes(a.model))
    .map((a) => ({
      model: a.model,
      name: COUNCIL.find((m) => m.id === a.model)?.name || a.model,
      text: a.text.slice(0, MAX_ANSWER_CHARS),
    }));
}

function sumCost(items) {
  return items.reduce((s, a) => s + (Number(a.cost) || 0), 0);
}

function cleanText(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function councilText(items) {
  return items.map((a) => `--- ${a.name} ---\n${a.text}`).join("\n\n");
}

// Cheap models each critique the previous final answer in light of the user's feedback.
async function runCritique(question, members, finalText, feedback) {
  const userMsg =
    `Question:\n${question}\n\nThe chair's final answer:\n${finalText}\n\n` +
    `The user's feedback (why they sent it back):\n${feedback}\n\nGive your critique and suggestions.`;
  const answers = await Promise.all(
    members.map((m) =>
      callModel(
        m,
        [
          { role: "system", content: SYSTEM_CRITIQUE },
          { role: "user", content: userMsg },
        ],
        MAX_TOKENS.round2
      )
    )
  );
  return { round: "critique", answers, cost: sumCost(answers) };
}

// Opus revises its previous final answer using the feedback (and optional critiques).
async function runRevise(question, previous, finalText, feedback, critiques) {
  let userMsg =
    `Question:\n${question}\n\nCouncil members' answers:\n${councilText(previous) || "(none)"}\n\n` +
    `Your previous final answer:\n${finalText}\n\nThe user's feedback:\n${feedback}`;
  if (critiques.length) userMsg += `\n\nCouncil critiques of your previous answer:\n${councilText(critiques)}`;
  userMsg += "\n\nWrite the revised final answer.";
  const final = await callModel(
    FINAL,
    [
      { role: "system", content: SYSTEM_REVISE },
      { role: "user", content: userMsg },
    ],
    MAX_TOKENS.final
  );
  return { round: "revise", final, cost: final.cost || 0 };
}

async function runRound1(question, members) {
  const answers = await Promise.all(
    members.map((m) =>
      callModel(
        m,
        [
          { role: "system", content: SYSTEM_R1 },
          { role: "user", content: question },
        ],
        MAX_TOKENS.round1
      )
    )
  );
  return { round: 1, answers, cost: sumCost(answers) };
}

async function runRound2(question, members, previous) {
  const answers = await Promise.all(
    members.map((m) => {
      const own = previous.find((a) => a.model === m.id);
      const others = previous.filter((a) => a.model !== m.id);
      const othersText = others.map((a) => `--- ${a.name} ---\n${a.text}`).join("\n\n") || "(no other answers)";
      const userMsg =
        `Question:\n${question}\n\n` +
        `Your earlier answer:\n${own ? own.text : "(you did not answer earlier — answer now)"}\n\n` +
        `Other council members' answers:\n${othersText}\n\n` +
        "Critique the weaknesses, then give your improved answer.";
      return callModel(
        m,
        [
          { role: "system", content: SYSTEM_R2 },
          { role: "user", content: userMsg },
        ],
        MAX_TOKENS.round2
      );
    })
  );
  return { round: 2, answers, cost: sumCost(answers) };
}

async function runRound3(question, previous) {
  const body = previous.map((a) => `--- ${a.name} ---\n${a.text}`).join("\n\n");
  const final = await callModel(
    FINAL,
    [
      { role: "system", content: SYSTEM_R3 },
      { role: "user", content: `Question:\n${question}\n\nCouncil members' improved answers:\n${body}` },
    ],
    MAX_TOKENS.final
  );
  return { round: 3, final, cost: final.cost || 0 };
}

exports.handler = async (event) => {
  const method = event.httpMethod;

  if (method === "GET") {
    return json(200, {
      budget: budget(),
      keyConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      modes: {
        quick: councilFor("quick").map((m) => m.name),
        full: councilFor("full").map((m) => m.name),
      },
      final: FINAL.name,
    });
  }

  if (method !== "POST") return json(405, { error: "Method not allowed." });

  if (!process.env.OPENROUTER_API_KEY) {
    return json(500, {
      error: "Missing API key: set OPENROUTER_API_KEY in Netlify (Site configuration → Environment variables), then redeploy.",
    });
  }

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch (_) {
    return json(400, { error: "Invalid JSON body." });
  }

  const round = input.round === "critique" || input.round === "revise" ? input.round : Number(input.round);
  const members = councilFor(input.mode);
  const question = typeof input.question === "string" ? input.question.trim() : "";

  if (!members) return json(400, { error: 'mode must be "quick" or "full".' });
  if (!question) return json(400, { error: "Please enter a question." });
  if (question.length > MAX_QUESTION_CHARS)
    return json(400, { error: `Question is too long (max ${MAX_QUESTION_CHARS} characters).` });

  const ids = members.map((m) => m.id);

  try {
    if (round === 1) {
      const result = await runRound1(question, members);
      return roundResponse(result);
    }

    if (round === 2 || round === 3) {
      const previous = cleanPrevious(input.previous, ids);
      if (!previous.length) return json(400, { error: "No answers from the previous round to work with." });
      if (round === 2) return roundResponse(await runRound2(question, members, previous));
      const result = await runRound3(question, previous);
      if (result.final.error) return json(502, { error: result.final.error, cost: result.cost });
      return json(200, result);
    }

    if (round === "critique" || round === "revise") {
      const finalText = cleanText(input.finalText, MAX_ANSWER_CHARS);
      const feedback = cleanText(input.feedback, MAX_FEEDBACK_CHARS);
      if (!finalText) return json(400, { error: "Missing the previous final answer." });
      if (!feedback) return json(400, { error: "Please enter feedback for the council." });

      if (round === "critique") return roundResponse(await runCritique(question, members, finalText, feedback));

      const previous = cleanPrevious(input.previous, ids);
      const critiques = cleanPrevious(input.critiques, ids);
      const result = await runRevise(question, previous, finalText, feedback, critiques);
      if (result.final.error) return json(502, { error: result.final.error, cost: result.cost });
      return json(200, result);
    }

    return json(400, { error: 'round must be 1, 2, 3, "critique" or "revise".' });
  } catch (err) {
    return json(500, { error: `Server error: ${err.message}` });
  }
};

// Rounds 1–2: succeed if at least one model answered; report per-model errors.
function roundResponse(result) {
  const ok = result.answers.filter((a) => !a.error);
  if (!ok.length) {
    const first = result.answers[0]?.error || "All models failed.";
    return json(502, { error: `All council models failed. ${first}`, cost: result.cost, answers: result.answers });
  }
  return json(200, result);
}

// Exported for local tests.
exports._internal = { callModel, councilFor, budget, sumCost };
