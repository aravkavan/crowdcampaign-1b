import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import { Alert, Button, Field } from '../components/ui.jsx';

export default function Login() {
  const { login, notice } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError('Enter your username (or email) and your password.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await login(identifier.trim(), password);
      // Logged in: the router moves on to the page you were headed to.
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="auth-title">Log in</h1>
      <p className="auth-lede">Welcome back. Your briefs and ideas are where you left them.</p>
      <Alert tone="info">{error ? null : notice}</Alert>
      <Alert tone="error">{error}</Alert>
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <Field
          label="Username or email"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoFocus
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" loading={busy} className="btn-block">
          Log in
        </Button>
      </form>
      <p className="auth-switch">
        New here? <Link to="/register">Create an account</Link>
      </p>
    </AuthShell>
  );
}
