import { Link } from 'react-router-dom';
import { plural, timeLeft } from '../lib/format.js';
import { StatusBadge } from './ui.jsx';

// One campaign in a list, laid out like a line on a brief board.
export default function CampaignRow({ campaign: c }) {
  return (
    <Link to={`/campaigns/${c.id}`} className="brief-row">
      <div className="brief-main">
        <p className="brief-brand">{c.brand}</p>
        <h3 className="brief-title">{c.title}</h3>
        <p className="brief-excerpt">{c.brief}</p>
      </div>
      <div className="brief-side">
        <p className="brief-prize">
          <span className="marker">{c.prize}</span>
        </p>
        <p className="brief-meta">
          <StatusBadge status={c.status} />
          <span>{c.status === 'open' ? timeLeft(c.deadline) : plural(c.submission_count, 'idea')}</span>
        </p>
        {c.is_organizer ? <p className="brief-tag">You run this</p> : null}
        {c.has_submitted ? <p className="brief-tag">{c.you_won ? 'Your idea won' : 'You pitched an idea'}</p> : null}
      </div>
    </Link>
  );
}
