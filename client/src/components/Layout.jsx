import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Files,
  Server,
  Network,
  FlaskConical,
  ScrollText,
  Database,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  Command,
} from 'lucide-react';
import { logout, getUser, getUserQuota, getClusterStatus } from '../api';
import { Badge } from './ui/Badge';
import { Tooltip } from './ui/Tooltip';

function fmt(b) {
  if (!b || b === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${u[i]}`;
}

const adminNav = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/files', label: 'Files', icon: Files },
  { to: '/cluster', label: 'Nodes', icon: Server },
  { to: '/topology', label: 'Topology', icon: Network },
  { to: '/chaos', label: 'Resilience', icon: FlaskConical },
  { to: '/audit', label: 'Audit log', icon: ScrollText },
];

const userNav = [
  { to: '/files', label: 'Files', icon: Files },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = getUser();
  const isAdmin = user?.role === 'admin';

  // ─── Sidebar Collapsed State ─────────────────────────────
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('nodevault_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleSidebar = () => {
    setCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('nodevault_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };

  // ─── Dynamic Page Titles ─────────────────────────────────
  useEffect(() => {
    const titles = {
      '/': 'Overview',
      '/files': 'Files',
      '/cluster': 'Nodes',
      '/topology': 'Topology',
      '/chaos': 'Resilience Lab',
      '/audit': 'Audit Ledger',
    };
    const title = titles[location.pathname] || 'Console';
    document.title = `${title} — NodeVault`;
  }, [location.pathname]);

  // ─── User Quota (Regular User) ───────────────────────────
  const [quota, setQuota] = useState(null);

  useEffect(() => {
    if (isAdmin) return;
    let isMounted = true;

    async function fetchQuota() {
      try {
        const { data } = await getUserQuota();
        if (isMounted && data) {
          setQuota(data);
        }
      } catch {}
    }

    fetchQuota();
    const interval = setInterval(fetchQuota, 3000);
    window.addEventListener('nodevault:quota_update', fetchQuota);

    return () => {
      isMounted = false;
      clearInterval(interval);
      window.removeEventListener('nodevault:quota_update', fetchQuota);
    };
  }, [isAdmin, location.pathname]);

  // ─── Real Cluster Health Status ──────────────────────────
  const [clusterHealth, setClusterHealth] = useState(null);
  useEffect(() => {
    if (!isAdmin) return;
    let isMounted = true;

    async function fetchHealth() {
      try {
        const { data } = await getClusterStatus();
        if (isMounted && data && Array.isArray(data.nodes)) {
          const total = data.nodes.length || 3;
          const online = data.nodes.filter(n => n.status === 'online').length;
          setClusterHealth({ total, online });
        }
      } catch {}
    }

    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isAdmin]);

  // ─── User Menu Dropdown ──────────────────────────────────
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false);
      }
    }
    if (userMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [userMenuOpen]);

  // ─── Command Palette (Ctrl+K) ────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchInputRef = useRef(null);

  const nav = isAdmin ? adminNav : userNav;
  const filteredNav = nav.filter(item =>
    item.label.toLowerCase().includes(paletteQuery.toLowerCase())
  );

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(prev => {
          if (!prev) {
            setPaletteQuery('');
            setSelectedIndex(0);
            setTimeout(() => searchInputRef.current?.focus(), 50);
            return true;
          }
          return false;
        });
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handlePaletteSelect = (to) => {
    setPaletteOpen(false);
    navigate(to);
  };

  const handlePaletteKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % Math.max(1, filteredNav.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + filteredNav.length) % Math.max(1, filteredNav.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredNav[selectedIndex]) {
        handlePaletteSelect(filteredNav[selectedIndex].to);
      }
    } else if (e.key === 'Escape') {
      setPaletteOpen(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const current = nav.find(n => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0B0D10] text-[#E6E8EC]">
      {/* ─── Sidebar (240px collapsible to 64px) ───────────── */}
      <aside
        className={`flex flex-col shrink-0 border-r border-[#1F2530] bg-[#11141A] transition-all duration-150 ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        {/* Brand & Collapse Toggle */}
        <div
          className={`h-12 flex items-center border-b border-[#1F2530] ${
            collapsed ? 'justify-center px-0' : 'justify-between px-4'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Database size={16} strokeWidth={1.75} className="text-[#5B8DEF] shrink-0" />
            {!collapsed && (
              <span className="font-semibold text-sm tracking-tight text-[#E6E8EC] truncate">
                NodeVault
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="p-1 rounded-[4px] text-[#667085] hover:text-[#E6E8EC] hover:bg-[#161A21] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8DEF]"
          >
            {collapsed ? (
              <ChevronRight size={15} strokeWidth={1.75} />
            ) : (
              <ChevronLeft size={15} strokeWidth={1.75} />
            )}
          </button>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
          {nav.map((item) => {
            const Icon = item.icon;
            const content = (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-[6px] text-[13px] transition-colors duration-150 select-none relative ${
                    isActive
                      ? 'bg-[#161A21] text-[#E6E8EC] font-medium before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-[#5B8DEF] before:rounded-r'
                      : 'text-[#98A1B0] hover:text-[#E6E8EC] hover:bg-[#161A21]'
                  } ${collapsed ? 'justify-center px-0' : ''}`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      size={16}
                      strokeWidth={1.75}
                      className={isActive ? 'text-[#5B8DEF] shrink-0' : 'text-[#667085] shrink-0'}
                    />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </>
                )}
              </NavLink>
            );

            return collapsed ? (
              <Tooltip key={item.to} content={item.label} position="right">
                {content}
              </Tooltip>
            ) : (
              content
            );
          })}
        </nav>

        {/* Quota widget for regular users */}
        {!isAdmin && quota && !collapsed && (() => {
          const usedBytes = quota.usedBytes || 0;
          const maxBytes = quota.maxBytes || quota.quotaBytes || 524288000;
          const rawPct = (usedBytes / maxBytes) * 100;
          const pctText = usedBytes === 0 ? '0%' : (rawPct < 0.1 ? '< 0.1%' : (rawPct >= 10 ? Math.round(rawPct) + '%' : rawPct.toFixed(1) + '%'));
          const barWidth = usedBytes === 0 ? 0 : Math.max(2, Math.min(100, rawPct));

          return (
            <div
              className="px-3 py-2.5 mx-2.5 mb-2 rounded-[6px] bg-[#161A21] border border-[#1F2530] text-xs space-y-1.5"
              title={`${fmt(usedBytes)} used of ${fmt(maxBytes)}`}
            >
              <div className="flex justify-between items-center text-[#98A1B0]">
                <span className="text-[11px] font-medium text-[#667085]">Storage Quota</span>
                <span className="tabular-nums font-semibold text-[#E6E8EC] text-[11px]">
                  {pctText}
                </span>
              </div>
              <div className="w-full bg-[#1F2530] h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-[#5B8DEF] h-full rounded-full transition-all duration-300"
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <div className="text-[11px] text-[#667085] tabular-nums truncate">
                {fmt(usedBytes)} / {fmt(maxBytes)}
              </div>
            </div>
          );
        })()}

        {/* Sidebar Footer */}
        <div className="p-2 border-t border-[#1F2530] bg-[#11141A]">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={`w-full flex items-center gap-2 py-1.5 px-2.5 rounded-[6px] text-xs font-medium text-[#98A1B0] hover:text-[#E6E8EC] hover:bg-[#161A21] border border-transparent hover:border-[#1F2530] transition-colors duration-150 cursor-pointer ${
              collapsed ? 'justify-center px-0' : 'justify-between'
            }`}
          >
            <div className="flex items-center gap-2">
              <Search size={14} strokeWidth={1.75} className="text-[#667085]" />
              {!collapsed && <span>Search</span>}
            </div>
            {!collapsed && (
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono text-[#667085] bg-[#161A21] border border-[#1F2530] rounded">
                Ctrl K
              </kbd>
            )}
          </button>
        </div>
      </aside>

      {/* ─── Main Content ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-12 px-8 border-b border-[#1F2530] bg-[#11141A] flex items-center justify-between shrink-0 gap-4">
          {/* Breadcrumb on left */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[#667085]">nodevault</span>
            <span className="text-[#667085]">/</span>
            <span className="font-medium text-[#E6E8EC]">{current?.label || 'Console'}</span>
          </div>

          {/* Right items: Cluster Health + Command Palette + User Dropdown */}
          <div className="flex items-center gap-3">
            {/* Real Cluster Health Pill */}
            {isAdmin && clusterHealth && (
              <div className="hidden sm:flex items-center">
                {clusterHealth.online === clusterHealth.total ? (
                  <Badge variant="success">
                    {clusterHealth.online}/{clusterHealth.total} nodes healthy
                  </Badge>
                ) : clusterHealth.online >= 2 ? (
                  <Badge variant="warning">
                    Degraded {clusterHealth.online}/{clusterHealth.total}
                  </Badge>
                ) : (
                  <Badge variant="danger">
                    Critical {clusterHealth.online}/{clusterHealth.total}
                  </Badge>
                )}
              </div>
            )}

            {/* Quick Command Trigger */}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Command palette"
              className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1 text-xs text-[#98A1B0] hover:text-[#E6E8EC] bg-[#161A21] hover:bg-[#1F2530] border border-[#1F2530] rounded-[6px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8DEF]"
            >
              <Command size={13} strokeWidth={1.75} className="text-[#667085]" />
              <span className="text-[11px] font-mono text-[#667085]">Ctrl+K</span>
            </button>

            {/* User Menu Dropdown */}
            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setUserMenuOpen(prev => !prev)}
                className="flex items-center gap-2 p-1 rounded-[6px] hover:bg-[#161A21] border border-transparent hover:border-[#1F2530] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8DEF]"
              >
                <div className="w-6 h-6 rounded-[4px] bg-[#161A21] border border-[#1F2530] flex items-center justify-center text-[11px] font-semibold text-[#E6E8EC] shrink-0">
                  {user?.name?.charAt(0)?.toUpperCase() || 'U'}
                </div>
                <span className="text-xs font-medium text-[#E6E8EC] hidden md:inline truncate max-w-[120px]">
                  {user?.name || 'User'}
                </span>
                <ChevronDown size={14} strokeWidth={1.75} className="text-[#667085]" />
              </button>

              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-60 bg-[#11141A] border border-[#2A3140] rounded-[8px] shadow-2xl p-2.5 z-50 animate-fade-in text-xs">
                  <div className="px-2 py-1.5 space-y-1">
                    <p className="font-semibold text-[#E6E8EC] truncate">{user?.name || 'User'}</p>
                    <p className="text-[11px] font-mono text-[#667085] truncate">{user?.email || ''}</p>
                    <div className="pt-1">
                      <Badge variant={isAdmin ? 'info' : 'neutral'}>
                        {isAdmin ? 'Admin' : 'User'}
                      </Badge>
                    </div>
                  </div>

                  <div className="border-t border-[#1F2530] my-2" />

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[4px] text-xs font-medium text-[#F2605C] hover:bg-[rgba(242,96,92,0.12)] transition-colors cursor-pointer"
                  >
                    <LogOut size={14} strokeWidth={1.75} />
                    <span>Sign out</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Global Page Container: max-w-[1400px], px-8, py-6 for ALL pages */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-[1400px] mx-auto px-8 py-6 w-full animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>

      {/* ─── Command Palette Dialog (Ctrl+K) ──────────────── */}
      {paletteOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 p-4">
          <div
            className="fixed inset-0 bg-black/65 transition-opacity"
            onClick={() => setPaletteOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-lg bg-[#11141A] border border-[#2A3140] rounded-[8px] shadow-2xl overflow-hidden animate-fade-in z-10"
          >
            {/* Search Input */}
            <div className="px-4 py-3 border-b border-[#1F2530] flex items-center gap-2.5">
              <Search size={16} strokeWidth={1.75} className="text-[#667085]" />
              <input
                ref={searchInputRef}
                type="text"
                value={paletteQuery}
                onChange={e => {
                  setPaletteQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Jump to page..."
                className="w-full bg-transparent text-sm text-[#E6E8EC] placeholder-[#667085] focus:outline-none border-none p-0"
              />
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono text-[#667085] bg-[#161A21] border border-[#1F2530] rounded">
                ESC
              </kbd>
            </div>

            {/* List */}
            <div className="p-2 max-h-72 overflow-y-auto space-y-0.5">
              {filteredNav.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-[#667085]">
                  No matching pages found
                </div>
              ) : (
                filteredNav.map((item, idx) => {
                  const Icon = item.icon;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={item.to}
                      type="button"
                      onClick={() => handlePaletteSelect(item.to)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-[6px] text-xs transition-colors duration-150 cursor-pointer ${
                        isSelected
                          ? 'bg-[#161A21] text-[#E6E8EC] border border-[#1F2530]'
                          : 'text-[#98A1B0] hover:bg-[#161A21] border border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Icon
                          size={15}
                          strokeWidth={1.75}
                          className={isSelected ? 'text-[#5B8DEF]' : 'text-[#667085]'}
                        />
                        <span className="font-medium">{item.label}</span>
                      </div>
                      <span className="text-[11px] font-mono text-[#667085]">{item.to}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
