import Logo from './Logo.jsx';

// The two-column frame around the login and register forms.
export default function AuthShell({ children }) {
  return (
    <div className="auth">
      <section className="auth-poster" aria-label="How CrowdCampaign works">
        <Logo inverted />
        <p className="poster-headline">Brands bring the brief. The crowd brings the ideas.</p>
        <ol className="poster-steps">
          <li>
            <span>
              <strong>Post a brief.</strong> Set the goal, the deadline and the prize.
            </span>
          </li>
          <li>
            <span>
              <strong>Collect ideas.</strong> Anyone with an account can pitch one per campaign.
            </span>
          </li>
          <li>
            <span>
              <strong>Get a shortlist.</strong> An AI scores every idea and ranks a top ten.
            </span>
          </li>
          <li>
            <span>
              <strong>Pick the winner.</strong> The AI recommends. A person decides.
            </span>
          </li>
        </ol>
      </section>
      <section className="auth-panel">
        <div className="auth-card">{children}</div>
      </section>
    </div>
  );
}
