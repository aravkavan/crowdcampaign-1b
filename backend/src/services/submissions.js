// Every idea for a campaign, best AI score first. Ideas without a score come last.
import { query } from '../db.js';

export const SHORTLIST_SIZE = 10;

export async function rankedSubmissions(campaignId) {
  const { rows } = await query(
    `SELECT s.id, s.title, s.content, s.is_winner, s.created_at,
            s.author_id, u.username AS author_username,
            e.creativity, e.relevance, e.feasibility, e.marketing_potential,
            e.overall, e.summary, e.method, e.evaluated_at
       FROM submissions s
       JOIN users u ON u.id = s.author_id
       LEFT JOIN evaluations e ON e.submission_id = s.id
      WHERE s.campaign_id = $1
      ORDER BY e.overall DESC NULLS LAST, e.relevance DESC NULLS LAST, s.created_at ASC`,
    [campaignId],
  );

  let rank = 0;
  return rows.map((row) => {
    const scored = row.overall !== null;
    const position = scored ? ++rank : null;
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      is_winner: row.is_winner,
      created_at: row.created_at,
      author: { id: row.author_id, username: row.author_username },
      rank: position,
      shortlisted: scored && position <= SHORTLIST_SIZE,
      evaluation: scored
        ? {
            creativity: row.creativity,
            relevance: row.relevance,
            feasibility: row.feasibility,
            marketing_potential: row.marketing_potential,
            overall: Math.round(row.overall * 100) / 100,
            summary: row.summary,
            method: row.method,
            evaluated_at: row.evaluated_at,
          }
        : null,
    };
  });
}
