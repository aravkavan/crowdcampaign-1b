// The AI layer's routes. They sit on top of the core app: if the AI provider is down,
// only these responses change; campaigns, ideas and picking a winner keep working.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { HttpError, bodyOf } from '../lib/http.js';
import { describeJudge, evaluateIdeas } from '../ai/evaluator.js';
import { SHORTLIST_SIZE, rankedSubmissions } from '../services/submissions.js';
import { loadCampaign, requireOrganizer } from './campaigns.js';

export const aiRouter = Router();

async function saveScores(results) {
  await withTransaction(async (client) => {
    for (const r of results) {
      await client.query(
        `INSERT INTO evaluations
           (submission_id, creativity, relevance, feasibility, marketing_potential, overall, summary, method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (submission_id) DO UPDATE SET
           creativity = EXCLUDED.creativity,
           relevance = EXCLUDED.relevance,
           feasibility = EXCLUDED.feasibility,
           marketing_potential = EXCLUDED.marketing_potential,
           overall = EXCLUDED.overall,
           summary = EXCLUDED.summary,
           method = EXCLUDED.method,
           evaluated_at = now()`,
        [r.submission_id, r.creativity, r.relevance, r.feasibility, r.marketing_potential, r.overall, r.summary, r.method],
      );
    }
  });
}

// GET /api/ai/status -> which judge is active, so the UI can label scores honestly
aiRouter.get('/ai/status', requireAuth, (req, res) => {
  res.json(describeJudge());
});

// POST /api/campaigns/:id/evaluate  { force?: true } -> organizer only.
// Scores ideas that have no score yet (or all of them with force: true).
campaignsAiRoute('post', '/campaigns/:id/evaluate', async (req, res, campaign) => {
  const force = bodyOf(req).force === true;
  const { rows: pending } = await query(
    `SELECT s.id, s.title, s.content
       FROM submissions s LEFT JOIN evaluations e ON e.submission_id = s.id
      WHERE s.campaign_id = $1 AND ($2::boolean OR e.submission_id IS NULL)
      ORDER BY s.created_at`,
    [campaign.id, force],
  );
  const judge = describeJudge();
  if (!pending.length) {
    return res.json({
      judge,
      scored: 0,
      failed: 0,
      message: 'Every idea already has a score.',
      submissions: await rankedSubmissions(campaign.id),
    });
  }

  const { results, failures } = await evaluateIdeas(campaign, pending);
  if (!results.length) {
    // Total failure: nothing was changed, and the rest of the app is unaffected.
    throw new HttpError(
      502,
      `The AI judge is unavailable right now (${failures[0]?.error ?? 'unknown error'}). ` +
        'Nothing was changed. You can still read every idea and pick a winner yourself.',
    );
  }
  await saveScores(results);
  const plural = (n) => `${n} idea${n === 1 ? '' : 's'}`;
  return res.json({
    judge,
    scored: results.length,
    failed: failures.length,
    message: failures.length
      ? `Scored ${plural(results.length)}. ${plural(failures.length)} couldn’t be scored; run the judge again to retry.`
      : `Scored ${plural(results.length)}.`,
    submissions: await rankedSubmissions(campaign.id),
  });
});

// GET /api/campaigns/:id/shortlist -> organizer only: the AI-recommended top 10
campaignsAiRoute('get', '/campaigns/:id/shortlist', async (req, res, campaign) => {
  const ranked = await rankedSubmissions(campaign.id);
  res.json({ campaign_id: campaign.id, size: SHORTLIST_SIZE, shortlist: ranked.filter((s) => s.shortlisted) });
});

// Registers a route that needs a login AND the campaign's organizer.
function campaignsAiRoute(method, path, handler) {
  aiRouter[method](path, requireAuth, async (req, res) => {
    const campaign = await loadCampaign(req.params.id, req.user.id);
    requireOrganizer(campaign);
    return handler(req, res, campaign);
  });
}
