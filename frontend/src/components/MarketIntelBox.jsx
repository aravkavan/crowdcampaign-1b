import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { formatDate, hostOf, safeHref } from '../lib/format.js';

// Your tracker's latest top list for one campaign, shown on the campaign page.
// Shows nothing at all if the tracker hasn't researched this campaign.
export default function MarketIntelBox({ campaignId }) {
  const [intel, setIntel] = useState(null);

  useEffect(() => {
    let alive = true;
    api(`/api/tracker/campaigns/${campaignId}`)
      .then((data) => alive && setIntel(data))
      .catch(() => alive && setIntel(null));
    return () => {
      alive = false;
    };
  }, [campaignId]);

  if (!intel?.top?.length) return null;
  return (
    <section className="intel-box" aria-labelledby="intel-box-heading">
      <div className="intel-box-head">
        <h2 id="intel-box-heading" className="panel-title">
          Market intel
        </h2>
        <Link to="/intel" className="panel-link">
          Full report
        </Link>
      </div>
      <p className="muted small">
        What’s new around this brief, from your tracker’s run {intel.run.number} on {formatDate(intel.run.finished_at)}.
        Build on these instead of repeating them.
      </p>
      <ol className="intel-mini">
        {intel.top.map((t) => {
          const source = t.development.sources[0];
          const href = source ? safeHref(source.url) : null;
          return (
            <li key={t.development.id} className="intel-mini-item">
              <span className="intel-mini-rank">{t.rank}</span>
              <div>
                <p className="intel-mini-title">
                  {t.development.title}
                  {t.change === 'new' ? <span className="tag-new">New</span> : null}
                </p>
                <p className="intel-mini-summary">{t.development.summary}</p>
                {source ? (
                  <p className="intel-mini-source">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {hostOf(source.url)}
                      </a>
                    ) : (
                      <span>{source.url}</span>
                    )}
                    {t.development.sources.length > 1 ? ` and ${t.development.sources.length - 1} more` : ''}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
