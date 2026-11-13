# AI Council

Ask one question and get back one answer that several AI models worked on together.

1. **Round 1:** 2 or 3 cheap, fast models each answer on their own, all at once.
2. **Round 2:** each model reads the other answers, points out what's weak, and improves its own.
3. **Round 3:** a top model (Claude Opus) writes the final answer, with "Where they agreed / Where they disagreed" at the end.

The final answer opens with a clear **Recommendation**. Under it are two buttons:

- **Approve** marks the answer "Approved ✓" with the date, both on screen and in saved history. Each history item shows whether it's approved or still waiting.
- **Send back** opens a box for your feedback (for example, "too generic, focus on Nanaimo trades"). Opus then revises its answer using the question, the council's answers, its last answer and your feedback. If you tick **Have the council weigh in again**, the cheap models first critique the last answer against your feedback, then Opus revises. Each revision shows as "Revision 1, 2…", with older versions folded away. You can approve or send back again after every revision. The cost of each revision is added to that question's total and to the monthly total, and revisions are blocked once the budget is reached.

**Quick** uses 2 models. **Full Council** uses 3. Everything goes through [OpenRouter](https://openrouter.ai). There's no login.

Under each answer you see what that question cost. The header shows a running monthly total ("This month: $X of $20"), and new questions are blocked once the budget is reached. History and the monthly total are saved in the browser (localStorage) on each device.

## Deploy (Netlify)

1. Push this repo to GitHub.
2. In Netlify, go to **Add new project → Import an existing project** and pick the repo. You don't need to change any build settings, because `netlify.toml` sets them (publish `public`, functions `netlify/functions`, no build command).
3. Under **Project configuration → Environment variables**, add:
   - `OPENROUTER_API_KEY` (required): your key from <https://openrouter.ai/keys>
   - `MONTHLY_BUDGET` (optional, default `20`): monthly limit in US dollars
4. Redeploy so the variables take effect.

**Tip:** the budget is tracked per browser, so it's a soft limit. For a hard cap, also set a credit limit on the key itself at <https://openrouter.ai/keys>.

## Change models

Edit `netlify/functions/council/models.js`:

- `COUNCIL`: the cheap models used in rounds 1 and 2 and for "weigh in again" critiques. Quick uses the first 2, Full uses all 3.
- `FINAL`: the model that writes the final answer and its revisions.
- `MAX_TOKENS`: output caps per call (600 for rounds 1 and 2, 900 for the final).

IDs must match <https://openrouter.ai/models> exactly. Commit and push, and Netlify redeploys on its own.

## Timeouts

Each round, critique and revision is a separate short request. If the final round still times out (Netlify's default is 10s per function), you can lower `MAX_TOKENS.final`, pick a faster `FINAL` model, or raise the function timeout in Netlify (available on some plans).

## Test locally

```
node test/test.js
```

The tests use a mocked fetch, so they need no API key and no network.
