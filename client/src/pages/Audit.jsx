import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ScrollText,
  ShieldCheck,
  Download,
  Search,
  CheckCircle2,
  AlertTriangle,
  X,
  Link as LinkIcon,
  ChevronDown,
  ArrowDown
} from 'lucide-react';
import { getAuditLog, verifyAuditChain, downloadAuditExport } from '../api';
import {
  Button,
  Badge,
  PageHeader,
  Tooltip,
  CopyButton,
  Skeleton,
  EmptyState
} from '../components/ui';

function ago(ts) {
  if (!ts) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${Math.floor(diffHour / 24)}d ago`;
}

function normalizeIp(ip) {
  if (!ip) return '127.0.0.1';
  const str = String(ip).trim();
  if (str === '::1' || str === '::ffff:127.0.0.1' || str === 'localhost') return '127.0.0.1';
  if (str.startsWith('::ffff:')) return str.substring(7);
  return str;
}

function getActionBadgeVariant(action) {
  switch (action) {
    case 'upload':
    case 'upload_dedup':
      return 'info';
    case 'download':
      return 'neutral';
    case 'delete':
      return 'danger';
    case 'toggle':
    case 'node_toggle':
      return 'warning';
    case 'scrub':
    case 'scrubber_run':
    case 'repair':
      return 'success';
    case 'login':
    case 'register':
    case 'auth':
      return 'info';
    default:
      return 'neutral';
  }
}

export default function Audit() {
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Verification State
  const [verifying, setVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState(null);

  // Filters & Search
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');

  // Export dropdown state
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef(null);

  // Drawer state
  const [selectedEvent, setSelectedEvent] = useState(null);

  // Close export menu on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false);
      }
    }
    if (exportMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getAuditLog(1, 100);
      if (data) {
        setEvents(data.events || []);
        setTotal(data.total || 0);
      }
    } catch {
      // Keep existing data
    } finally {
      setLoading(false);
    }
  }, []);

  const runVerification = useCallback(async () => {
    setVerifying(true);
    try {
      const { data, error } = await verifyAuditChain();
      if (data) {
        setVerificationResult(data);
      } else {
        setVerificationResult({ valid: false, reason: error || 'Failed to verify ledger' });
      }
    } catch (err) {
      setVerificationResult({ valid: false, reason: err.message });
    } finally {
      setVerifying(false);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    // eslint-disable-next-line react/set-state-in-effect
    fetchLogs();
    runVerification();
  }, [fetchLogs, runVerification]);

  const handleExport = async (format) => {
    setExportMenuOpen(false);
    await downloadAuditExport(format);
  };

  // ─── Client-side Filter ───────────────────────────────────────
  const filteredEvents = useMemo(() => {
    let result = [...events];

    if (actionFilter !== 'all') {
      result = result.filter(ev => {
        if (actionFilter === 'upload') return ev.action === 'upload' || ev.action === 'upload_dedup';
        if (actionFilter === 'download') return ev.action === 'download';
        if (actionFilter === 'delete') return ev.action === 'delete';
        if (actionFilter === 'scrub') return ev.action.includes('scrub') || ev.action.includes('repair');
        if (actionFilter === 'toggle') return ev.action.includes('toggle');
        if (actionFilter === 'auth') return ev.action === 'login' || ev.action === 'register';
        return ev.action === actionFilter;
      });
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(ev =>
        ev.resource?.toLowerCase().includes(q) ||
        ev.action?.toLowerCase().includes(q) ||
        ev.actorIp?.toLowerCase().includes(q) ||
        ev.hash?.toLowerCase().includes(q) ||
        ev.prevHash?.toLowerCase().includes(q)
      );
    }

    return result;
  }, [events, actionFilter, search]);

  return (
    <div className="space-y-6">
      {/* ─── Header: Verified Badge, Verify Button, Export Dropdown ── */}
      <PageHeader
        title="Audit Ledger"
        description="Cryptographically linked append-only hash chain providing non-repudiation and state provenance"
        actions={
          <div className="flex items-center gap-3">
            {/* Ledger Verified Badge */}
            {verificationResult && (
              <Badge variant={verificationResult.valid ? 'success' : 'danger'}>
                {verificationResult.valid ? (
                  <>
                    <CheckCircle2 size={13} strokeWidth={1.75} />
                    <span>Ledger verified ({verificationResult.count || total} blocks)</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={13} strokeWidth={1.75} />
                    <span>Tamper detected (block {verificationResult.brokenIndex})</span>
                  </>
                )}
              </Badge>
            )}

            {/* Verify Ledger Button */}
            <Button
              variant="secondary"
              size="sm"
              loading={verifying}
              icon={ShieldCheck}
              onClick={runVerification}
            >
              Verify ledger
            </Button>

            {/* Export Dropdown */}
            <div className="relative" ref={exportMenuRef}>
              <Button
                variant="secondary"
                size="sm"
                icon={Download}
                onClick={() => setExportMenuOpen(!exportMenuOpen)}
              >
                <span>Export</span>
                <ChevronDown size={13} strokeWidth={1.75} className="ml-0.5 text-[#667085]" />
              </Button>

              {exportMenuOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-40 bg-[#11141A] border border-[#2A3140] rounded-[6px] shadow-2xl py-1 z-30 text-xs animate-fade-in">
                  <button
                    type="button"
                    onClick={() => handleExport('csv')}
                    className="w-full px-3 py-1.5 text-left text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                  >
                    Export CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExport('json')}
                    className="w-full px-3 py-1.5 text-left text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                  >
                    Export JSON (Proofs)
                  </button>
                </div>
              )}
            </div>
          </div>
        }
      />

      {/* ─── Toolbar: Search & Action Filter Chips ──────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search
            size={15}
            strokeWidth={1.75}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#667085]"
          />
          <input
            type="text"
            placeholder="Search by resource, actor IP, hash..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#11141A] border border-[#1F2530] focus:border-[#5B8DEF] rounded-[6px] text-[#E6E8EC] placeholder-[#667085] outline-none transition-colors"
          />
        </div>

        {/* Filter Chips */}
        <div className="flex items-center gap-1 bg-[#11141A] border border-[#1F2530] rounded-[6px] p-1 text-xs overflow-x-auto">
          {[
            { id: 'all', label: 'All' },
            { id: 'upload', label: 'Upload' },
            { id: 'download', label: 'Download' },
            { id: 'delete', label: 'Delete' },
            { id: 'scrub', label: 'Scrub' },
            { id: 'toggle', label: 'Toggle' },
            { id: 'auth', label: 'Auth' },
          ].map(chip => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setActionFilter(chip.id)}
              className={`px-2.5 py-1 rounded-[4px] text-xs font-medium transition-colors shrink-0 ${
                actionFilter === chip.id
                  ? 'bg-[#161A21] text-[#E6E8EC] border border-[#2A3140]'
                  : 'text-[#667085] hover:text-[#98A1B0]'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Dense Audit Table ──────────────────────────────────────── */}
      <div className="bg-[#11141A] border border-[#1F2530] rounded-[8px] overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-2">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-9 rounded-[4px]" />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-12 text-center">
            <EmptyState
              icon={ScrollText}
              title={search ? 'No matching audit records' : 'No events logged yet'}
              description={
                search
                  ? 'Try adjusting your search query or filter chips.'
                  : 'Cluster operations will append verifiable cryptographic blocks here.'
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Actor</th>
                  <th>Status</th>
                  <th>Block hash</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((ev, idx) => {
                  const isSelected = selectedEvent?._id === ev._id;
                  const isSuccess = ev.status === 'success';

                  return (
                    <tr
                      key={ev._id || idx}
                      onClick={() => setSelectedEvent(isSelected ? null : ev)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-[#161A21]' : 'hover:bg-[#161A21]/50'
                      }`}
                    >
                      {/* Action Badge */}
                      <td>
                        <Badge variant={getActionBadgeVariant(ev.action)} size="sm">
                          {ev.action}
                        </Badge>
                      </td>

                      {/* Resource */}
                      <td className="max-w-xs truncate text-xs font-medium text-[#E6E8EC]">
                        <span title={ev.resource}>{ev.resource || '—'}</span>
                      </td>

                      {/* Actor */}
                      <td className="font-mono text-xs text-[#98A1B0]">
                        {normalizeIp(ev.actorIp)}
                      </td>

                      {/* Status */}
                      <td>
                        <span className="flex items-center gap-1.5 text-xs font-medium">
                          <span className={`dot ${isSuccess ? 'dot-green' : 'dot-red'}`} />
                          <span className={isSuccess ? 'text-[#3DD68C]' : 'text-[#F2605C]'}>
                            {ev.status}
                          </span>
                        </span>
                      </td>

                      {/* Truncated Hash + Copy */}
                      <td onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5 font-mono text-[11px] text-[#98A1B0]">
                          <span className="tabular-nums">
                            {ev.hash ? ev.hash.substring(0, 8) : '—'}
                          </span>
                          {ev.hash && <CopyButton text={ev.hash} />}
                        </div>
                      </td>

                      {/* Timestamp */}
                      <td>
                        <Tooltip content={new Date(ev.timestamp || ev.createdAt).toUTCString()}>
                          <span className="font-mono tabular-nums text-xs text-[#667085]">
                            {ago(ev.timestamp || ev.createdAt)}
                          </span>
                        </Tooltip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Inspect Drawer (Prev-Hash -> Hash Chain Visual) ────────── */}
      {selectedEvent && (
        <div className="fixed inset-0 z-40 flex justify-end">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 transition-opacity"
            onClick={() => setSelectedEvent(null)}
            aria-hidden="true"
          />

          {/* Drawer Panel */}
          <div className="relative w-full max-w-md bg-[#11141A] border-l border-[#1F2530] h-full z-50 flex flex-col shadow-2xl animate-fade-in overflow-y-auto">
            {/* Header */}
            <div className="p-4 border-b border-[#1F2530] flex items-center justify-between sticky top-0 bg-[#11141A]/95 backdrop-blur z-10">
              <div className="flex items-center gap-2.5">
                <Badge variant={getActionBadgeVariant(selectedEvent.action)} size="sm">
                  {selectedEvent.action}
                </Badge>
                <div>
                  <h3 className="text-xs font-semibold text-[#E6E8EC] truncate max-w-xs">
                    {selectedEvent.resource || 'Cluster event'}
                  </h3>
                  <span className="text-[11px] font-mono text-[#667085]">
                    {new Date(selectedEvent.timestamp || selectedEvent.createdAt).toUTCString()}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedEvent(null)}
                className="p-1 rounded text-[#667085] hover:text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                aria-label="Close"
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 space-y-6 flex-1">
              {/* ─── Cryptographic Hash Chain Visual ────────────────── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider flex items-center gap-1.5">
                    <LinkIcon size={12} strokeWidth={1.75} />
                    <span>Cryptographic Block Linkage</span>
                  </span>
                  <Badge variant="success" size="sm">Chained</Badge>
                </div>

                {/* Parent Hash Box */}
                <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-[#667085]">
                    <span>Previous Block Hash (prevHash)</span>
                    <CopyButton text={selectedEvent.prevHash || ''} />
                  </div>
                  <div className="font-mono text-xs text-[#98A1B0] break-all select-all">
                    {selectedEvent.prevHash || '0000000000000000000000000000000000000000000000000000000000000000'}
                  </div>
                </div>

                {/* Chain Link Indicator */}
                <div className="flex items-center justify-center py-1">
                  <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-[#161A21] border border-[#1F2530] text-[10px] font-mono text-[#5B8DEF]">
                    <ArrowDown size={11} strokeWidth={1.75} />
                    <span>SHA-256 Chained Hash</span>
                  </div>
                </div>

                {/* Current Block Hash Box */}
                <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#5B8DEF]/50 space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-[#5B8DEF]">
                    <span>Current Block Hash</span>
                    <CopyButton text={selectedEvent.hash || ''} />
                  </div>
                  <div className="font-mono text-xs text-[#E6E8EC] break-all select-all font-medium">
                    {selectedEvent.hash || '—'}
                  </div>
                </div>
              </div>

              {/* Event Attributes */}
              <div className="space-y-3">
                <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider block">
                  Event Properties
                </span>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530]">
                    <span className="text-[11px] text-[#667085] block">Actor IP</span>
                    <span className="font-mono text-[#E6E8EC] mt-0.5 block">
                      {normalizeIp(selectedEvent.actorIp)}
                    </span>
                  </div>

                  <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530]">
                    <span className="text-[11px] text-[#667085] block">Execution status</span>
                    <span className={`font-medium mt-0.5 block ${selectedEvent.status === 'success' ? 'text-[#3DD68C]' : 'text-[#F2605C]'}`}>
                      {selectedEvent.status}
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] space-y-1 text-xs">
                  <span className="text-[11px] text-[#667085] block">Request UUID</span>
                  <span className="font-mono text-[11px] text-[#98A1B0] break-all select-all block">
                    {selectedEvent.requestId || '—'}
                  </span>
                </div>
              </div>

              {/* JSON Metadata Payload */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider block">
                  Payload Metadata (meta)
                </span>
                <pre className="p-3 bg-[#0B0D10] border border-[#1F2530] rounded-[6px] font-mono text-[11px] text-[#98A1B0] overflow-x-auto max-h-48">
                  {JSON.stringify(selectedEvent.meta || {}, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
