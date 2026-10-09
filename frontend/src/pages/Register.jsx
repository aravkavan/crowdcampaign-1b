import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import { Alert, Button, Field } from '../components/ui.jsx';

// The same rules the server enforces, checked early so mistakes show up instantly.
function problems({ username, email, password, confirm }) {
  const found = {};
  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username.trim())) {
    found.username = 'Use 3 to 50 letters, numbers, dots, dashes or underscores.';
  }
  if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) found.email = 'That email doesn’t look right.';
  if (password.length < 8) found.password = 'Use at least 8 characters.';
  else if (password.length > 128) found.password = 'Use at most 128 characters.';
  if (confirm !== password) found.confirm = 'The two passwords don’t match.';
  return found;
}

export default function Register() {
  const { register, notice } = useAuth();
  const [form, setForm] = useState({ username: '', email: '', password: '', confirm: '' });
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
    setError('');
    setBusy(true);
    try {
      await register({ username: form.username.trim(), email: form.email.trim() || undefined, password: form.password });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="auth-title">Create an account</h1>
      <p className="auth-lede">One account lets you launch campaigns and pitch ideas to other people’s.</p>
      <Alert tone="info">{error ? null : notice}</Alert>
      <Alert tone="error">{error}</Alert>
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <Field
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={form.username}
          onChange={update('username')}
          error={errors.username}
          hint="Shown next to your ideas. Letters, numbers, dots, dashes, underscores."
          autoFocus
        />
        <Field
          label="Email (optional)"
          name="email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={update('email')}
          error={errors.email}
          hint="You can also log in with it."
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={update('password')}
          error={errors.password}
          hint="At least 8 characters. A short sentence works well."
        />
        <Field
          label="Confirm password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={update('confirm')}
          error={errors.confirm}
        />
        <Button type="submit" loading={busy} className="btn-block">
          Create account
        </Button>
      </form>
      <p className="auth-switch">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </AuthShell>
  );
}
