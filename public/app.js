(function () {
  "use strict";

  const API = "/.netlify/functions/council";
  const HISTORY_KEY = "aiCouncil.history.v1";
  const SPEND_KEY = "aiCouncil.spend.v1";
  const MAX_HISTORY = 100;

  const $ = (id) => document.getElementById(id);
  const els = {
    question: $("question"),
    quick: $("btn-quick"),
    full: $("btn-full"),
    quickSub: $("quick-sub"),
    fullSub: $("full-sub"),
    progress: $("progress"),
    progressText: $("progress-text"),
    notice: $("notice"),
    results: $("results"),
    spend: $("spend"),
    clear: $("btn-clear"),
    historyActions: $("history-actions"),
  };

  let budget = 20;
  let busy = false;

  // ---------- storage (always wrapped in try/catch) ----------
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* storage full or blocked */
    }
  }

  function monthKey() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function getSpent() {
    const s = load(SPEND_KEY, null);
    return s && s.month === monthKey() ? Number(s.total) || 0 : 0;
  }
  function addSpent(amount) {
    if (!amount) return;
    save(SPEND_KEY, { month: monthKey(), total: getSpent() + amount });
    renderSpend();
  }

  // ---------- formatting ----------
  function money(n) {
    n = Number(n) || 0;
    if (n === 0) return "$0.00";
    if (n < 0.01) return "$" + n.toFixed(4);
    return "$" + n.toFixed(2);
  }
  function budgetText(n) {
    return Number.isInteger(n) ? "$" + n : "$" + n.toFixed(2);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderSpend() {
    const spent = getSpent();
    els.spend.textContent = "This month: " + money(spent) + " of " + budgetText(budget);
    els.spend.classList.toggle("over", spent >= budget);
    els.spend.classList.toggle("warn", spent < budget && spent >= budget * 0.8);
    const over = spent >= budget;
    if (!busy) {
      els.quick.disabled = over;
      els.full.disabled = over;
    }
    if (over && !busy) {
      showNotice(
        "Monthly budget of " + budgetText(budget) + " reached (" + money(spent) +
          " spent). New questions are blocked until next month. You can raise MONTHLY_BUDGET in Netlify.",
        "warn"
      );
    }
  }

  function showNotice(msg, kind) {
    els.notice.textContent = msg;
    els.notice.className = "notice" + (kind ? " " + kind : "");
    els.notice.hidden = false;
  }
  function hideNotice() {
    els.notice.hidden = true;
  }

  function setBusy(on, text) {
    busy = on;
    els.quick.disabled = on;
    els.full.disabled = on;
    els.question.disabled = on;
    els.progress.hidden = !on;
    if (text) els.progressText.textContent = text;
    if (!on) renderSpend();
  }

  // ---------- API ----------
  async function post(body) {
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (_) {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      /* not JSON */
    }
    if (!data) {
      if (res.status === 404) throw new Error("Server function not found. Is the site deployed on Netlify (not opened as a local file)?");
      if (res.status === 502 || res.status === 504 || /timed out/i.test(raw))
        throw new Error("The server timed out (Netlify function time limit). Try Quick mode, or see the README about timeouts.");
      throw new Error("Unexpected server response (" + res.status + ").");
    }
    if (!res.ok) {
      const err = new Error(data.error || "Request failed (" + res.status + ").");
      err.cost = Number(data.cost) || 0;
      throw err;
    }
    return data;
  }

  async function loadConfig() {
    try {
      const res = await fetch(API, { method: "GET" });
      const data = await res.json();
      if (Number(data.budget) > 0) budget = Number(data.budget);
      if (data.modes) {
        els.quickSub.textContent = data.modes.quick.length + " models";
        els.fullSub.textContent = data.modes.full.length + " models";
        els.quick.title = data.modes.quick.join(", ") + " → " + data.final;
        els.full.title = data.modes.full.join(", ") + " → " + data.final;
      }
      if (data.keyConfigured === false) {
        showNotice("Missing API key: set OPENROUTER_API_KEY in Netlify (Site configuration → Environment variables), then redeploy.");
      }
    } catch (_) {
      /* keep default budget; errors will surface on first question */
    }
    renderSpend();
  }

  // Use each model's round-2 answer if it worked, else fall back to its round-1 answer.
  function bestAnswers(r1, r2) {
    const out = [];
    r1.forEach((a) => {
      const improved = r2.find((b) => b.model === a.model && !b.error);
      if (improved) out.push({ model: improved.model, text: improved.text });
      else if (!a.error) out.push({ model: a.model, text: a.text });
    });
    return out;
  }

  // ---------- main flow ----------
  async function ask(mode) {
    if (busy) return;
    const question = els.question.value.trim();
    hideNotice();
    if (!question) {
      showNotice("Type a question first.", "warn");
      els.question.focus();
      return;
    }
    if (getSpent() >= budget) {
      renderSpend();
      return;
    }

    let total = 0;
    const charge = (c) => {
      c = Number(c) || 0;
      total += c;
      addSpent(c);
    };

    try {
      setBusy(true, "Round 1 of 3 — council is answering…");
      const r1 = await post({ round: 1, mode, question });
      charge(r1.cost);
      const ok1 = r1.answers.filter((a) => !a.error);

      setBusy(true, "Round 2 of 3 — critiquing and improving…");
      const r2 = await post({ round: 2, mode, question, previous: ok1.map((a) => ({ model: a.model, text: a.text })) });
      charge(r2.cost);

      setBusy(true, "Round 3 of 3 — writing the final answer…");
      const r3 = await post({ round: 3, mode, question, previous: bestAnswers(r1.answers, r2.answers) });
      charge(r3.cost);

      const entry = {
        id: Date.now(),
        ts: new Date().toISOString(),
        mode,
        question,
        final: { name: r3.final.name, text: r3.final.text },
        rounds: {
          1: r1.answers.map(slim),
          2: r2.answers.map(slim),
        },
        cost: total,
      };
      const history = load(HISTORY_KEY, []);
      history.unshift(entry);
      save(HISTORY_KEY, history.slice(0, MAX_HISTORY));
      els.question.value = "";
      renderHistory();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if (err.cost) charge(err.cost);
      const spentMsg = total > 0 ? " (Cost so far for this question: " + money(total) + ")" : "";
      showNotice(err.message + spentMsg);
    } finally {
      setBusy(false);
    }
  }

  function slim(a) {
    return { model: a.model, name: a.name, text: a.text || "", error: a.error || null, cost: a.cost || 0 };
  }

  // ---------- rendering ----------
  function roundHtml(title, answers) {
    if (!answers || !answers.length) return "";
    const items = answers
      .map((a) =>
        '<div class="model-answer">' +
          (a.error
            ? '<div class="label err">' + esc(a.name) + " — failed</div><div>" + esc(a.error) + "</div>"
            : '<div class="label">' + esc(a.name) + '</div><div class="md">' + window.renderMarkdown(a.text) + "</div>") +
        "</div>"
      )
      .join("");
    return "<details><summary>" + esc(title) + '</summary><div class="inner">' + items + "</div></details>";
  }

  function entryHtml(e) {
    const date = new Date(e.ts);
    const when = isNaN(date) ? "" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const modeLabel = e.mode === "full" ? "Full Council" : "Quick";
    return (
      '<article class="entry card">' +
        '<p class="q">' + esc(e.question) + "</p>" +
        '<div class="meta">' + esc(modeLabel) + (when ? " · " + esc(when) : "") + "</div>" +
        '<div class="final"><div class="label">Final answer · ' + esc(e.final.name) + '</div><div class="md">' +
          window.renderMarkdown(e.final.text) + "</div></div>" +
        roundHtml("Round 1 — independent answers", e.rounds[1]) +
        roundHtml("Round 2 — critiques & improvements", e.rounds[2]) +
        '<div class="cost">Cost of this question: <strong>' + money(e.cost) + "</strong></div>" +
      "</article>"
    );
  }

  function renderHistory() {
    const history = load(HISTORY_KEY, []);
    if (!history.length) {
      els.results.innerHTML = '<div class="empty">Your answers will appear here. Past questions are saved on this device.</div>';
      els.historyActions.hidden = true;
      return;
    }
    els.results.innerHTML = history.map(entryHtml).join("");
    els.historyActions.hidden = false;
  }

  // ---------- events ----------
  els.quick.addEventListener("click", () => ask("quick"));
  els.full.addEventListener("click", () => ask("full"));
  els.question.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask("full");
  });
  els.clear.addEventListener("click", () => {
    if (confirm("Clear all saved questions and answers on this device? (Monthly spending total is kept.)")) {
      save(HISTORY_KEY, []);
      renderHistory();
    }
  });

  renderHistory();
  renderSpend();
  loadConfig();
})();
