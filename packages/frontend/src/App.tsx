import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Sessions = lazy(() => import('./pages/Sessions'));
const AcpRuns = lazy(() => import('./pages/AcpRuns'));
const Monitor = lazy(() => import('./pages/Monitor'));
const Settings = lazy(() => import('./pages/Settings'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-[var(--color-text-secondary)] text-sm animate-pulse">Loading...</div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          path="/"
          element={
            <Suspense fallback={<PageLoader />}>
              <Dashboard />
            </Suspense>
          }
        />
        <Route
          path="/tasks"
          element={
            <Suspense fallback={<PageLoader />}>
              <Tasks />
            </Suspense>
          }
        />
        <Route
          path="/sessions"
          element={
            <Suspense fallback={<PageLoader />}>
              <Sessions />
            </Suspense>
          }
        />
        <Route
          path="/acp"
          element={
            <Suspense fallback={<PageLoader />}>
              <AcpRuns />
            </Suspense>
          }
        />
        <Route
          path="/monitor"
          element={
            <Suspense fallback={<PageLoader />}>
              <Monitor />
            </Suspense>
          }
        />
        <Route
          path="/settings"
          element={
            <Suspense fallback={<PageLoader />}>
              <Settings />
            </Suspense>
          }
        />
      </Route>
    </Routes>
  );
}
