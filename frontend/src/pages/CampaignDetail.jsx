import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Button, ConfirmDialog, EmptyState, Field, PageLoader, ScoreBar, StatusBadge } from '../components/ui.jsx';
import MarketIntelBox from '../components/MarketIntelBox.jsx';
import { formatDateTime, judgeName, plural, timeLeft } from '../lib/format.js';

export default function CampaignDetail() {
  const { id } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setCampaign(await api(`/api/campaigns/${id}`));
      setError('');
    } catch (err) {
      if (err.status === 404) setMissing(true);
      else setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (missing) {
    return (
      <div className="page">
        <EmptyState title="This campaign doesn’t exist" action={<Link to="/campaigns" className="btn btn-primary">Browse campaigns</Link>}>
          It may have been deleted by its organizer.
        </EmptyState>
      </div>
    );
  }
  if (!campaign) {
    return <div className="page">{error ? <Alert tone="error">{error}</Alert> : <PageLoader label="Loading the brief" />}</div>;
  }

  return (
    <div className="page">
      <Link to="/campaigns" className="back-link">All campaigns</Link>
      <header className="campaign-head">
        <p className="campaign-brand">{campaign.brand}</p>
        <h1 className="display campaign-title">{campaign.title}</h1>
      </header>

      <div className="campaign-grid">
        <article className="brief-doc" aria-label="The brief">
          <h2 className="brief-doc-title">The brief</h2>
          <p className="brief-doc-text">{campaign.brief}</p>
        </article>
        <aside className="facts" aria-label="Campaign details">
          <dl>
            <div className="fact">
              <dt>Prize</dt>
              <dd className="fact-prize"><span className="marker">{campaign.prize}</span></dd>
            </div>
            <div className="fact">
              <dt>Status</dt>
              <dd><StatusBadge status={campaign.status} /></dd>
            </div>
            <div className="fact">
              <dt>Deadline</dt>
              <dd>
                {formatDateTime(campaign.deadline)}
                {campaign.status === 'open' ? <span className="fact-sub">{timeLeft(campaign.deadline)}</span> : null}
              </dd>
            </div>
            <div className="fact">
              <dt>Ideas so far</dt>
              <dd>{campaign.submission_count}</dd>
            </div>
            <div className="fact">
              <dt>Organizer</dt>
              <dd>@{campaign.organizer.username}{campaign.is_organizer ? ' (you)' : ''}</dd>
            </div>
          </dl>
        </aside>
      </div>

      {campaign.winner ? <WinnerBanner winner={campaign.winner} campaign={campaign} /> : null}

      <MarketIntelBox campaignId={campaign.id} />

      {campaign.is_organizer ? (
        <OrganizerPanel campaign={campaign} onChanged={load} />
      ) : (
        <ParticipantPanel campaign={campaign} onSubmitted={load} />
      )}
    </div>
  );
}

function WinnerBanner({ winner, campaign }) {
  const { user } = useAuth();
  const yours = winner.author.id === user.id;
  return (
    <section className="winner" aria-labelledby="winner-heading">
      <p className="winner-label" id="winner-heading">
        {yours ? 'Your idea won this campaign' : `Winning idea, picked by @${campaign.organizer.username}`}
      </p>
      <h2 className="winner-title"><span className="marker">{winner.title}</span></h2>
      <p className="winner-author">by @{winner.author.username}</p>
      <p className="winner-text">{winner.content}</p>
    </section>
  );
}

// ------------------------------------------------------------------ participants

function ParticipantPanel({ campaign, onSubmitted }) {
  const mine = campaign.my_submission;
  if (mine) {
    return (
      <section className="panel" aria-labelledby="mine-heading">
        <h2 id="mine-heading" className="panel-title">Your idea</h2>
        <h3 className="idea-title">{mine.title}</h3>
        <p className="idea-text">{mine.content}</p>
        <p className="muted small">
          Submitted {formatDateTime(mine.created_at)}.{' '}
          {campaign.status === 'open' && 'The organizer reviews ideas and picks a winner after the deadline.'}
          {campaign.status === 'judging' && 'The organizer is reviewing ideas now.'}
          {campaign.status === 'winner_selected' && !mine.is_winner && 'A different idea won this time. Thanks for pitching.'}
        </p>
      </section>
    );
  }
  // Once a winner is shown above, there is nothing more to say here.
  if (campaign.status === 'winner_selected') return null;
  if (campaign.status !== 'open') {
    return (
      <section className="panel">
        <EmptyState title="This campaign has closed">
          The deadline passed and the organizer is choosing a winner.
        </EmptyState>
      </section>
    );
  }
  return <SubmitIdea campaign={campaign} onSubmitted={onSubmitted} />;
}

function SubmitIdea({ campaign, onSubmitted }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    const found = {};
    if (title.trim().length < 3) found.title = 'Give your idea a title (at least 3 characters).';
    if (content.trim().length < 30) found.content = 'Describe your idea in at least 30 characters.';
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/campaigns/${campaign.id}/submissions`, { method: 'POST', body: { title: title.trim(), content: content.trim() } });
      await onSubmitted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="pitch-heading">
      <h2 id="pitch-heading" className="panel-title">Pitch your idea</h2>
      <p className="muted">
        One idea per person. Say what happens, where, why it fits the brief, and roughly what it costs. Only the organizer sees
        submitted ideas.
      </p>
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <Alert tone="error">{error}</Alert>
        <Field label="Idea title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} error={errors.title} />
        <Field
          as="textarea"
          rows={7}
          label="Your idea"
          value={content}
          maxLength={5000}
          onChange={(e) => setContent(e.target.value)}
          error={errors.content}
          hint={`${content.trim().length} / 5000 characters`}
        />
        <div className="form-actions">
          <Button type="submit" loading={busy}>Submit idea</Button>
        </div>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ organizer

function OrganizerPanel({ campaign, onChanged }) {
  const navigate = useNavigate();
  const [ideas, setIdeas] = useState(null);
  const [judge, setJudge] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [scoring, setScoring] = useState(false);
  const [choice, setChoice] = useState(null);
  const [picking, setPicking] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadIdeas = useCallback(async () => {
    const [list, status] = await Promise.all([api(`/api/campaigns/${campaign.id}/submissions`), api('/api/ai/status')]);
    setIdeas(list.submissions);
    setJudge(status);
  }, [campaign.id]);

  useEffect(() => {
    loadIdeas().catch((err) => setError(err.message));
  }, [loadIdeas]);

  async function score(force) {
    setScoring(true);
    setError('');
    setMessage('');
    try {
      const result = await api(`/api/campaigns/${campaign.id}/evaluate`, { method: 'POST', body: { force } });
      setIdeas(result.submissions);
      setMessage(result.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setScoring(false);
    }
  }

  async function pickWinner() {
    setPicking(true);
    setError('');
    try {
      await api(`/api/campaigns/${campaign.id}/winner`, { method: 'POST', body: { submission_id: choice.id } });
      setChoice(null);
      await Promise.all([onChanged(), loadIdeas()]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
      setChoice(null);
    } finally {
      setPicking(false);
    }
  }

  async function deleteCampaign() {
    setDeleting(true);
    try {
      await api(`/api/campaigns/${campaign.id}`, { method: 'DELETE' });
      navigate('/campaigns', { replace: true });
    } catch (err) {
      setError(err.message);
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  const list = ideas ?? [];
  const shortlist = list.filter((s) => s.shortlisted);
  const others = list.filter((s) => !s.shortlisted);
  const unscored = list.filter((s) => !s.evaluation).length;
  const decided = campaign.status === 'winner_selected';

  return (
    <section className="judging" aria-labelledby="judging-heading">
      <div className="judging-head">
        <div>
          <h2 id="judging-heading" className="section-title">Judging</h2>
          <p className="muted">
            The judge scores each idea on creativity, relevance, feasibility and marketing potential, then ranks a top ten.
            It never picks the winner. You do.
          </p>
        </div>
        {!decided && list.length ? (
          <div className="judging-actions">
            <Button onClick={() => score(false)} loading={scoring} disabled={!unscored}>
              {unscored ? `Score ${plural(unscored, 'new idea')}` : 'All ideas scored'}
            </Button>
            {list.length > unscored ? (
              <Button variant="ghost" onClick={() => score(true)} disabled={scoring}>
                Re-score all
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {judge ? (
        <p className={`judge-note ${judge.is_ai ? '' : 'judge-note-offline'}`}>
          Judge: <strong>{judge.label}</strong>
          {judge.is_ai ? null : '. Add an AI key to the backend to get real AI scores; everything else works the same.'}
        </p>
      ) : null}
      {scoring ? <p className="scoring-note" role="status">Scoring ideas. With an AI judge this can take up to a minute.</p> : null}
      <Alert tone="error">{error}</Alert>
      <Alert tone="success">{message}</Alert>

      {!ideas && !error ? <PageLoader label="Loading ideas" /> : null}
      {ideas && !list.length ? (
        <EmptyState title="No ideas yet">
          People will find this campaign on the Campaigns page. Their ideas appear here as they come in.
        </EmptyState>
      ) : null}

      {shortlist.length ? (
        <>
          <h3 className="list-heading">
            Shortlist <span className="list-heading-sub">top {shortlist.length} of {plural(list.length, 'idea')}, ranked by overall score</span>
          </h3>
          <ol className="leaderboard">
            {shortlist.map((idea) => (
              <Entry key={idea.id} idea={idea} canPick={!decided} onPick={() => setChoice(idea)} />
            ))}
          </ol>
        </>
      ) : null}

      {ideas && list.length && !shortlist.length ? (
        <p className="muted">No scores yet. Run the judge for a ranked shortlist, or read every idea below and pick a winner yourself.</p>
      ) : null}

      {others.length ? (
        <details className="more-ideas" open={!shortlist.length}>
          <summary>
            {shortlist.length ? `Everything else (${others.length})` : `All ideas (${others.length})`}
          </summary>
          <ul className="idea-list">
            {others.map((idea) => (
              <IdeaRow key={idea.id} idea={idea} canPick={!decided} onPick={() => setChoice(idea)} />
            ))}
          </ul>
        </details>
      ) : null}

      <div className="danger-zone">
        <Button variant="danger-ghost" size="small" onClick={() => setDeleteOpen(true)}>
          Delete this campaign
        </Button>
      </div>

      <ConfirmDialog
        open={Boolean(choice)}
        title="Pick this idea as the winner?"
        confirmLabel="Pick winner"
        busy={picking}
        onConfirm={pickWinner}
        onCancel={() => setChoice(null)}
      >
        {choice ? (
          <p>
            <strong>{choice.title}</strong> by @{choice.author.username}. This is final: the campaign closes and everyone can see the
            winning idea.
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete this campaign?"
        confirmLabel="Delete campaign"
        tone="danger"
        busy={deleting}
        onConfirm={deleteCampaign}
        onCancel={() => setDeleteOpen(false)}
      >
        <p>The brief and all {plural(list.length, 'idea')} will be removed for good.</p>
      </ConfirmDialog>
    </section>
  );
}

function Entry({ idea, canPick, onPick }) {
  const [open, setOpen] = useState(false);
  const e = idea.evaluation;
  return (
    <li className={`entry ${idea.is_winner ? 'entry-winner' : ''}`}>
      <span className="entry-rank" aria-label={`Rank ${idea.rank}`}>{idea.rank}</span>
      <div className="entry-body">
        <div className="entry-top">
          <div>
            <h4 className="entry-title">{idea.title}</h4>
            <p className="entry-author">@{idea.author.username}</p>
          </div>
          <p className="entry-overall">
            <span className="entry-overall-value">{e.overall.toFixed(1)}</span>
            <span className="entry-overall-label">overall</span>
          </p>
        </div>
        <div className="entry-scores">
          <ScoreBar label="Creativity" value={e.creativity} />
          <ScoreBar label="Relevance" value={e.relevance} />
          <ScoreBar label="Feasibility" value={e.feasibility} />
          <ScoreBar label="Marketing potential" value={e.marketing_potential} />
        </div>
        <p className="entry-summary">
          {e.summary} <span className="entry-judge">{judgeName(e.method)}</span>
        </p>
        {open ? <p className="entry-text">{idea.content}</p> : null}
        <div className="entry-actions">
          <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide the full idea' : 'Read the full idea'}
          </button>
          {idea.is_winner ? <span className="won-tag">Winner</span> : null}
          {!idea.is_winner && canPick ? (
            <Button variant="secondary" size="small" onClick={onPick}>
              Pick as winner
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function IdeaRow({ idea, canPick, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="idea-row">
      <div className="idea-row-top">
        <div>
          <p className="idea-row-title">{idea.title}</p>
          <p className="entry-author">
            @{idea.author.username}
            {idea.evaluation ? `, ranked ${idea.rank} with ${idea.evaluation.overall.toFixed(1)}` : ', not scored yet'}
          </p>
        </div>
        <div className="entry-actions">
          <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Read'}
          </button>
          {idea.is_winner ? <span className="won-tag">Winner</span> : null}
          {!idea.is_winner && canPick ? (
            <Button variant="secondary" size="small" onClick={onPick}>
              Pick as winner
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <>
          <p className="entry-text">{idea.content}</p>
          {idea.evaluation ? <p className="entry-summary">{idea.evaluation.summary}</p> : null}
        </>
      ) : null}
    </li>
  );
}
