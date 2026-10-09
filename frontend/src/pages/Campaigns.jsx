import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import CampaignRow from '../components/CampaignRow.jsx';
import { Alert, EmptyState, PageLoader } from '../components/ui.jsx';

const FILTERS = [
  { id: 'open', label: 'Open', test: (c) => c.status === 'open' },
  { id: 'all', label: 'All', test: () => true },
  { id: 'running', label: 'Yours', test: (c) => c.is_organizer },
  { id: 'pitched', label: 'Pitched', test: (c) => c.has_submitted },
];

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/campaigns')
      .then((data) => alive && setCampaigns(data.campaigns))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter).test;
    const needle = search.trim().toLowerCase();
    return (campaigns ?? []).filter(
      (c) => test(c) && (!needle || `${c.brand} ${c.title} ${c.brief}`.toLowerCase().includes(needle)),
    );
  }, [campaigns, filter, search]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="display">Campaigns</h1>
          <p className="lede">Briefs from brands and organizers. Each person can pitch one idea per campaign.</p>
        </div>
        <Link to="/campaigns/new" className="btn btn-secondary">Launch a campaign</Link>
      </header>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="segment"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {campaigns ? <span className="segment-count">{campaigns.filter(f.test).length}</span> : null}
            </button>
          ))}
        </div>
        <label className="search">
          <span className="visually-hidden">Search campaigns</span>
          <input type="search" placeholder="Search briefs" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      <Alert tone="error">{error}</Alert>
      {!campaigns && !error ? <PageLoader label="Loading campaigns" /> : null}
      {campaigns && visible.length ? (
        <div className="sheet">
          {visible.map((c) => (
            <CampaignRow key={c.id} campaign={c} />
          ))}
        </div>
      ) : null}
      {campaigns && !visible.length ? (
        <EmptyState
          title={search ? 'No briefs match that search' : 'Nothing here yet'}
          action={
            <Link to="/campaigns/new" className="btn btn-primary">
              Launch a campaign
            </Link>
          }
        >
          {search ? 'Try a different word, or switch to All.' : 'Be the first: write a brief and invite ideas.'}
        </EmptyState>
      ) : null}
    </div>
  );
}
