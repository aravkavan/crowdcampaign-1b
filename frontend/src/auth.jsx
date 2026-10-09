// Who is logged in, shared with every page through React context.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, onUnauthorized, setToken } from './api.js';

const AuthContext = createContext(null);
const EXPIRED = 'Your session ended. Log in again to continue.';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // loading: checking a saved token | authed | guest | offline: backend unreachable
  const [status, setStatus] = useState(() => (getToken() ? 'loading' : 'guest'));
  const [notice, setNotice] = useState('');

  const logout = useCallback((message = '') => {
    setToken(null);
    setUser(null);
    setStatus('guest');
    setNotice(message);
  }, []);

  const loadUser = useCallback(async () => {
    if (!getToken()) {
      setStatus('guest');
      return;
    }
    setStatus('loading');
    try {
      setUser(await api('/api/auth/me'));
      setStatus('authed');
    } catch (err) {
      if (err.status === 0) setStatus('offline');
      else logout(err.status === 401 ? EXPIRED : '');
    }
  }, [logout]);

  useEffect(() => onUnauthorized(() => logout(EXPIRED)), [logout]);
  useEffect(() => {
    loadUser();
  }, [loadUser]);

  const startSession = useCallback((data) => {
    setToken(data.token);
    setUser(data.user);
    setStatus('authed');
    setNotice('');
  }, []);

  const login = useCallback(
    async (identifier, password) => {
      startSession(await api('/api/auth/login', { method: 'POST', body: { username: identifier, password } }));
    },
    [startSession],
  );

  const register = useCallback(
    async (fields) => {
      startSession(await api('/api/auth/register', { method: 'POST', body: fields }));
    },
    [startSession],
  );

  const value = useMemo(
    () => ({ user, status, notice, login, register, logout, retry: loadUser, setUser }),
    [user, status, notice, login, register, logout, loadUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
