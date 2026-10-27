import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, PublicUser, setUnauthorizedHandler, tokenStore } from './api';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<PublicUser>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!tokenStore.get()) {
      setLoading(false);
      return;
    }
    api
      .get<{ user: PublicUser }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(logout)
      .finally(() => setLoading(false));
  }, [logout]);

  const login = async (username: string, password: string) => {
    const r = await api.post<{ token: string; user: PublicUser }>('/auth/login', { username, password });
    tokenStore.set(r.token);
    setUser(r.user);
    return r.user;
  };

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus di dalam AuthProvider');
  return ctx;
}
