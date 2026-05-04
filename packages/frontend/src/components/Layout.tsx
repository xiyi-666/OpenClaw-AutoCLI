import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-bg)]">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-header flex items-center px-5 border-b border-[var(--color-border)] shrink-0 bg-[var(--color-bg-panel)]">
          <h1 className="text-sm font-semibold tracking-wide text-[var(--color-text-primary)] font-heading">
            OpenClaw Console
          </h1>
        </header>
        <div className="flex-1 overflow-auto min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
