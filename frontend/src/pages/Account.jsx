import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Avatar, Button, ConfirmDialog, Field } from '../components/ui.jsx';
import { formatDate } from '../lib/format.js';

export default function Account() {
  const { user } = useAuth();
  return (
    <div className="page page-narrow">
      <header className="account-head">
        <Avatar name={user.username} size="lg" />
        <div>
          <h1 className="display account-name">@{user.username}</h1>
          <p className="muted">
            {user.email ?? 'No email on file'}. Member since {formatDate(user.created_at)}.
          </p>
        </div>
      </header>
      <EmailSection />
      <PasswordSection />
      <DeleteSection />
    </div>
  );
}

function EmailSection() {
  const { user, setUser } = useAuth();
  const [email, setEmail] = useState(user.email ?? '');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setDone('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address, like name@example.com.');
      return;
    }
    setBusy(true);
    try {
      setUser(await api(`/api/users/${user.id}`, { method: 'PATCH', body: { email: email.trim() } }));
      setDone('Email updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="email-heading">
      <h2 id="email-heading" className="panel-title">Email</h2>
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <Alert tone="error">{error}</Alert>
        <Alert tone="success">{done}</Alert>
        <Field label="Email address" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="form-actions">
          <Button type="submit" variant="secondary" loading={busy} disabled={email.trim().toLowerCase() === (user.email ?? '')}>
            Save email
          </Button>
        </div>
      </form>
    </section>
  );
}

function PasswordSection() {
  const { user, login } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setDone('');
    if (!form.current) return setError('Enter your current password.');
    if (form.next.length < 8) return setError('Your new password needs at least 8 characters.');
    if (form.next !== form.confirm) return setError('The new passwords don’t match.');
    setBusy(true);
    try {
      await api(`/api/users/${user.id}`, { method: 'PATCH', body: { password: form.next, current_password: form.current } });
      // Changing the password signs out every existing session, including this one,
      // so log straight back in with the new password.
      await login(user.username, form.next);
      setForm({ current: '', next: '', confirm: '' });
      setDone('Password changed. Any other devices were logged out.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="password-heading">
      <h2 id="password-heading" className="panel-title">Password</h2>
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <Alert tone="error">{error}</Alert>
        <Alert tone="success">{done}</Alert>
        <Field label="Current password" type="password" autoComplete="current-password" value={form.current} onChange={update('current')} />
        <div className="field-pair">
          <Field label="New password" type="password" autoComplete="new-password" value={form.next} onChange={update('next')} hint="At least 8 characters." />
          <Field label="Confirm new password" type="password" autoComplete="new-password" value={form.confirm} onChange={update('confirm')} />
        </div>
        <div className="form-actions">
          <Button type="submit" variant="secondary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
}

function DeleteSection() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/users/${user.id}`, { method: 'DELETE' });
      logout('Your account was deleted.');
      navigate('/register', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <section className="panel panel-danger" aria-labelledby="delete-heading">
      <h2 id="delete-heading" className="panel-title">Delete account</h2>
      <p className="muted">
        This permanently removes your account, the campaigns you run and the ideas you pitched. It can’t be undone.
      </p>
      <Alert tone="error">{error}</Alert>
      <div className="form-actions">
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete my account
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title="Delete your account?"
        confirmLabel="Delete forever"
        tone="danger"
        busy={busy}
        confirmDisabled={typed !== user.username}
        onConfirm={handleDelete}
        onCancel={() => {
          setOpen(false);
          setTyped('');
        }}
      >
        <p>Type your username, <strong>{user.username}</strong>, to confirm.</p>
        <Field label="Username" value={typed} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
      </ConfirmDialog>
    </section>
  );
}
