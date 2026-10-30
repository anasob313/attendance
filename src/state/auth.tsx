import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session as AuthSession, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthState {
  ready: boolean;
  user: User | null;
  session: AuthSession | null;
  /** Set when the user arrived through a password-reset e-mail link. */
  recovery: boolean;
  clearRecovery(): void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; session: AuthSession | null; recovery: boolean }>({
    ready: false, session: null,
    recovery: typeof location !== 'undefined' && /type=recovery/.test(location.hash),
  });

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setState((s) => ({ ...s, ready: true, session: data.session }));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setState((s) => ({ ...s, ready: true, session, recovery: s.recovery || event === 'PASSWORD_RECOVERY' }));
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = {
    ready: state.ready,
    session: state.session,
    user: state.session?.user ?? null,
    recovery: state.recovery,
    clearRecovery: () => setState((s) => ({ ...s, recovery: false })),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
