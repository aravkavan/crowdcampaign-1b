// The AI layer's single entry point. The rest of the app only calls describeJudge()
// and evaluateIdeas(); swapping providers never touches routes or the database.
import { config } from '../config.js';
import { scoreOffline } from './offline.js';
import { buildPrompt, parseScores, SYSTEM_PROMPT } from './prompt.js';
import { askClaude } from './providers/anthropic.js';
import { askGemini } from './providers/gemini.js';

const BATCH_SIZE = 8; // ideas per AI request: fewer requests, gentler on rate limits

// Which judge is active. AI_PROVIDER=auto (the default) uses whichever key is present
// and falls back to the offline estimate, which is always labelled "not AI".
export function describeJudge() {
  const { provider, anthropicKey, anthropicModel, geminiKey, geminiModel } = config.ai;
  const allowed = (name) => provider === 'auto' || provider === name;
  if (allowed('anthropic') && anthropicKey) {
    return { provider: 'anthropic', model: anthropicModel, is_ai: true, label: `Claude (${anthropicModel})` };
  }
  if (allowed('gemini') && geminiKey) {
    return { provider: 'gemini', model: geminiModel, is_ai: true, label: `Gemini (${geminiModel})` };
  }
  const why = provider === 'offline' ? 'offline mode' : 'no AI key set';
  return { provider: 'offline', model: 'keyword heuristic', is_ai: false, label: `Offline estimate, not AI (${why})` };
}

function finalize(submissionId, scores, method) {
  const overall = (scores.creativity + scores.relevance + scores.feasibility + scores.marketing_potential) / 4;
  return { submission_id: submissionId, ...scores, overall: Math.round(overall * 100) / 100, method };
}

// One retry for brief hiccups (rate limit, overload, network blip). Timeouts are not
// retried: the organizer is waiting in the browser, and a second 45-second wait helps nobody.
async function withRetry(task, attempts = 2) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      if (!err.retryable || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(err.retryAfterMs ?? 2000, 10_000)));
    }
  }
}

// Scores ideas. Never throws because of the AI: a failed batch is reported in
// `failures`, and every idea that did get scored is kept.
export async function evaluateIdeas(campaign, ideas) {
  const judge = describeJudge();
  const results = [];
  const failures = [];

  if (!judge.is_ai) {
    for (const idea of ideas) results.push(finalize(idea.id, scoreOffline(campaign, idea), 'offline'));
    return { results, failures };
  }

  const ask = judge.provider === 'anthropic' ? askClaude : askGemini;
  const method = `${judge.provider}:${judge.model}`;
  let outage = null; // once the provider fails, stop calling it (a simple circuit breaker)
  for (let start = 0; start < ideas.length; start += BATCH_SIZE) {
    const batch = ideas.slice(start, start + BATCH_SIZE);
    if (outage) {
      for (const idea of batch) failures.push({ submission_id: idea.id, error: outage });
      continue;
    }
    // Short ids like "idea-1" instead of database UUIDs: nothing for the model to mangle,
    // and the model never sees who wrote an idea (less room for bias).
    const ids = batch.map((_, n) => `idea-${n + 1}`);
    try {
      const reply = await withRetry(() => ask({ system: SYSTEM_PROMPT, prompt: buildPrompt(campaign, batch, ids) }));
      const scores = parseScores(reply, ids);
      batch.forEach((idea, n) => {
        const score = scores.get(ids[n]);
        if (score) results.push(finalize(idea.id, score, method));
        else failures.push({ submission_id: idea.id, error: 'the AI skipped this idea' });
      });
    } catch (err) {
      outage = err.message;
      for (const idea of batch) failures.push({ submission_id: idea.id, error: outage });
    }
  }
  return { results, failures };
}
