import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import CampaignRow from '../components/CampaignRow.jsx';
import { Alert, EmptyState, PageLoader, StatusBadge } from '../components/ui.jsx';
import { greeting, plural, timeLeft } from '../lib/format.js';

function tally(running, pitched, waiting) {
  const first = running ? `You’re running ${plural(running, 'campaign')}` : 'You aren’t running a campaign yet';
  const second = pitched ? `you’ve pitched ${plural(pitched, 'idea')}` : 'you haven’t pitched an idea yet';
  const third = waiting ? ` ${plural(waiting, 'open brief')} ${waiting === 1 ? 'is' : 'are'} waiting for your ideas.` : '';
  return `${first}, and ${second}.${third}`;
}

export default function Home() {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/campaigns')
      .then((data) => alive && setCampaigns(data.campaigns))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  const running = campaigns?.filter((c) => c.is_organizer) ?? [];
  const pitched = campaigns?.filter((c) => c.has_submitted) ?? [];
  const waiting = campaigns?.filter((c) => c.status === 'open' && !c.is_organizer && !c.has_submitted) ?? [];

  return (
    <div className="page">
      <section className="hello">
        <h1 className="display hello-title">
          {greeting()}, <span className="hello-name">{user.username}</span>.
        </h1>
        <p className="hello-signed-in">
          You’re logged in as <strong>@{user.username}</strong>
          {user.email ? <> ({user.email})</> : null}. <Link to="/account">Account settings</Link>
        </p>
        {campaigns ? <p className="tally">{tally(running.length, pitched.length, waiting.length)}</p> : null}
      </section>

      <Alert tone="error">{error}</Alert>
      {!campaigns && !error ? <PageLoader label="Loading your campaigns" /> : null}

      {campaigns ? (
        <div className="home-grid">
          <section className="panel" aria-labelledby="running-heading">
            <div className="panel-head">
              <h2 id="running-heading" className="panel-title">Campaigns you run</h2>
              <Link to="/campaigns/new" className="panel-link">Launch a campaign</Link>
            </div>
            {running.length ? (
              <ul className="mini-list">
                {running.map((c) => (
                  <li key={c.id}>
                    <Link to={`/campaigns/${c.id}`} className="mini-row">
                      <span className="mini-main">
                        <span className="mini-title">{c.title}</span>
                        <span className="mini-meta">
                          {plural(c.submission_count, 'idea')}, {c.status === 'open' ? timeLeft(c.deadline).toLowerCase() : 'deadline passed'}
                        </span>
                      </span>
                      <StatusBadge status={c.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No campaigns yet">
                Write a brief, set a prize and a deadline, and collect ideas from everyone else.
              </EmptyState>
            )}
          </section>

          <section className="panel" aria-labelledby="pitched-heading">
            <div className="panel-head">
              <h2 id="pitched-heading" className="panel-title">Your ideas</h2>
            </div>
            {pitched.length ? (
              <ul className="mini-list">
                {pitched.map((c) => (
                  <li key={c.id}>
                    <Link to={`/campaigns/${c.id}`} className="mini-row">
                      <span className="mini-main">
                        <span className="mini-title">{c.title}</span>
                        <span className="mini-meta">for {c.brand}</span>
                      </span>
                      {c.you_won ? (
                        <span className="won-tag">You won</span>
                      ) : (
                        <StatusBadge status={c.status} />
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing pitched yet">Open a brief below and submit your first idea.</EmptyState>
            )}
          </section>
        </div>
      ) : null}

      {campaigns && waiting.length ? (
        <section className="section" aria-labelledby="waiting-heading">
          <div className="section-head">
            <h2 id="waiting-heading" className="section-title">Open briefs you haven’t pitched</h2>
            <Link to="/campaigns" className="panel-link">See all campaigns</Link>
          </div>
          <div className="sheet">
            {waiting.slice(0, 3).map((c) => (
              <CampaignRow key={c.id} campaign={c} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
