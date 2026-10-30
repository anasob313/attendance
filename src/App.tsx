import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './state/auth';
import { DataProvider } from './state/data';
import { UiProvider } from './state/ui';
import { isConfigured } from './lib/supabase';
import { syncPushSubscription } from './lib/push';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { Dashboard } from './pages/Dashboard';
import { CalendarPage } from './pages/Calendar';
import { HistoryPage } from './pages/History';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { LeavePage } from './pages/Leave';
import { AccountPage } from './pages/Account';
import { InstallPage } from './pages/Install';
import { ForgotPage, LoginPage, ResetPasswordPage, SetupRequiredPage, SignupPage } from './pages/Auth';

function SignedInApp() {
  useEffect(() => { void syncPushSubscription(); }, []);
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="leave" element={<LeavePage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="install" element={<InstallPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Root() {
  const { ready, user, recovery } = useAuth();
  if (!isConfigured) return <SetupRequiredPage />;
  if (!ready) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  if (recovery) {
    return (
      <Routes>
        <Route path="*" element={<ResetPasswordPage />} />
      </Routes>
    );
  }
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/install" element={<InstallPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <DataProvider key={user.id} userId={user.id} email={user.email ?? ''}>
      <SignedInApp />
    </DataProvider>
  );
}

/**
 * When hosted at a sub-path (/repo/), React Router shows the home page as
 * "/repo". Keep the trailing slash so the address stays inside the service
 * worker's scope (offline start, reloads).
 */
function KeepBaseSlash() {
  const location = useLocation();
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    if (base !== '/' && window.location.pathname === base.replace(/\/$/, '')) {
      window.history.replaceState(window.history.state, '', base + window.location.search + window.location.hash);
    }
  }, [location]);
  return null;
}

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
      <KeepBaseSlash />
      <UiProvider>
        <AuthProvider>
          <Root />
        </AuthProvider>
      </UiProvider>
    </BrowserRouter>
  );
}
