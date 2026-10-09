import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Logo from './Logo.jsx';
import { Avatar } from './ui.jsx';

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="topbar-logo" aria-label="CrowdCampaign home">
            <Logo />
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/campaigns">Campaigns</NavLink>
            <NavLink to="/intel">Market intel</NavLink>
          </nav>
          <div className="topbar-actions">
            <Link to="/campaigns/new" className="btn btn-primary btn-small">
              Launch a campaign
            </Link>
            <Link to="/account" className="user-chip" title="Your account">
              <Avatar name={user.username} size="sm" />
              <span className="user-chip-name">{user.username}</span>
            </Link>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => {
                logout('You logged out.');
                navigate('/login');
              }}
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="footer">
        <p>CrowdCampaign prototype. The AI recommends a shortlist; people pick every winner.</p>
      </footer>
    </div>
  );
}
