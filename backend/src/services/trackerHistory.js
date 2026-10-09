// Rebuilds a user's market-intel history from the tracker tables.
//
// The database stores facts only: which developments exist, which run first reported
// each one, and each run's ranked top K per campaign. "New", "Still in top K" and
// "Dropped" are worked out here, by comparing each run's top K with the top K from the
// previous run that researched the same campaign. The tracker (when it loads its state)
// and the web app (when it shows reports) both use this one function, so they can
// never disagree about what changed.
import { query } from '../db.js';

export async function loadHistory(ownerId) {
  const [runs, runCampaigns, tops, developments, sources, articleCounts] = await Promise.all([
    query(
      `SELECT id, number, started_at, finished_at, status, stop_reason, model, stats
         FROM tracker_runs WHERE owner_id = $1 ORDER BY number`,
      [ownerId],
    ),
    query(
      `SELECT rc.run_id, rc.campaign_id, rc.topic, rc.status, rc.stop_reason, c.title, c.brand
         FROM tracker_run_campaigns rc
         JOIN tracker_runs r ON r.id = rc.run_id
         JOIN campaigns c ON c.id = rc.campaign_id
        WHERE r.owner_id = $1
        ORDER BY c.created_at, c.title`,
      [ownerId],
    ),
    query(
      `SELECT t.run_id, t.campaign_id, t.rank, t.development_id
         FROM tracker_top t JOIN tracker_runs r ON r.id = t.run_id
        WHERE r.owner_id = $1
        ORDER BY t.rank`,
      [ownerId],
    ),
    query(
      `SELECT id, campaign_id, title, summary, first_run_id
         FROM tracker_developments WHERE owner_id = $1`,
      [ownerId],
    ),
    query(
      `SELECT s.development_id, s.url, s.title, s.quote, s.run_id
         FROM tracker_sources s JOIN tracker_developments d ON d.id = s.development_id
        WHERE d.owner_id = $1
        ORDER BY s.url`,
      [ownerId],
    ),
    query(
      `SELECT run_id, status, count(*)::int AS n
         FROM tracker_articles WHERE owner_id = $1
        GROUP BY run_id, status`,
      [ownerId],
    ),
  ]);

  const runById = new Map(runs.rows.map((r) => [r.id, r]));

  const sourcesByDev = new Map();
  for (const s of sources.rows) {
    if (!sourcesByDev.has(s.development_id)) sourcesByDev.set(s.development_id, []);
    sourcesByDev.get(s.development_id).push({
      url: s.url,
      title: s.title,
      quote: s.quote,
      run_number: runById.get(s.run_id)?.number ?? null,
    });
  }

  const devById = new Map();
  for (const d of developments.rows) {
    const firstRun = runById.get(d.first_run_id);
    devById.set(d.id, {
      id: d.id,
      campaign_id: d.campaign_id,
      title: d.title,
      summary: d.summary,
      first_run: firstRun?.number ?? null,
      first_seen_at: firstRun?.started_at ?? null,
      first_run_id: d.first_run_id,
      sources: sourcesByDev.get(d.id) ?? [],
    });
  }

  const topsByRunCampaign = new Map();
  for (const t of tops.rows) {
    const key = `${t.run_id}|${t.campaign_id}`;
    if (!topsByRunCampaign.has(key)) topsByRunCampaign.set(key, []);
    topsByRunCampaign.get(key).push({ rank: t.rank, development_id: t.development_id });
  }

  const campaignsByRun = new Map();
  for (const rc of runCampaigns.rows) {
    if (!campaignsByRun.has(rc.run_id)) campaignsByRun.set(rc.run_id, []);
    campaignsByRun.get(rc.run_id).push(rc);
  }

  const articlesByRun = new Map();
  for (const a of articleCounts.rows) {
    if (!articlesByRun.has(a.run_id)) articlesByRun.set(a.run_id, { fetched: 0, skipped: 0, rejected: 0, failed: 0 });
    articlesByRun.get(a.run_id)[a.status] = a.n;
  }

  // Walk the runs in order, remembering each campaign's most recent top K.
  const lastTop = new Map(); // campaign_id -> [{ rank, development_id }]
  const history = [];
  for (const run of runs.rows) {
    const campaigns = [];
    const totals = { new: 0, still: 0, dropped: 0 };
    for (const rc of campaignsByRun.get(run.id) ?? []) {
      const current = topsByRunCampaign.get(`${run.id}|${rc.campaign_id}`) ?? [];
      const previous = lastTop.get(rc.campaign_id) ?? [];
      const previousRank = new Map(previous.map((p) => [p.development_id, p.rank]));
      const currentIds = new Set(current.map((c) => c.development_id));

      const top = current
        .filter((c) => devById.has(c.development_id))
        .map((c) => {
          const dev = devById.get(c.development_id);
          let change = 'back'; // reported in an earlier run, but not in the last top K
          if (dev.first_run_id === run.id) change = 'new';
          else if (previousRank.has(c.development_id)) change = 'still';
          return {
            rank: c.rank,
            previous_rank: previousRank.get(c.development_id) ?? null,
            change,
            development: publicDev(dev, run.number),
          };
        });

      // A failed campaign has no top K of its own, so nothing counts as dropped and the
      // previous top K stays "the last top K" for the next run.
      const dropped =
        rc.status === 'failed'
          ? []
          : previous
              .filter((p) => !currentIds.has(p.development_id) && devById.has(p.development_id))
              .map((p) => ({ previous_rank: p.rank, development: publicDev(devById.get(p.development_id), run.number) }));
      if (rc.status !== 'failed') lastTop.set(rc.campaign_id, current);

      const counts = {
        new: top.filter((i) => i.change === 'new').length,
        still: top.filter((i) => i.change !== 'new').length,
        dropped: dropped.length,
      };
      totals.new += counts.new;
      totals.still += counts.still;
      totals.dropped += counts.dropped;
      campaigns.push({
        campaign_id: rc.campaign_id,
        title: rc.title,
        brand: rc.brand,
        topic: rc.topic,
        status: rc.status,
        stop_reason: rc.stop_reason,
        counts,
        top,
        dropped,
      });
    }
    history.push({
      id: run.id,
      number: run.number,
      started_at: run.started_at,
      finished_at: run.finished_at,
      status: run.status,
      stop_reason: run.stop_reason,
      model: run.model,
      stats: run.stats,
      counts: totals,
      articles: articlesByRun.get(run.id) ?? { fetched: 0, skipped: 0, rejected: 0, failed: 0 },
      campaigns,
    });
  }

  return { history, lastTop, devById };
}

// A development as it stood in run `asOf`: sources added by later runs are left out, so an
// old report never shows evidence it didn't have yet.
function publicDev(dev, asOf = Infinity) {
  return {
    id: dev.id,
    title: dev.title,
    summary: dev.summary,
    first_run: dev.first_run,
    first_seen_at: dev.first_seen_at,
    sources: dev.sources.filter((s) => s.run_number === null || s.run_number <= asOf),
  };
}

// The run list shows what changed, without every development's details.
export function runSummary(run) {
  return {
    id: run.id,
    number: run.number,
    started_at: run.started_at,
    finished_at: run.finished_at,
    status: run.status,
    stop_reason: run.stop_reason,
    model: run.model,
    stats: run.stats,
    counts: run.counts,
    articles: run.articles,
    campaigns: run.campaigns.map((c) => ({
      campaign_id: c.campaign_id,
      title: c.title,
      brand: c.brand,
      status: c.status,
      counts: c.counts,
    })),
  };
}

export async function runArticles(runId, ownerId) {
  const { rows } = await query(
    `SELECT a.id, a.campaign_id, c.title AS campaign_title, a.url, a.title, a.status, a.reason,
            a.http_status, a.bytes, a.fetched_at, a.flagged
       FROM tracker_articles a
       LEFT JOIN campaigns c ON c.id = a.campaign_id
      WHERE a.run_id = $1 AND a.owner_id = $2
      ORDER BY a.fetched_at, a.url`,
    [runId, ownerId],
  );
  return rows;
}
