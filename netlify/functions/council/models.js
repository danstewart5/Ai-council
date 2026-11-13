// =====================================================================
//  AI Council model config — edit this file to swap models.
//  IDs must match OpenRouter model IDs exactly (see https://openrouter.ai/models).
// =====================================================================

// Cheap / fast models used for Round 1 (answer) and Round 2 (critique + improve).
// "Quick" uses the first 2, "Full Council" uses all 3.
const COUNCIL = [
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
  { id: "x-ai/grok-4.3", name: "Grok 4.3" },
  { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
];

// Top model that writes the final synthesized answer (Round 3).
const FINAL = { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" };

// Output caps per call (keeps each request fast and costs predictable).
const MAX_TOKENS = {
  round1: 600,
  round2: 600,
  final: 900,
};

// How many council models each mode uses.
const MODES = {
  quick: 2,
  full: 3,
};

module.exports = { COUNCIL, FINAL, MAX_TOKENS, MODES };
