import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Upload,
  Download,
  Share2,
  Trash2,
  ShieldCheck,
  Search,
  MoreVertical,
  File,
  FileText,
  Image as ImageIcon,
  Film,
  Archive,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  X
} from 'lucide-react';
import {
  listFiles,
  listTrash,
  restoreFile,
  updateFileImportance,
  uploadFile,
  downloadFile,
  deleteFile,
  createShareLink,
  getUserQuota,
  verifyFileIntegrity,
  getToken
} from '../api';
import {
  Button,
  Badge,
  Modal,
  Toast,
  Tooltip,
  CopyButton,
  EmptyState,
  Skeleton
} from '../components/ui';
import AskAI from '../components/AskAI';

function fmt(bytes) {
  if (!bytes || bytes === 0) return '0 B';
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

function getFileType(file) {
  const mime = file.mimeType || '';
  const ext = (file.originalName || '').split('.').pop().toLowerCase();

  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return 'image';
  }
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(ext)) {
    return 'video';
  }
  if (mime.startsWith('text/') || ['pdf', 'doc', 'docx', 'txt', 'json', 'csv', 'md', 'xlsx'].includes(ext)) {
    return 'doc';
  }
  if (mime.includes('zip') || mime.includes('tar') || ['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) {
    return 'archive';
  }
  return 'other';
}

function FileTypeIcon({ type, className = 'w-4 h-4' }) {
  switch (type) {
    case 'image':
      return <ImageIcon className={`text-[#5B8DEF] shrink-0 ${className}`} strokeWidth={1.75} />;
    case 'video':
      return <Film className={`text-[#A78BFA] shrink-0 ${className}`} strokeWidth={1.75} />;
    case 'doc':
      return <FileText className={`text-[#3DD68C] shrink-0 ${className}`} strokeWidth={1.75} />;
    case 'archive':
      return <Archive className={`text-[#F59E0B] shrink-0 ${className}`} strokeWidth={1.75} />;
    default:
      return <File className={`text-[#98A1B0] shrink-0 ${className}`} strokeWidth={1.75} />;
  }
}

function ImportanceBadge({ importance }) {
  const imp = (importance || 'normal').toLowerCase();
  switch (imp) {
    case 'critical':
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase bg-[#F2605C]/15 text-[#F2605C] border border-[#F2605C]/30">
          Critical
        </span>
      );
    case 'high':
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase bg-amber-500/15 text-amber-400 border border-amber-500/30">
          High
        </span>
      );
    case 'normal':
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase bg-[#5B8DEF]/15 text-[#5B8DEF] border border-[#5B8DEF]/30">
          Normal
        </span>
      );
    case 'low':
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase bg-[#667085]/20 text-[#98A1B0] border border-[#667085]/30">
          Low
        </span>
      );
    default:
      return null;
  }
}

export default function Files() {
  const [activeTab, setActiveTab] = useState('files'); // 'files' | 'trash'
  const [files, setFiles] = useState([]);
  const [trashFiles, setTrashFiles] = useState([]);
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(true);
  const [trashLoading, setTrashLoading] = useState(false);

  // Upload importance option
  const [uploadImportance, setUploadImportance] = useState('normal');

  // Filters & Sorting
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // 'all' | 'images' | 'videos' | 'docs'
  const [sortBy, setSortBy] = useState('date_desc');

  // Selection & Actions
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [activeMenuId, setActiveMenuId] = useState(null);

  // Detail drawer
  const [drawerFileId, setDrawerFileId] = useState(null);
  const drawerFile = useMemo(() => {
    if (!drawerFileId) return null;
    return files.find(f => f._id === drawerFileId || f.fileId === drawerFileId) || null;
  }, [files, drawerFileId]);

  const setDrawerFile = useCallback((fileOrNull) => {
    setDrawerFileId(fileOrNull ? (fileOrNull._id || fileOrNull.fileId) : null);
  }, []);

  // Upload state
  const [isDragging, setIsDragging] = useState(false);
  const [activeUploads, setActiveUploads] = useState([]);
  const fileInputRef = useRef(null);

  // Modals & Drawers
  const [deleteModal, setDeleteModal] = useState({
    isOpen: false,
    filesToDelete: [],
    isBulk: false,
    isCritical: false,
    confirmInput: '',
  });
  const [shareModal, setShareModal] = useState({ isOpen: false, file: null, result: null, ttl: 24, maxDl: '', busy: false });
  const [integrityState, setIntegrityState] = useState({ loading: false, result: null });
  const [toast, setToast] = useState(null);

  const showToast = (message, variant = 'info') => {
    setToast({ message, variant });
  };

  const fetchFiles = useCallback(async () => {
    try {
      const [f, q] = await Promise.all([listFiles(), getUserQuota()]);
      if (f.data) setFiles(f.data);
      if (q.data) {
        setQuota(q.data);
        window.dispatchEvent(new CustomEvent('nodevault:quota_update', { detail: q.data }));
      }
    } catch {
      showToast('Failed to load files', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const res = await listTrash();
      if (res.data) setTrashFiles(res.data);
    } catch {
      showToast('Failed to load trash', 'danger');
    } finally {
      setTrashLoading(false);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    fetchFiles();
    fetchTrash();
  }, [fetchFiles, fetchTrash]);

  // Close row actions menu on outside click
  useEffect(() => {
    function handleClickOutside() {
      setActiveMenuId(null);
    }
    if (activeMenuId) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [activeMenuId]);

  // ─── Upload Handling ──────────────────────────────────────────
  const handleUploadFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;

    const filesArray = Array.from(fileList);
    const newUploads = filesArray.map(f => ({
      id: `${f.name}-${Date.now()}-${Math.random()}`,
      fileObj: f,
      name: f.name,
      size: f.size,
      progress: 0,
      status: 'uploading',
      error: null,
      aborted: false,
    }));

    setActiveUploads(prev => [...newUploads, ...prev]);

    for (const item of newUploads) {
      if (item.aborted) continue;

      const { data, error } = await uploadFile(item.fileObj, (pct) => {
        setActiveUploads(prev =>
          prev.map(u => (u.id === item.id ? { ...u, progress: pct } : u))
        );
      }, uploadImportance);

      if (error) {
        setActiveUploads(prev =>
          prev.map(u => (u.id === item.id ? { ...u, status: 'error', error } : u))
        );
        showToast(`Upload failed for ${item.name}: ${error}`, 'danger');
      } else {
        setActiveUploads(prev =>
          prev.map(u => (u.id === item.id ? { ...u, progress: 100, status: 'completed' } : u))
        );
        showToast(
          data?.deduplicated
            ? `Deduplicated: ${item.name} content exists in cluster`
            : `Uploaded ${item.name} (${data?.policy_reason || 'Replicated'})`,
          'success'
        );
        fetchFiles();

        setTimeout(() => {
          setActiveUploads(prev => prev.filter(u => u.id !== item.id));
        }, 3000);
      }
    }
  };

  const cancelUpload = (id) => {
    setActiveUploads(prev => prev.filter(u => u.id !== id));
  };

  // ─── Download ─────────────────────────────────────────────────
  const handleDownload = async (file) => {
    showToast(`Downloading ${file.originalName}...`, 'info');
    const { error, servedFrom, failover } = await downloadFile(file._id, file.originalName);
    if (error) {
      showToast(`Download failed: ${error}`, 'danger');
    } else if (failover) {
      showToast(`Retrieved with failover from replica on ${servedFrom}`, 'warning');
    } else {
      showToast(`Retrieved from ${servedFrom}`, 'success');
    }
  };

  // ─── Share Link Creation ──────────────────────────────────────
  const openShareModal = (file) => {
    setShareModal({
      isOpen: true,
      file,
      result: null,
      ttl: 24,
      maxDl: '',
      busy: false,
    });
  };

  const handleGenerateShare = async () => {
    if (!shareModal.file) return;
    setShareModal(prev => ({ ...prev, busy: true }));

    const maxDl = shareModal.maxDl ? parseInt(shareModal.maxDl, 10) : null;
    const { data, error } = await createShareLink(shareModal.file._id, shareModal.ttl, maxDl);

    if (error) {
      setShareModal(prev => ({ ...prev, busy: false }));
      showToast(`Share generation failed: ${error}`, 'danger');
    } else {
      const fullUrl = `${window.location.origin}/api/share/${data.token}/download`;
      setShareModal(prev => ({
        ...prev,
        busy: false,
        result: { ...data, fullUrl },
      }));
      showToast('Share link created successfully', 'success');
    }
  };

  // ─── Delete & Soft Delete Handling ────────────────────────────
  const promptDeleteSingle = (file) => {
    const isCritical = file.importance === 'critical';
    setDeleteModal({
      isOpen: true,
      filesToDelete: [file],
      isBulk: false,
      isCritical,
      confirmInput: '',
    });
  };

  const promptDeleteBulk = () => {
    const selectedFiles = files.filter(f => selectedIds.has(f._id));
    if (selectedFiles.length === 0) return;
    const hasCritical = selectedFiles.some(f => f.importance === 'critical');
    setDeleteModal({
      isOpen: true,
      filesToDelete: selectedFiles,
      isBulk: true,
      isCritical: hasCritical,
      confirmInput: '',
    });
  };

  const executeDelete = async () => {
    const targets = deleteModal.filesToDelete;
    let failedCount = 0;

    for (const f of targets) {
      const confirmName = f.importance === 'critical' ? deleteModal.confirmInput : '';
      const { error } = await deleteFile(f._id, confirmName);
      if (error) failedCount++;
    }

    setDeleteModal({ isOpen: false, filesToDelete: [], isBulk: false, isCritical: false, confirmInput: '' });
    setSelectedIds(new Set());

    if (drawerFile && targets.some(f => f._id === drawerFile._id)) {
      setDrawerFile(null);
    }

    if (failedCount > 0) {
      showToast(`Failed to delete ${failedCount} file(s)`, 'danger');
    } else {
      showToast(`Moved ${targets.length} file(s) to trash`, 'success');
    }
    fetchFiles();
    fetchTrash();
  };

  // ─── Restore File from Trash ──────────────────────────────────
  const handleRestore = async (fileId) => {
    const { error } = await restoreFile(fileId);
    if (error) {
      showToast(`Restore failed: ${error}`, 'danger');
    } else {
      showToast('File restored to active storage', 'success');
      fetchFiles();
      fetchTrash();
    }
  };

  // ─── Change File Importance Level ────────────────────────────
  const handleChangeImportance = async (fileId, newImportance) => {
    const { data, error } = await updateFileImportance(fileId, newImportance);
    if (error) {
      showToast(`Failed to update importance: ${error}`, 'danger');
    } else {
      showToast(`Updated to ${newImportance.toUpperCase()} (${data?.policy_reason})`, 'success');
      fetchFiles();
    }
  };

  // ─── Integrity Verification ───────────────────────────────────
  const handleVerifyIntegrity = async (file) => {
    setIntegrityState({ loading: true, result: null });
    const { data, error } = await verifyFileIntegrity(file._id);
    setIntegrityState({ loading: false, result: data || { error } });
  };

  // ─── Selection Logic ──────────────────────────────────────────
  const toggleSelectRow = (id, e) => {
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredFiles.length && filteredFiles.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredFiles.map(f => f._id)));
    }
  };

  // ─── Filtering & Sorting ──────────────────────────────────────
  const filteredFiles = useMemo(() => {
    return files
      .filter(file => {
        // Search filter (Matches Name, Hash, AI Summary, or Tags)
        if (search.trim()) {
          const q = search.toLowerCase();
          const nameMatch = (file.originalName || '').toLowerCase().includes(q);
          const hashMatch = (file.checksum || file.sha256Hash || '').toLowerCase().includes(q);
          const summaryMatch = (file.aiSummary || '').toLowerCase().includes(q);
          const tagMatch = Array.isArray(file.tags) && file.tags.some(t => t.toLowerCase().includes(q));
          if (!nameMatch && !hashMatch && !summaryMatch && !tagMatch) return false;
        }

        // Type filter
        if (typeFilter !== 'all') {
          const t = getFileType(file);
          if (typeFilter === 'images' && t !== 'image') return false;
          if (typeFilter === 'videos' && t !== 'video') return false;
          if (typeFilter === 'docs' && t !== 'doc') return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'date_desc') return new Date(b.createdAt) - new Date(a.createdAt);
        if (sortBy === 'date_asc') return new Date(a.createdAt) - new Date(b.createdAt);
        if (sortBy === 'name_asc') return (a.originalName || '').localeCompare(b.originalName || '');
        if (sortBy === 'name_desc') return (b.originalName || '').localeCompare(a.originalName || '');
        if (sortBy === 'size_desc') return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        if (sortBy === 'size_asc') return (a.sizeBytes || 0) - (b.sizeBytes || 0);
        return 0;
      });
  }, [files, search, typeFilter, sortBy]);

  const allSelected = filteredFiles.length > 0 && selectedIds.size === filteredFiles.length;
  const totalUserBytes = files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
  const quotaMaxBytes = quota?.maxBytes || 500 * 1024 * 1024;
  const token = getToken();

  return (
    <div className="space-y-5 animate-fade-in pb-16">
      {/* ─── Header: Title & Quota Bar ─────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1F2530] pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#E6E8EC]">Files</h1>
            {/* View Tab Switcher */}
            <div className="flex items-center gap-1 bg-[#11141A] border border-[#1F2530] rounded-[6px] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('files')}
                className={`px-3 py-1 rounded-[4px] font-medium transition-colors ${
                  activeTab === 'files'
                    ? 'bg-[#161A21] text-[#E6E8EC] border border-[#2A3140]'
                    : 'text-[#667085] hover:text-[#98A1B0]'
                }`}
              >
                Active ({files.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('trash');
                  fetchTrash();
                }}
                className={`px-3 py-1 rounded-[4px] font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === 'trash'
                    ? 'bg-[#161A21] text-[#E6E8EC] border border-[#2A3140]'
                    : 'text-[#667085] hover:text-[#98A1B0]'
                }`}
              >
                <Trash2 size={12} />
                <span>Trash ({trashFiles.length})</span>
              </button>
            </div>
          </div>
          <p className="text-xs text-[#667085] mt-1">
            {files.length} {files.length === 1 ? 'file' : 'files'} ·{' '}
            <span className="font-mono text-[#E6E8EC]">{fmt(totalUserBytes)}</span> of{' '}
            <span className="font-mono">{fmt(quotaMaxBytes)}</span> allocated
          </p>
        </div>

        {activeTab === 'files' && (
          <div className="flex flex-wrap items-center gap-3">
            {/* Importance selection for next upload */}
            <div className="flex items-center gap-1.5 bg-[#11141A] border border-[#1F2530] rounded-[6px] px-2.5 py-1">
              <span className="text-[11px] text-[#667085] font-medium">Importance:</span>
              <select
                value={uploadImportance}
                onChange={e => setUploadImportance(e.target.value)}
                className="bg-transparent text-xs text-[#E6E8EC] outline-none cursor-pointer font-medium"
              >
                <option value="critical" className="bg-[#11141A]">Critical (3 copies + backup + 30d retention)</option>
                <option value="high" className="bg-[#11141A]">High (3 copies + backup + 30d retention)</option>
                <option value="normal" className="bg-[#11141A]">Normal (2 copies + 7d retention)</option>
                <option value="low" className="bg-[#11141A]">Low (1 copy + 1d retention)</option>
              </select>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => {
                if (e.target.files) {
                  handleUploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <Button
              variant="primary"
              size="md"
              icon={Upload}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload files
            </Button>
          </div>
        )}
      </div>

      {activeTab === 'files' ? (
        <>
          {/* ─── Drag & Drop Zone ────────────────────────────────────────── */}
          <div
            onDragOver={e => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={e => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={e => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer?.files) {
                handleUploadFiles(e.dataTransfer.files);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`transition-colors cursor-pointer rounded-[8px] border ${
              isDragging
                ? 'border-[#5B8DEF] bg-[#5B8DEF]/10'
                : 'border-dashed border-[#1F2530] hover:border-[#2A3140] bg-[#11141A]'
            } ${
              files.length === 0
                ? 'p-8 text-center'
                : 'px-4 py-2.5 flex items-center justify-between'
            }`}
          >
            {files.length === 0 ? (
              <div className="flex flex-col items-center justify-center space-y-2">
                <div className="w-10 h-10 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex items-center justify-center text-[#5B8DEF]">
                  <Upload size={20} strokeWidth={1.75} />
                </div>
                <p className="text-sm font-medium text-[#E6E8EC]">
                  Drag & drop files here, or click to browse
                </p>
                <p className="text-xs text-[#667085]">
                  Smart storage automatically balances replicas, tiers, and offline backup based on importance
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-between w-full text-xs">
                <div className="flex items-center gap-2.5 text-[#98A1B0]">
                  <Upload size={14} strokeWidth={1.75} className="text-[#5B8DEF]" />
                  <span>Drop files here to upload with <strong>{uploadImportance.toUpperCase()}</strong> policy</span>
                </div>
                <span className="text-[11px] font-mono text-[#667085]">Max 500 MB total</span>
              </div>
            )}
          </div>

          {/* ─── Active Upload Progress Rows ───────────────────────────── */}
          {activeUploads.length > 0 && (
            <div className="space-y-2 bg-[#11141A] border border-[#1F2530] rounded-[8px] p-3 animate-fade-in">
              <div className="text-xs font-semibold text-[#E6E8EC] px-1">
                Uploading {activeUploads.length} {activeUploads.length === 1 ? 'file' : 'files'}
              </div>
              {activeUploads.map(upload => (
                <div
                  key={upload.id}
                  className="p-2.5 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex flex-col gap-1.5 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 truncate max-w-md">
                      <File size={14} className="text-[#5B8DEF] shrink-0" />
                      <span className="font-medium text-[#E6E8EC] truncate">{upload.name}</span>
                      <span className="font-mono text-[11px] text-[#667085]">({fmt(upload.size)})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono tabular-nums text-[11px] text-[#98A1B0]">
                        {upload.status === 'error'
                          ? 'Failed'
                          : upload.status === 'completed'
                          ? 'Completed'
                          : `${upload.progress}%`}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelUpload(upload.id);
                        }}
                        className="p-1 text-[#667085] hover:text-[#E6E8EC] transition-colors"
                        aria-label="Cancel upload"
                      >
                        <X size={13} strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>

                  <div className="w-full bg-[#1F2530] h-1.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-150 ${
                        upload.status === 'error'
                          ? 'bg-[#F2605C]'
                          : upload.status === 'completed'
                          ? 'bg-[#3DD68C]'
                          : 'bg-[#5B8DEF]'
                      }`}
                      style={{ width: `${upload.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ─── Toolbar: Search, Sort, Type Filter Chips, Bulk Bar ────── */}
          <div className="space-y-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-sm">
                <Search
                  size={15}
                  strokeWidth={1.75}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-[#667085]"
                />
                <input
                  type="text"
                  placeholder="Search file name, hash, summary or #tags..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#11141A] border border-[#1F2530] focus:border-[#5B8DEF] rounded-[6px] text-[#E6E8EC] placeholder-[#667085] outline-none transition-colors"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <div className="flex items-center gap-1 bg-[#11141A] border border-[#1F2530] rounded-[6px] p-1 text-xs">
                  {[
                    { id: 'all', label: 'All' },
                    { id: 'images', label: 'Images' },
                    { id: 'videos', label: 'Videos' },
                    { id: 'docs', label: 'Docs' },
                  ].map(chip => (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setTypeFilter(chip.id)}
                      className={`px-2.5 py-1 rounded-[4px] text-xs font-medium transition-colors ${
                        typeFilter === chip.id
                          ? 'bg-[#161A21] text-[#E6E8EC] border border-[#2A3140]'
                          : 'text-[#667085] hover:text-[#98A1B0]'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>

                <select
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value)}
                  className="bg-[#11141A] border border-[#1F2530] text-[#E6E8EC] text-xs rounded-[6px] px-2.5 py-1.5 outline-none cursor-pointer hover:border-[#2A3140] transition-colors"
                >
                  <option value="date_desc">Newest first</option>
                  <option value="date_asc">Oldest first</option>
                  <option value="name_asc">Name (A–Z)</option>
                  <option value="name_desc">Name (Z–A)</option>
                  <option value="size_desc">Size (Largest)</option>
                  <option value="size_asc">Size (Smallest)</option>
                </select>
              </div>
            </div>

            {selectedIds.size > 0 && (
              <div className="flex items-center justify-between px-3.5 py-2 bg-[#161A21] border border-[#2A3140] rounded-[6px] text-xs animate-fade-in">
                <span className="font-medium text-[#E6E8EC]">
                  {selectedIds.size} {selectedIds.size === 1 ? 'file' : 'files'} selected
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    Deselect all
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={Trash2}
                    onClick={promptDeleteBulk}
                  >
                    Move to trash ({selectedIds.size})
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ─── Ask my files AI ───────────────────────────────────────── */}
          <AskAI refreshKey={files.length} />

          {/* ─── Files Table ───────────────────────────────────────────── */}
          <div className="bg-[#11141A] border border-[#1F2530] rounded-[8px] overflow-hidden">
            {loading ? (
              <div className="p-4 space-y-2">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-9 rounded-[4px]" />
                ))}
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="p-12 text-center">
                <EmptyState
                  icon={File}
                  title={search ? 'No matching files found' : 'No files stored in cluster'}
                  description={
                    search
                      ? 'Try adjusting your search query or file filter.'
                      : 'Upload your first object to distribute replicas across the cluster.'
                  }
                  action={
                    search ? (
                      <Button variant="secondary" size="sm" onClick={() => { setSearch(''); setTypeFilter('all'); }}>
                        Clear search
                      </Button>
                    ) : (
                      <Button variant="primary" size="sm" icon={Upload} onClick={() => fileInputRef.current?.click()}>
                        Upload file
                      </Button>
                    )
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="w-9 px-3">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                          className="cursor-pointer accent-[#5B8DEF] rounded"
                          aria-label="Select all files"
                        />
                      </th>
                      <th>File name</th>
                      <th>Importance</th>
                      <th>Size</th>
                      <th>Replicas & Policy</th>
                      <th>Uploaded</th>
                      <th className="text-right w-16">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFiles.map(file => {
                      const isChecked = selectedIds.has(file._id);
                      const isDrawerOpen = drawerFile?._id === file._id;
                      const type = getFileType(file);
                      const activeNodes = (file.distribution || []).filter(d => d.role !== 'backup');
                      const hasBackup = (file.distribution || []).some(d => d.role === 'backup');
                      const nodeNames = (file.distribution || []).map(d => d.nodeId).join(', ');

                      return (
                        <tr
                          key={file._id}
                          onClick={() => setDrawerFile(isDrawerOpen ? null : file)}
                          className={`cursor-pointer transition-colors ${
                            isDrawerOpen ? 'bg-[#161A21]' : isChecked ? 'bg-[#161A21]/50' : ''
                          }`}
                        >
                          {/* Checkbox */}
                          <td className="w-9 px-3" onClick={e => toggleSelectRow(file._id, e)}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={e => toggleSelectRow(file._id, e)}
                              className="cursor-pointer accent-[#5B8DEF] rounded"
                              aria-label={`Select ${file.originalName}`}
                            />
                          </td>

                          {/* File Icon + Name + Tags */}
                          <td>
                            <div className="flex flex-col gap-1 max-w-[260px] sm:max-w-xs md:max-w-md">
                              <div className="flex items-center gap-2.5">
                                <FileTypeIcon type={type} />
                                <span className="font-medium text-xs text-[#E6E8EC] truncate">
                                  {file.originalName}
                                </span>
                              </div>
                              {file.tags && file.tags.length > 0 && (
                                <div className="flex items-center gap-1.5 flex-wrap pl-6">
                                  {file.tags.slice(0, 3).map(tag => (
                                    <span key={tag} className="text-[10px] text-[#A78BFA] bg-[#A78BFA]/10 px-1.5 py-0.2 rounded font-mono">
                                      #{tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>

                          {/* Importance Badge */}
                          <td>
                            <ImportanceBadge importance={file.importance} />
                          </td>

                          {/* Size */}
                          <td className="font-mono tabular-nums text-xs text-[#98A1B0]">
                            {fmt(file.sizeBytes)}
                          </td>

                          {/* Replicas & Policy Reason */}
                          <td>
                            <Tooltip content={file.policy_reason || `Stored on: ${nodeNames}`}>
                              <div className="flex items-center gap-1.5">
                                <Badge
                                  variant={activeNodes.length >= 3 ? 'success' : activeNodes.length === 2 ? 'warning' : 'danger'}
                                  size="sm"
                                >
                                  {activeNodes.length} replicas
                                </Badge>
                                {hasBackup && (
                                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                    +backup
                                  </span>
                                )}
                              </div>
                            </Tooltip>
                          </td>

                          {/* Uploaded */}
                          <td>
                            <Tooltip content={new Date(file.createdAt).toUTCString()}>
                              <span className="font-mono tabular-nums text-xs text-[#667085]">
                                {ago(file.createdAt)}
                              </span>
                            </Tooltip>
                          </td>

                          {/* "..." Action Menu */}
                          <td className="text-right" onClick={e => e.stopPropagation()}>
                            <div className="relative inline-block text-left">
                              <button
                                type="button"
                                onClick={() =>
                                  setActiveMenuId(activeMenuId === file._id ? null : file._id)
                                }
                                className="p-1 rounded-[4px] text-[#667085] hover:text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                                aria-label="Actions"
                              >
                                <MoreVertical size={15} strokeWidth={1.75} />
                              </button>

                              {activeMenuId === file._id && (
                                <div className="absolute right-0 top-full mt-1 w-48 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] shadow-xl py-1 z-30 text-xs">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveMenuId(null);
                                      handleDownload(file);
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                                  >
                                    <Download size={14} className="text-[#667085]" />
                                    <span>Download</span>
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveMenuId(null);
                                      openShareModal(file);
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                                  >
                                    <Share2 size={14} className="text-[#667085]" />
                                    <span>Create share link</span>
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveMenuId(null);
                                      setDrawerFile(file);
                                      handleVerifyIntegrity(file);
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#E6E8EC] hover:bg-[#161A21] transition-colors"
                                  >
                                    <ShieldCheck size={14} className="text-[#667085]" />
                                    <span>Verify integrity</span>
                                  </button>

                                  {/* Change Importance Quick Action */}
                                  <div className="border-t border-[#1F2530] my-1" />
                                  <div className="px-3 py-1 text-[10px] uppercase font-bold text-[#667085]">
                                    Change Importance
                                  </div>
                                  {['critical', 'high', 'normal', 'low'].map(lvl => (
                                    <button
                                      key={lvl}
                                      type="button"
                                      onClick={() => {
                                        setActiveMenuId(null);
                                        handleChangeImportance(file._id, lvl);
                                      }}
                                      className={`w-full flex items-center justify-between px-3 py-1 text-left hover:bg-[#161A21] transition-colors ${
                                        (file.importance || 'normal') === lvl ? 'text-[#5B8DEF] font-medium' : 'text-[#98A1B0]'
                                      }`}
                                    >
                                      <span className="capitalize">{lvl}</span>
                                      {(file.importance || 'normal') === lvl && <span>✓</span>}
                                    </button>
                                  ))}

                                  <div className="border-t border-[#1F2530] my-1" />

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveMenuId(null);
                                      promptDeleteSingle(file);
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#F2605C] hover:bg-[rgba(242,96,92,0.12)] transition-colors"
                                  >
                                    <Trash2 size={14} />
                                    <span>Move to trash</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : (
        /* ─── Trash View ─────────────────────────────────────────────── */
        <div className="bg-[#11141A] border border-[#1F2530] rounded-[8px] overflow-hidden">
          {trashLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-[4px]" />
              ))}
            </div>
          ) : trashFiles.length === 0 ? (
            <div className="p-12 text-center">
              <EmptyState
                icon={Trash2}
                title="Trash is empty"
                description="Deleted files are retained here according to their Smart Storage policy before automated permanent purge."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>File name</th>
                    <th>Importance</th>
                    <th>Size</th>
                    <th>Deleted at</th>
                    <th>Purge countdown</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {trashFiles.map(file => (
                    <tr key={file._id}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <FileTypeIcon type={getFileType(file)} />
                          <span className="font-medium text-xs text-[#E6E8EC]">
                            {file.originalName}
                          </span>
                        </div>
                      </td>
                      <td>
                        <ImportanceBadge importance={file.importance} />
                      </td>
                      <td className="font-mono tabular-nums text-xs text-[#98A1B0]">
                        {fmt(file.sizeBytes)}
                      </td>
                      <td className="font-mono text-xs text-[#667085]">
                        {ago(file.deleted_at)}
                      </td>
                      <td>
                        <span className="text-xs font-mono text-amber-400">
                          {file.daysLeft} {file.daysLeft === 1 ? 'day' : 'days'} remaining
                        </span>
                      </td>
                      <td className="text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={RotateCcw}
                          onClick={() => handleRestore(file._id)}
                        >
                          Restore
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─── Right-Side Drawer (File Detail, Preview, Verification) ── */}
      {drawerFile && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div
            className="fixed inset-0 bg-black/60 transition-opacity"
            onClick={() => setDrawerFile(null)}
            aria-hidden="true"
          />

          <div className="relative w-full max-w-md bg-[#11141A] border-l border-[#1F2530] h-full z-50 flex flex-col shadow-2xl animate-fade-in overflow-y-auto">
            {/* Drawer Header */}
            <div className="p-4 border-b border-[#1F2530] flex items-center justify-between sticky top-0 bg-[#11141A]/95 backdrop-blur z-10">
              <div className="flex items-center gap-2.5 min-w-0 pr-2">
                <FileTypeIcon type={getFileType(drawerFile)} className="w-5 h-5 shrink-0" />
                <div className="truncate">
                  <h3 className="text-sm font-semibold text-[#E6E8EC] truncate">
                    {drawerFile.originalName}
                  </h3>
                  <p className="text-[11px] font-mono text-[#667085] tabular-nums">
                    {fmt(drawerFile.sizeBytes)} · {ago(drawerFile.createdAt)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDrawerFile(null)}
                className="p-1 rounded text-[#667085] hover:text-[#E6E8EC] hover:bg-[#161A21] transition-colors shrink-0"
                aria-label="Close drawer"
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-5 space-y-6 flex-1">
              {/* Smart Storage Policy Card */}
              <div className="p-3.5 rounded-[6px] bg-[#161A21] border border-[#1F2530] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#667085] uppercase tracking-wider">
                    Smart Storage Policy
                  </span>
                  <ImportanceBadge importance={drawerFile.importance} />
                </div>
                <p className="text-xs font-mono text-[#E6E8EC]">
                  {drawerFile.policy_reason || 'Standard replication'}
                </p>
                <div className="flex items-center justify-between pt-1 border-t border-[#1F2530] text-[11px] text-[#98A1B0]">
                  <span>Category: <strong>{drawerFile.category || getFileType(drawerFile)}</strong></span>
                  <span>Reads: <strong>{drawerFile.access_count || 0}</strong></span>
                </div>
              </div>

              {/* AI Summary & Tags Card (Gemini generated) */}
              {(drawerFile.aiSummary || (drawerFile.tags && drawerFile.tags.length > 0)) && (
                <div className="p-3.5 rounded-[6px] bg-[#A78BFA]/10 border border-[#A78BFA]/30 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#A78BFA]">
                    <Sparkles size={14} />
                    <span>Gemini AI Summary & Tags</span>
                  </div>
                  {drawerFile.aiSummary && (
                    <p className="text-xs text-[#E6E8EC] leading-relaxed">
                      {drawerFile.aiSummary}
                    </p>
                  )}
                  {drawerFile.tags && drawerFile.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {drawerFile.tags.map(tag => (
                        <span key={tag} className="px-2 py-0.5 rounded bg-[#11141A] border border-[#A78BFA]/30 text-[10px] font-mono text-[#A78BFA]">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Media Preview */}
              <div>
                <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider block mb-2">
                  Preview
                </span>
                {getFileType(drawerFile) === 'image' ? (
                  <div className="w-full rounded-[6px] overflow-hidden bg-[#0B0D10] border border-[#1F2530] flex items-center justify-center p-2 min-h-40">
                    <img
                      src={`/api/files/${drawerFile._id}/download?token=${token}`}
                      alt={drawerFile.originalName}
                      className="max-h-56 max-w-full object-contain rounded"
                      onError={e => {
                        e.target.style.display = 'none';
                      }}
                    />
                  </div>
                ) : getFileType(drawerFile) === 'video' ? (
                  <div className="w-full rounded-[6px] overflow-hidden bg-[#0B0D10] border border-[#1F2530]">
                    <video
                      src={`/api/files/${drawerFile._id}/download?token=${token}`}
                      controls
                      className="w-full max-h-56"
                    />
                  </div>
                ) : (
                  <div className="w-full rounded-[6px] bg-[#0B0D10] border border-[#1F2530] p-6 text-center space-y-2">
                    <FileText size={32} strokeWidth={1.5} className="text-[#667085] mx-auto" />
                    <p className="text-xs text-[#98A1B0] font-mono">{drawerFile.mimeType || 'binary object'}</p>
                    <p className="text-[11px] text-[#667085]">Preview not supported for this format</p>
                  </div>
                )}
              </div>

              {/* Full Cryptographic Hash (SHA-256) */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider block">
                  SHA-256 Content Hash
                </span>
                <div className="p-2.5 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-[#E6E8EC] break-all select-all">
                    {drawerFile.checksum || drawerFile.sha256Hash || '—'}
                  </span>
                  <CopyButton text={drawerFile.checksum || drawerFile.sha256Hash || ''} />
                </div>
              </div>

              {/* Replica Placements */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[#667085] uppercase tracking-wider">
                    Distributed Placements ({drawerFile.distribution?.length || 0})
                  </span>
                </div>

                <div className="space-y-1.5">
                  {(drawerFile.distribution || []).map((dist, idx) => (
                    <div
                      key={dist.nodeId || idx}
                      className="p-2 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`dot ${dist.role === 'backup' ? 'dot-blue' : 'dot-green'}`} />
                        <span className="font-mono font-medium text-[#E6E8EC]">{dist.nodeId}</span>
                      </div>
                      <Badge variant={dist.role === 'primary' ? 'info' : dist.role === 'backup' ? 'purple' : 'neutral'} size="sm">
                        {dist.role || 'replica'}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>

              {/* Verify Integrity Section */}
              <div className="p-3.5 rounded-[6px] bg-[#161A21] border border-[#1F2530] space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-[#E6E8EC]">Replica Scrubber</h4>
                    <p className="text-[11px] text-[#667085]">Live per-node SHA-256 comparison</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={integrityState.loading}
                    icon={ShieldCheck}
                    onClick={() => handleVerifyIntegrity(drawerFile)}
                  >
                    Check
                  </Button>
                </div>

                {integrityState.result && (
                  <div className="space-y-2 text-xs pt-1 border-t border-[#1F2530]">
                    <div className="flex items-center gap-2">
                      {integrityState.result.passed ? (
                        <>
                          <CheckCircle2 size={15} className="text-[#3DD68C]" />
                          <span className="font-medium text-[#3DD68C]">Bit-Exact Consensus Verified</span>
                        </>
                      ) : (
                        <>
                          <AlertTriangle size={15} className="text-[#F2605C]" />
                          <span className="font-medium text-[#F2605C]">Replica Discrepancy Detected</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Share Modal ───────────────────────────────────────────── */}
      {shareModal.isOpen && (
        <Modal
          isOpen={shareModal.isOpen}
          onClose={() => setShareModal(prev => ({ ...prev, isOpen: false }))}
          title={shareModal.result ? 'Share Link Ready' : 'Create Public Share Link'}
          description={
            shareModal.result
              ? 'Anyone with this link can download the file directly from cluster replicas.'
              : `Generate a cryptographic token for "${shareModal.file?.originalName}".`
          }
          footer={
            shareModal.result ? (
              <Button
                variant="primary"
                size="md"
                className="w-full"
                onClick={() => {
                  navigator.clipboard.writeText(shareModal.result.fullUrl);
                  showToast('Link copied to clipboard', 'success');
                  setShareModal(prev => ({ ...prev, isOpen: false, result: null }));
                }}
              >
                Copy link and close
              </Button>
            ) : (
              <div className="flex justify-end gap-2 w-full">
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => setShareModal(prev => ({ ...prev, isOpen: false }))}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  loading={shareModal.busy}
                  onClick={handleGenerateShare}
                >
                  Generate link
                </Button>
              </div>
            )
          }
        >
          {shareModal.result ? (
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[11px] text-[#667085] mb-1 font-medium">
                  Shareable download URL
                </label>
                <div className="p-2.5 rounded-[6px] bg-[#0B0D10] border border-[#1F2530] flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-[#E6E8EC] break-all select-all">
                    {shareModal.result.fullUrl}
                  </span>
                  <CopyButton text={shareModal.result.fullUrl} />
                </div>
              </div>
              <div className="p-3 rounded-[6px] bg-[#161A21] border border-[#1F2530] text-[11px] text-[#98A1B0] space-y-1">
                <p>Expires: <span className="font-mono text-[#E6E8EC]">{new Date(shareModal.result.expiresAt).toUTCString()}</span></p>
                <p>Max downloads: <span className="font-mono text-[#E6E8EC]">{shareModal.result.maxDownloads || 'Unlimited'}</span></p>
                <p>Security: <span className="text-[#3DD68C]">Token is SHA-256 hashed at rest</span></p>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-xs font-medium text-[#98A1B0] mb-1.5">
                  Link Expiration (TTL)
                </label>
                <select
                  value={shareModal.ttl}
                  onChange={e => setShareModal(prev => ({ ...prev, ttl: Number(e.target.value) }))}
                  className="w-full bg-[#0B0D10] border border-[#1F2530] text-[#E6E8EC] text-xs rounded-[6px] px-3 py-2 outline-none cursor-pointer"
                >
                  <option value={1}>1 hour</option>
                  <option value={6}>6 hours</option>
                  <option value={24}>24 hours (default)</option>
                  <option value={72}>72 hours</option>
                  <option value={168}>7 days</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#98A1B0] mb-1.5">
                  Maximum Downloads (optional)
                </label>
                <input
                  type="number"
                  min="1"
                  placeholder="Unlimited"
                  value={shareModal.maxDl}
                  onChange={e => setShareModal(prev => ({ ...prev, maxDl: e.target.value }))}
                  className="w-full bg-[#0B0D10] border border-[#1F2530] rounded-[6px] px-3 py-2 text-xs text-[#E6E8EC] placeholder-[#667085] outline-none"
                />
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* ─── Delete Confirmation Modal (Soft Delete & Critical Guard) ─ */}
      {deleteModal.isOpen && (
        <Modal
          isOpen={deleteModal.isOpen}
          onClose={() => setDeleteModal({ isOpen: false, filesToDelete: [], isBulk: false, isCritical: false, confirmInput: '' })}
          title={
            deleteModal.isCritical
              ? 'Critical File Delete Confirmation'
              : deleteModal.isBulk
              ? `Move ${deleteModal.filesToDelete.length} files to trash?`
              : 'Move file to trash?'
          }
          description={
            deleteModal.isCritical
              ? 'This file is marked with CRITICAL importance. Exact name confirmation is required.'
              : 'Files will be held in the Trash according to retention policy before automated purging.'
          }
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button
                variant="ghost"
                size="md"
                onClick={() => setDeleteModal({ isOpen: false, filesToDelete: [], isBulk: false, isCritical: false, confirmInput: '' })}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                icon={Trash2}
                disabled={
                  deleteModal.isCritical &&
                  deleteModal.filesToDelete.length === 1 &&
                  deleteModal.confirmInput.trim() !== deleteModal.filesToDelete[0].originalName
                }
                onClick={executeDelete}
              >
                {deleteModal.isBulk
                  ? `Trash ${deleteModal.filesToDelete.length} files`
                  : 'Move to Trash'}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-xs">
            {deleteModal.isCritical && deleteModal.filesToDelete.length === 1 && (
              <div className="p-3 rounded-[6px] bg-[#F2605C]/10 border border-[#F2605C]/30 space-y-2">
                <p className="text-[#F2605C] font-medium">
                  Please type the exact file name to confirm deletion:
                </p>
                <div className="font-mono text-xs text-[#E6E8EC] bg-[#0B0D10] p-2 rounded border border-[#1F2530] select-all">
                  {deleteModal.filesToDelete[0].originalName}
                </div>
                <input
                  type="text"
                  placeholder="Type exact file name here..."
                  value={deleteModal.confirmInput}
                  onChange={e => setDeleteModal(prev => ({ ...prev, confirmInput: e.target.value }))}
                  className="w-full bg-[#0B0D10] border border-[#1F2530] focus:border-[#F2605C] rounded-[6px] px-3 py-2 text-xs text-[#E6E8EC] outline-none"
                />
              </div>
            )}

            <p className="text-[#98A1B0]">
              The following {deleteModal.filesToDelete.length === 1 ? 'file' : 'files'} will be moved to Trash:
            </p>
            <div className="max-h-40 overflow-y-auto space-y-1 bg-[#0B0D10] p-2.5 rounded-[6px] border border-[#1F2530]">
              {deleteModal.filesToDelete.map(f => (
                <div key={f._id} className="flex items-center justify-between text-xs py-0.5">
                  <div className="flex items-center gap-2 truncate max-w-xs">
                    <ImportanceBadge importance={f.importance} />
                    <span className="text-[#E6E8EC] font-medium truncate">
                      {f.originalName}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-[#667085]">{fmt(f.sizeBytes)}</span>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* ─── Toast Alerts ──────────────────────────────────────────── */}
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
