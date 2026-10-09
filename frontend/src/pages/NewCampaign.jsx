import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import CampaignRow from '../components/CampaignRow.jsx';
import { Alert, Button, Field } from '../components/ui.jsx';

// <input type="datetime-local"> works in local time, formatted as YYYY-MM-DDTHH:mm.
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultDeadline() {
  const date = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  date.setHours(17, 0, 0, 0);
  return toLocalInput(date);
}

const LIMITS = { brand: [2, 80], title: [5, 120], brief: [40, 4000], prize: [2, 120] };
const LABELS = { brand: 'Brand name', title: 'Title', brief: 'Brief', prize: 'Prize' };

function problems(form) {
  const found = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const length = form[key].trim().length;
    if (length < min) found[key] = `${LABELS[key]} needs at least ${min} characters.`;
    else if (length > max) found[key] = `${LABELS[key]} can be at most ${max} characters.`;
  }
  const deadline = new Date(form.deadline);
  if (Number.isNaN(deadline.getTime())) found.deadline = 'Pick a date and time.';
  else if (deadline.getTime() <= Date.now()) found.deadline = 'Pick a time in the future.';
  return found;
}

export default function NewCampaign() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ brand: '', title: '', brief: '', prize: '', deadline: defaultDeadline() });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  async function handleSubmit(event) {
    event.preventDefault();
    const found = problems(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError('');
    try {
      const created = await api('/api/campaigns', {
        method: 'POST',
        body: {
          brand: form.brand.trim(),
          title: form.title.trim(),
          brief: form.brief.trim(),
          prize: form.prize.trim(),
          deadline: new Date(form.deadline).toISOString(),
        },
      });
      navigate(`/campaigns/${created.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const preview = {
    id: 'preview',
    brand: form.brand.trim() || 'Your brand',
    title: form.title.trim() || 'Your campaign title',
    brief: form.brief.trim() || 'Your brief appears here: who you want to reach, what you want them to do, the budget, and anything off-limits.',
    prize: form.prize.trim() || 'Your prize',
    deadline: new Date(form.deadline).toString() === 'Invalid Date' ? new Date() : new Date(form.deadline),
    status: 'open',
    submission_count: 0,
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="display">Launch a campaign</h1>
          <p className="lede">Write the brief people will pitch against. You’ll see every idea, get an AI-ranked shortlist, and pick the winner yourself.</p>
        </div>
      </header>

      <div className="compose">
        <form className="panel stack" onSubmit={handleSubmit} noValidate>
          <Alert tone="error">{error}</Alert>
          <Field label="Brand or organization" value={form.brand} onChange={update('brand')} error={errors.brand} maxLength={80} placeholder="Sunny Sip" />
          <Field label="Campaign title" value={form.title} onChange={update('title')} error={errors.title} maxLength={120} placeholder="Get students talking about our new drink" />
          <Field
            as="textarea"
            label="The brief"
            rows={8}
            value={form.brief}
            onChange={update('brief')}
            error={errors.brief}
            maxLength={4000}
            hint={`Who it’s for, what you want them to do, budget, timeline, anything off-limits. ${form.brief.trim().length} / 4000`}
          />
          <div className="field-pair">
            <Field label="Prize" value={form.prize} onChange={update('prize')} error={errors.prize} maxLength={120} placeholder="$500 and a feature" />
            <Field label="Deadline" type="datetime-local" value={form.deadline} min={toLocalInput(new Date())} onChange={update('deadline')} error={errors.deadline} />
          </div>
          <div className="form-actions">
            <Button type="submit" loading={busy}>
              Launch campaign
            </Button>
            <Button variant="ghost" onClick={() => navigate(-1)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>

        <aside className="compose-preview" aria-label="Preview">
          <p className="compose-preview-label">How it will look in the list</p>
          <div className="sheet sheet-preview" inert>
            <CampaignRow campaign={preview} />
          </div>
        </aside>
      </div>
    </div>
  );
}
