import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { PageLoader } from './components/ui.jsx';
import Account from './pages/Account.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Home from './pages/Home.jsx';
import Intel from './pages/Intel.jsx';
import Login from './pages/Login.jsx';
import NewCampaign from './pages/NewCampaign.jsx';
import NotFound from './pages/NotFound.jsx';
import Register from './pages/Register.jsx';
import ServerDown from './pages/ServerDown.jsx';

// Pages that need a login. Anyone else is sent to /login, then brought back.
function Protected({ children }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageLoader label="Checking your session" full />;
  if (status !== 'authed') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Layout>{children}</Layout>;
}

// Login and register. Once logged in, go back to where you were headed.
function GuestOnly({ children }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageLoader label="Checking your session" full />;
  if (status === 'authed') return <Navigate to={location.state?.from ?? '/'} replace />;
  return children;
}

export default function App() {
  const { status, retry } = useAuth();
  if (status === 'offline') return <ServerDown onRetry={retry} />;

  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
      <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
      <Route path="/" element={<Protected><Home /></Protected>} />
      <Route path="/campaigns" element={<Protected><Campaigns /></Protected>} />
      <Route path="/campaigns/new" element={<Protected><NewCampaign /></Protected>} />
      <Route path="/campaigns/:id" element={<Protected><CampaignDetail /></Protected>} />
      <Route path="/intel" element={<Protected><Intel /></Protected>} />
      <Route path="/account" element={<Protected><Account /></Protected>} />
      <Route path="*" element={<Protected><NotFound /></Protected>} />
    </Routes>
  );
}
