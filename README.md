# AI Council

Ask one question and get back one answer that several AI models worked on together.

1. **Round 1:** 2 or 3 cheap, fast models each answer on their own, all at once.
2. **Round 2:** each model reads the other answers, points out what's weak, and improves its own.
3. **Round 3:** a top model (Claude Opus) writes the final answer, with "Where they agreed / Where they disagreed" at the end.

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

- `COUNCIL`: the cheap models used in rounds 1 and 2. Quick uses the first 2, Full uses all 3.
- `FINAL`: the model that writes the final answer.
- `MAX_TOKENS`: output caps per call (600 for rounds 1 and 2, 900 for the final).

IDs must match <https://openrouter.ai/models> exactly. Commit and push, and Netlify redeploys on its own.

## Timeouts

Each round is a separate short request. If the final round still times out (Netlify's default is 10s per function), you can lower `MAX_TOKENS.final`, pick a faster `FINAL` model, or raise the function timeout in Netlify (available on some plans).

## Test locally

```
node test/test.js
```

The tests use a mocked fetch, so they need no API key and no network.
