import { useState } from 'react';
import { API_URL } from '../api.js';
import Logo from '../components/Logo.jsx';
import { Button } from '../components/ui.jsx';

export default function ServerDown({ onRetry }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="center-page">
      <div className="panel center-card">
        <Logo />
        <h1 className="display center-title">Can’t reach the backend</h1>
        <p>
          The app is running, but the API at <code>{API_URL}</code> isn’t answering.
        </p>
        <ol className="hint-list">
          <li>Open a terminal in the <code>backend</code> folder and run <code>npm start</code>.</li>
          <li>Wait for the line that says the API is running.</li>
          <li>Come back here and try again.</li>
        </ol>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await onRetry();
            setBusy(false);
          }}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
