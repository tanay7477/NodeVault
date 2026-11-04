import { useState, useEffect, useCallback } from 'react';
import {
  Server,
  Activity,
  X,
  RefreshCw,
  ShieldCheck
} from 'lucide-react';
import { getClusterStatus, toggleNode, getUser, triggerBackupSync } from '../api';
import {
  Button,
  Badge,
  Modal,
  Toast,
  Tooltip,
  PageHeader,
  Skeleton
} from '../components/ui';

function fmt(bytes) {
  if (!bytes || bytes === 0 || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

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

function LatencySparkline({ data = [3, 4, 3, 5, 4, 3, 4, 3], width = 140, height = 32 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data, min + 1);
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / (max - min)) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        fill="none"
        stroke="#3DD68C"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

export default function Cluster() {
  const [cluster, setCluster] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [latencyHistory, setLatencyHistory] = useState({}); // { [nodeId]: number[] }

  // Admin Confirmation Modal state: { isOpen: boolean, nodeId: string, action: 'kill' | 'revive' }
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, nodeId: null, action: null });

  const user = getUser();
  const isAdmin = user?.role === 'admin';

  const showToast = (message, variant = 'info') => {
    setToast({ message, variant });
  };

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await getClusterStatus();
      if (data) {
        setCluster(data);

        // Update rolling latency history for sparklines
        if (Array.isArray(data.nodes)) {
          setLatencyHistory(prev => {
            const next = { ...prev };
            data.nodes.forEach(n => {
              const current = next[n.id] || [3, 4, 3, 4];
              const newLat = n.latencyMs != null ? n.latencyMs : (n.status === 'online' ? 3 : 0);
              next[n.id] = [...current.slice(-9), newLat];
            });
            return next;
          });
        }

        // Keep selectedNode synced with fresh telemetry
        if (selectedNode) {
          const updated = data.nodes?.find(n => n.id === selectedNode.id);
          if (updated) setSelectedNode(updated);
        }
      }
    } catch {
      // Ignore poll errors
    } finally {
      setLoading(false);
    }
  }, [selectedNode]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handlePromptToggle = (nodeId, action, e) => {
    if (e) e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      nodeId,
      action,
    });
  };

  const handleConfirmToggle = async () => {
    const { nodeId, action } = confirmModal;
    setConfirmModal({ isOpen: false, nodeId: null, action: null });
    if (!nodeId || !action) return;

    setBusy(true);
    showToast(
      action === 'kill'
        ? `Triggering simulated failure on ${nodeId}...`
        : `Reviving ${nodeId} and reconciling block report...`,
      'info'
    );

    const { error } = await toggleNode(nodeId, action);
    setBusy(false);

    if (error) {
      showToast(`${nodeId}: ${error}`, 'danger');
    } else {
      showToast(
        action === 'kill'
          ? `${nodeId} kill switch enabled (simulated failure)`
          : `${nodeId} revived successfully. Block report dispatched.`,
        'success'
      );
      setTimeout(fetchStatus, 600);
    }
  };

  const [syncingBackup, setSyncingBackup] = useState(false);
  const handleSyncBackup = async () => {
    setSyncingBackup(true);
    const { data, error } = await triggerBackupSync();
    setSyncingBackup(false);
    if (error) {
      showToast(`Backup sync failed: ${error}`, 'error');
    } else {
      showToast(data?.message || `Backup Vault sync complete: ${data?.syncedCount ?? 0} files mirrored`, 'success');
      setTimeout(fetchStatus, 600);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-[6px]" />
          ))}
        </div>
      </div>
    );
  }

  const nodes = cluster?.nodes || [];
  const onlineCount = nodes.filter(n => n.status === 'online').length;
  const totalNodes = nodes.length || 3;
  const quorumMet = onlineCount >= 2;

  return (
    <div className="space-y-6">
      {/* ─── Header & Health Summary ───────────────────────────────── */}
      <PageHeader
        title="Cluster Nodes"
        description="Physical storage nodes, address endpoints, disk allocation, and heartbeat status"
        actions={
          <div className="flex items-center gap-3">
            <Badge variant={quorumMet ? 'success' : 'danger'}>
              {onlineCount}/{totalNodes} nodes online · {quorumMet ? 'Quorum OK' : 'No Quorum'}
            </Badge>
            {isAdmin && (
              <Button
                variant="secondary"
                size="sm"
                icon={ShieldCheck}
                loading={syncingBackup}
                onClick={handleSyncBackup}
              >
                Sync Backup Vault
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              onClick={fetchStatus}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {/* ─── Clean Node Telemetry Table ─────────────────────────────── */}
      <div className="bg-[#11141A] border border-[#1F2530] rounded-[8px] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Node</th>
                <th>Address</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Files</th>
                <th>Disk usage</th>
                <th>Last heartbeat</th>
                {isAdmin && <th className="text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {nodes.map(node => {
                const isOnline = node.status === 'online';
                const isBackup = node.role === 'backup' || node.id === 'node-backup';
                const filesFallbackBytes = (node.files || []).reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
                const diskUsed = Math.max(node.diskUsage?.usedBytes || 0, filesFallbackBytes);
                const diskTotal = node.diskUsage?.totalBytes || 524288000;
                const diskPct = Math.min(100, Math.round((diskUsed / diskTotal) * 100));
                const isSelected = selectedNode?.id === node.id;

                return (
                  <tr
                    key={node.id}
                    onClick={() => setSelectedNode(isSelected ? null : node)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-[#161A21]' : isOnline ? 'hover:bg-[#161A21]/60' : 'bg-[#161A21]/30 opacity-75'
                    }`}
                  >
                    {/* Node ID */}
                    <td>
                      <div className="flex items-center gap-2">
                        {isBackup
                          ? <ShieldCheck size={15} strokeWidth={1.75} className={isOnline ? 'text-[#A78BFA]' : 'text-[#667085]'} />
                          : <Server size={15} strokeWidth={1.75} className={isOnline ? 'text-[#5B8DEF]' : 'text-[#667085]'} />
                        }
                        <span className="font-mono font-medium text-xs text-[#E6E8EC]">
                          {node.id}
                        </span>
                        {isBackup && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-[#A78BFA]/15 text-[#A78BFA] border border-[#A78BFA]/25">
                            VAULT
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Address */}
                    <td className="font-mono text-xs text-[#98A1B0]">
                      {node.url}
                    </td>

                    {/* Status badge */}
                    <td>
                      <Badge variant={isOnline ? 'success' : 'danger'} size="sm">
                        {isOnline ? 'ONLINE' : 'OFFLINE'}
                      </Badge>
                    </td>

                    {/* Latency */}
                    <td className="font-mono tabular-nums text-xs">
                      {isOnline ? (
                        <span className="text-[#3DD68C]">
                          {node.latencyMs != null ? `${node.latencyMs}ms` : '< 5ms'}
                        </span>
                      ) : (
                        <span className="text-[#F2605C]">unreachable</span>
                      )}
                    </td>

                    {/* Files stored */}
                    <td className="font-mono tabular-nums text-xs text-[#98A1B0]">
                      {node.fileCount ?? 0}
                    </td>

                    {/* Disk usage bar */}
                    <td className="w-56">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-[#98A1B0]">
                          <span>{fmt(diskUsed)} / {fmt(diskTotal)}</span>
                          <span>{diskPct}%</span>
                        </div>
                        <div className="w-full bg-[#1F2530] h-1.5 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              diskPct > 80 ? 'bg-[#F2605C]' : 'bg-[#5B8DEF]'
                            }`}
                            style={{ width: `${diskPct}%` }}
                          />
                        </div>
                      </div>
                    </td>

                    {/* Last heartbeat */}
                    <td>
                      <Tooltip content={node.lastCheck ? new Date(node.lastCheck).toUTCString() : 'No signal'}>
                        <span className="font-mono tabular-nums text-xs text-[#667085]">
                          {ago(node.lastCheck)}
                        </span>
                      </Tooltip>
                    </td>

                    {/* Actions (Admin-only) */}
                    {isAdmin && (
                      <td className="text-right" onClick={e => e.stopPropagation()}>
                        {isOnline ? (
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busy}
                            onClick={(e) => handlePromptToggle(node.id, 'kill', e)}
                          >
                            Simulate failure
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={(e) => handlePromptToggle(node.id, 'revive', e)}
                          >
                            Revive
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Detail Drawer Per Node ─────────────────────────────────── */}
      {selectedNode && (
        <div className="fixed inset-0 z-40 flex justify-end">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 transition-opacity"
            onClick={() => setSelectedNode(null)}
            aria-hidden="true"
          />

          {/* Drawer Panel */}
          <div className="relative w-full max-w-md bg-[#11141A] border-l border-[#1F2530] h-full z-50 flex flex-col shadow-2xl animate-fade-in overflow-y-auto">
            {/* Header */}
            <div className="p-4 border-b border-[#1F2530] flex items-center justify-between sticky top-0 bg-[#11141A]/95 backdrop-blur z-10">
              <div className="flex items-center gap-2.5">
                <Server size={18} strokeWidth={1.75} className="text-[#5B8DEF]" />
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[#E6E8EC] font-mono">
                      {selectedNode.id}
                    </h3>
                    <Badge variant={selectedNode.status === 'online' ? 'success' : 'danger'} size="sm">
                      {selectedNode.status.toUpperCase()}
                    </Badge>
                  </div>
                  <span className="text-[11px] font-mono text-[#667085]">{selectedNode.url}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedNode(null)}
                className="p-1 rounded text-[#667085] hover:text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                aria-label="Close"
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 space-y-6 flex-1">
              {/* Latency Sparkline Card */}
              <div className="p-3.5 rounded-[6px] bg-[#161A21] border border-[#1F2530] space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity size={14} strokeWidth={1.75} className="text-[#3DD68C]" />
                    <span className="text-xs font-medium text-[#E6E8EC]">Heartbeat Latency</span>
                  </div>
                  <span className="font-mono text-xs text-[#3DD68C] tabular-nums font-semibold">
                    {selectedNode.latencyMs != null ? `${selectedNode.latencyMs} ms` : 'Offline'}
                  </span>
                </div>

                <div className="h-10 flex items-center justify-between pt-1">
                  <LatencySparkline
                    data={latencyHistory[selectedNode.id] || [3, 4, 3, 5, 4, 3, 4, 3]}
                    width={180}
                    height={32}
                  />
                  <div className="text-[11px] font-mono text-[#667085] text-right">
                    <span>3s ping interval</span>
                    <br />
                    <span>HTTP /health</span>
                  </div>
                </div>
              </div>

              {/* Node Hardware & Disk Capacity */}
              <div className="space-y-3">
                <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider block">
                  Storage Allocation
                </span>

                {(() => {
                  const selectedFallbackBytes = (selectedNode.files || []).reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
                  const selectedUsed = Math.max(selectedNode.diskUsage?.usedBytes || 0, selectedFallbackBytes);
                  const selectedTotal = selectedNode.diskUsage?.totalBytes || 524288000;
                  const selectedPct = Math.min(100, Math.round((selectedUsed / selectedTotal) * 100));

                  return (
                    <>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530]">
                          <span className="text-[11px] text-[#667085] block">Used capacity</span>
                          <span className="text-sm font-semibold font-mono text-[#E6E8EC] mt-0.5 block">
                            {fmt(selectedUsed)}
                          </span>
                        </div>

                        <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530]">
                          <span className="text-[11px] text-[#667085] block">Total allocation</span>
                          <span className="text-sm font-semibold font-mono text-[#E6E8EC] mt-0.5 block">
                            {fmt(selectedTotal)}
                          </span>
                        </div>
                      </div>

                      {/* Progress */}
                      <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] space-y-1.5">
                        <div className="flex justify-between text-xs font-mono text-[#98A1B0]">
                          <span>Disk Utilization</span>
                          <span>{selectedPct}%</span>
                        </div>
                        <div className="w-full bg-[#1F2530] h-1.5 rounded-full overflow-hidden">
                          <div
                            className="bg-[#5B8DEF] h-full rounded-full transition-all duration-300"
                            style={{ width: `${selectedPct}%` }}
                          />
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Physical Storage Directory */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider block">
                  Filesystem Mount Path
                </span>
                <div className="p-2.5 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] font-mono text-xs text-[#98A1B0]">
                  storage-nodes/data/{selectedNode.id}/
                </div>
              </div>

              {/* Replicas on Node */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider">
                    Assigned Replicas ({selectedNode.fileCount ?? (selectedNode.files?.length || 0)})
                  </span>
                  <span className="text-[11px] text-[#667085]">Verified SHA-256</span>
                </div>

                {Array.isArray(selectedNode.files) && selectedNode.files.length > 0 ? (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {selectedNode.files.map(f => (
                      <div
                        key={f.fileId || f._id}
                        className="p-2 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex items-center justify-between text-xs"
                      >
                        <div className="truncate max-w-[200px] text-[#E6E8EC] font-medium">
                          {f.originalName}
                        </div>
                        <Badge variant={f.role === 'primary' ? 'info' : 'neutral'} size="sm">
                          {f.role || 'replica'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 rounded-[6px] bg-[#161A21] border border-[#1F2530] text-center text-xs text-[#667085]">
                    {selectedNode.fileCount ?? 0} physical block replicas on disk
                  </div>
                )}
              </div>
            </div>

            {/* Drawer Footer Actions (Admin-only) */}
            {isAdmin && (
              <div className="p-4 border-t border-[#1F2530] bg-[#11141A] sticky bottom-0">
                {selectedNode.status === 'online' ? (
                  <Button
                    variant="danger"
                    size="md"
                    className="w-full"
                    disabled={busy}
                    onClick={() => handlePromptToggle(selectedNode.id, 'kill')}
                  >
                    Simulate failure (Power OFF)
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="md"
                    className="w-full"
                    disabled={busy}
                    onClick={() => handlePromptToggle(selectedNode.id, 'revive')}
                  >
                    Revive node (Power ON)
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Admin Confirmation Modal (Simulate failure / Revive) ─── */}
      {confirmModal.isOpen && (
        <Modal
          isOpen={confirmModal.isOpen}
          onClose={() => setConfirmModal({ isOpen: false, nodeId: null, action: null })}
          title={
            confirmModal.action === 'kill'
              ? `Simulate Failure on ${confirmModal.nodeId}?`
              : `Revive Node ${confirmModal.nodeId}?`
          }
          description={
            confirmModal.action === 'kill'
              ? 'This will disable the storage node process, simulating unexpected hardware/power loss. Live reads will automatically fail over to surviving replicas.'
              : 'This will bring the storage node back online, emit a full block report to the coordinator, and initiate reconciliation to restore 3-way replication.'
          }
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button
                variant="ghost"
                size="md"
                onClick={() => setConfirmModal({ isOpen: false, nodeId: null, action: null })}
              >
                Cancel
              </Button>
              <Button
                variant={confirmModal.action === 'kill' ? 'danger' : 'primary'}
                size="md"
                onClick={handleConfirmToggle}
              >
                {confirmModal.action === 'kill' ? 'Simulate failure' : 'Revive node'}
              </Button>
            </div>
          }
        >
          <div className="space-y-2 text-xs">
            <div className="p-3 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] text-[#98A1B0] space-y-1">
              <div className="flex justify-between">
                <span>Target:</span>
                <span className="font-mono text-[#E6E8EC] font-semibold">{confirmModal.nodeId}</span>
              </div>
              <div className="flex justify-between">
                <span>Action:</span>
                <span className={confirmModal.action === 'kill' ? 'text-[#F2605C] font-semibold' : 'text-[#3DD68C] font-semibold'}>
                  {confirmModal.action === 'kill' ? 'KILL SWITCH (OFFLINE)' : 'BOOT RECONCILE (ONLINE)'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Quorum Impact:</span>
                <span>{confirmModal.action === 'kill' ? 'Degraded to 2/3 (Quorum intact)' : 'Restored to 3/3'}</span>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── Toast Feedback ────────────────────────────────────────── */}
      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
