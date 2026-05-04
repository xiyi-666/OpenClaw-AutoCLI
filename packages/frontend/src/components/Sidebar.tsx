import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  PlayCircle,
  Activity,
  Settings,
  Sun,
  Moon,
} from 'lucide-react';
import { useTheme } from '../theme';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const NAV_ITEMS = [
  { to: '/', icon: LayoutDashboard, label: '仪表盘' },
  { to: '/tasks', icon: ListTodo, label: '任务' },
  { to: '/sessions', icon: MessageSquare, label: '会话' },
  { to: '/acp', icon: PlayCircle, label: 'ACP' },
  { to: '/monitor', icon: Activity, label: '监控' },
  { to: '/settings', icon: Settings, label: '设置' },
];

export default function Sidebar() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  return (
    <aside className="w-nav flex flex-col items-center py-4 border-r border-[var(--color-border)] bg-[var(--color-bg-panel)]">
      <div className="mb-6">
        <div className="w-8 h-8 rounded bg-[var(--color-accent)] flex items-center justify-center">
          <span className="text-[var(--color-bg)] font-bold text-xs">OC</span>
        </div>
      </div>

      <nav className="flex-1 flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              className={cn(
                'w-10 h-10 rounded-md flex items-center justify-center transition-colors relative',
                isActive
                  ? 'text-[var(--color-accent)] bg-[var(--color-accent-dim)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg)]'
              )}
            >
              <item.icon size={18} strokeWidth={1.5} />
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-5 rounded-r bg-[var(--color-accent)]" />
              )}
            </NavLink>
          );
        })}
      </nav>

      <button
        onClick={toggleTheme}
        title={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
        className="w-10 h-10 rounded-md flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg)] transition-colors"
      >
        {theme === 'dark' ? <Sun size={18} strokeWidth={1.5} /> : <Moon size={18} strokeWidth={1.5} />}
      </button>
    </aside>
  );
}
