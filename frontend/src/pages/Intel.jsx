import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, EmptyState, PageLoader } from '../components/ui.jsx';
import { ARTICLE_STATUS, RUN_STATUS, formatDateTime, hostOf, plural, safeHref } from '../lib/format.js';

// Everything on this page that came from the web (titles, summaries, quotes, URLs) is
// rendered as React text, so markup or script in a fetched page shows up as plain text.

export default function Intel() {
  const { user } = useAuth();
  const [runs, setRuns] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/tracker/runs')
      .then((data) => {
        if (!alive) return;
        setRuns(data.runs);
        if (data.runs.length) setSelectedId(data.runs[0].id);
      })
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return undefined;
    let alive = true;
    api(`/api/tracker/runs/${selectedId}`)
      .then((data) => alive && setDetail(data.run))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [selectedId]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="display">Market intel</h1>
          <p className="lede">
            What’s new around the campaigns your research tracker follows: launches, campaigns and trends, each with its
            source. Build on them in your ideas instead of repeating them.
          </p>
        </div>
      </header>

      <Alert tone="error">{error}</Alert>
      {!runs && !error ? <PageLoader label="Loading market intel" /> : null}

      {runs && !runs.length ? (
        <EmptyState title="No market intel yet">
          The research tracker hasn’t saved a run for @{user.username}. In the project folder, run{' '}
          <code>python -m tracker run</code>, then refresh this page.
        </EmptyState>
      ) : null}

      {runs && runs.length ? (
        <div className="intel-layout">
          <div className="intel-main">
            {detail ? <RunReport run={detail} isLatest={detail.id === runs[0].id} /> : <PageLoader label="Loading the report" />}
            {detail ? <ArticleLog run={detail} /> : null}
          </div>
          <RunHistory runs={runs} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ report

function changeSentence(counts, k) {
  const parts = [
    `${plural(counts.new, 'new development')}`,
    `${counts.still} still in the top ${k}`,
    `${counts.dropped} dropped`,
  ];
  return `${parts.join(', ')}.`;
}

function minutes(run) {
  const ms = new Date(run.finished_at) - new Date(run.started_at);
  const total = Math.max(0, Math.round(ms / 1000));
  return total >= 60 ? `${Math.floor(total / 60)} min ${total % 60} s` : `${total} s`;
}

function RunReport({ run, isLatest }) {
  const k = run.stats?.k ?? 5;
  return (
    <section className="run-report" aria-labelledby="report-heading">
      <div className="run-head">
        <div className="run-head-title">
          <h2 id="report-heading" className="section-title">
            {isLatest ? 'Latest report' : 'Report'}: run {run.number}
          </h2>
          <RunStatus status={run.status} />
        </div>
        <p className="muted">
          {formatDateTime(run.started_at)}, took {minutes(run)}. Model: {run.model}.
        </p>
        <p className="tally">{changeSentence(run.counts, k)}</p>
        {run.status !== 'complete' && run.stop_reason ? (
          <p className="run-note">
            <strong>{RUN_STATUS[run.status]} run.</strong> {run.stop_reason}
          </p>
        ) : null}
      </div>
      {run.campaigns.map((c) => (
        <CampaignReport key={c.campaign_id} campaign={c} k={k} />
      ))}
    </section>
  );
}

function CampaignReport({ campaign: c, k }) {
  const fresh = c.top.filter((t) => t.change === 'new');
  const kept = c.top.filter((t) => t.change !== 'new');
  return (
    <article className="intel-campaign" aria-label={c.title}>
      <header className="intel-campaign-head">
        <p className="campaign-brand">{c.brand}</p>
        <h3 className="intel-campaign-title">
          <Link to={`/campaigns/${c.campaign_id}`}>{c.title}</Link>
        </h3>
        <p className="muted small">Research topic: {c.topic}</p>
        {c.status !== 'complete' ? (
          <p className={`run-note run-note-${c.status}`}>
            <strong>{RUN_STATUS[c.status]}.</strong> {c.stop_reason}
          </p>
        ) : null}
      </header>
      {c.status === 'failed' ? (
        <p className="muted">No results for this campaign in this run. Its previous top list is unchanged.</p>
      ) : (
        <>
          <IntelGroup title="New since last run" items={fresh} empty="Nothing new this time." k={k} />
          <IntelGroup title={`Still in the top ${k}`} items={kept} empty="Nothing carried over." k={k} />
          <div className="intel-group">
            <h4 className="intel-group-title">
              Dropped <span className="intel-group-count">{c.dropped.length}</span>
            </h4>
            {c.status === 'partial' ? (
              <p className="muted small">Not judged: this run was partial, so nothing was re-ranked or dropped.</p>
            ) : c.dropped.length ? (
              <ul className="dropped-list">
                {c.dropped.map((d) => (
                  <li key={d.development.id}>
                    <span className="dropped-title">{d.development.title}</span>{' '}
                    <span className="muted">was #{d.previous_rank}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Nothing dropped.</p>
            )}
          </div>
        </>
      )}
    </article>
  );
}

function IntelGroup({ title, items, empty, k }) {
  return (
    <div className="intel-group">
      <h4 className="intel-group-title">
        {title} <span className="intel-group-count">{items.length}</span>
      </h4>
      {items.length ? (
        <ol className="intel-items">
          {items.map((item) => (
            <IntelItem key={item.development.id} item={item} k={k} />
          ))}
        </ol>
      ) : (
        <p className="muted small">{empty}</p>
      )}
    </div>
  );
}

function IntelItem({ item, k }) {
  const d = item.development;
  let meta = `First seen in run ${d.first_run}`;
  if (item.change === 'still' && item.previous_rank) meta += `. Was #${item.previous_rank} last run`;
  if (item.change === 'back') meta += `. Back in the top ${k}`;
  return (
    <li className="intel-item">
      <span className="intel-rank" aria-label={`Rank ${item.rank}`}>
        {item.rank}
      </span>
      <div className="intel-body">
        <p className="intel-title">
          {d.title}
          {item.change === 'new' ? <span className="tag-new">New</span> : null}
        </p>
        <p className="intel-summary">{d.summary}</p>
        {d.sources.map((s) => (
          <SourceQuote key={s.url} source={s} />
        ))}
        <p className="intel-meta">{meta}.</p>
      </div>
    </li>
  );
}

function SourceQuote({ source }) {
  const href = safeHref(source.url);
  const host = hostOf(source.url);
  return (
    <figure className="source">
      <blockquote className="source-quote">“{source.quote}”</blockquote>
      <figcaption className="source-cite">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {source.title || host}
          </a>
        ) : (
          <span>{source.url}</span>
        )}
        {host ? <span className="source-host">{host}</span> : null}
      </figcaption>
    </figure>
  );
}

export function RunStatus({ status }) {
  return <span className={`run-status run-status-${status}`}>{RUN_STATUS[status] ?? status}</span>;
}

// ------------------------------------------------------------------ articles

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'fetched', label: 'Fetched' },
  { id: 'skipped', label: 'Already seen' },
  { id: 'rejected', label: 'Blocked' },
  { id: 'failed', label: 'Failed' },
];

function ArticleLog({ run }) {
  const [filter, setFilter] = useState('all');
  const articles = run.articles ?? [];
  const counts = useMemo(() => {
    const c = { all: articles.length };
    for (const a of articles) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [articles]);
  const shown = filter === 'all' ? articles : articles.filter((a) => a.status === filter);

  return (
    <section className="article-log" aria-labelledby="articles-heading">
      <div className="section-head">
        <h2 id="articles-heading" className="section-title">
          Articles in run {run.number}
        </h2>
      </div>
      <p className="muted small article-log-help">
        Every page the tracker looked at. Already seen: read in an earlier run, so not downloaded again. Blocked: refused by
        the fetch guardrail before any request was made.
      </p>
      <div className="segmented article-filter" role="group" aria-label="Show articles">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="segment" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
            <span className="segment-count">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>
      {shown.length ? (
        <ul className="article-list">
          {shown.map((a) => (
            <ArticleRow key={a.id} article={a} />
          ))}
        </ul>
      ) : (
        <p className="muted">No articles with this status in this run.</p>
      )}
    </section>
  );
}

function ArticleRow({ article: a }) {
  const href = a.status === 'rejected' ? null : safeHref(a.url);
  return (
    <li className="article-row">
      <span className={`astatus astatus-${a.status}`}>{ARTICLE_STATUS[a.status] ?? a.status}</span>
      <div className="article-main">
        <p className="article-title">{a.title || hostOf(a.url) || 'Untitled page'}</p>
        <p className="article-url">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {a.url}
            </a>
          ) : (
            <span>{a.url}</span>
          )}
        </p>
        {a.reason ? <p className="article-reason">{a.reason}</p> : null}
        {a.flagged ? (
          <p className="article-flag">
            This page contained instructions aimed at AI agents. The model saw it only as data, and it was never used as
            a source.
          </p>
        ) : null}
      </div>
      <div className="article-side">
        {a.campaign_title ? <span className="article-campaign">{a.campaign_title}</span> : null}
        <time dateTime={a.fetched_at}>{formatDateTime(a.fetched_at)}</time>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ history

function RunHistory({ runs, selectedId, onSelect }) {
  return (
    <aside className="run-history" aria-labelledby="history-heading">
      <h2 id="history-heading" className="panel-title">
        Run history
      </h2>
      <ol className="run-list">
        {runs.map((r) => {
          const changes = [];
          if (r.counts.new) changes.push(`${r.counts.new} new`);
          if (r.counts.dropped) changes.push(`${r.counts.dropped} dropped`);
          return (
            <li key={r.id}>
              <button
                type="button"
                className={`run-row ${r.id === selectedId ? 'is-selected' : ''}`}
                aria-current={r.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(r.id)}
              >
                <span className="run-row-top">
                  <span className="run-row-number">Run {r.number}</span>
                  <RunStatus status={r.status} />
                </span>
                <span className="run-row-when">{formatDateTime(r.started_at)}</span>
                <span className="run-row-changes">{changes.length ? changes.join(', ') : 'No changes'}</span>
                <span className="run-row-articles">
                  {plural(r.articles.fetched, 'article')} fetched, {r.articles.skipped} already seen, {r.articles.rejected}{' '}
                  blocked
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="muted small">
        New runs appear here after <code>python -m tracker run</code>.
      </p>
    </aside>
  );
}
