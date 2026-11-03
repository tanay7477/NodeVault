import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server,
  Layers,
  ShieldCheck,
  ScrollText,
  Eye,
  EyeOff,
  AlertCircle,
  Database
} from 'lucide-react';
import { login, register } from '../api';
import { Button } from '../components/ui';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [validationErrors, setValidationErrors] = useState({});
  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    document.title = isLogin ? 'Sign In — NodeVault' : 'Create Account — NodeVault';
  }, [isLogin]);

  const validate = () => {
    const errs = {};
    if (!isLogin && !form.name.trim()) {
      errs.name = 'Full name is required';
    }
    if (!form.email.trim()) {
      errs.email = 'Email address is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      errs.email = 'Enter a valid email address';
    }
    if (!form.password) {
      errs.password = 'Password is required';
    } else if (form.password.length < 6) {
      errs.password = 'Password must be at least 6 characters';
    }
    return errs;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setServerError('');

    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setValidationErrors(errs);
      return;
    }
    setValidationErrors({});
    setLoading(true);

    const { data, error: err } = isLogin
      ? await login(form.email.trim(), form.password)
      : await register(form.name.trim(), form.email.trim(), form.password);

    setLoading(false);
    if (err) return setServerError(err);
    if (data) navigate(data.user?.role === 'admin' ? '/' : '/files');
  };

  const handleFieldChange = (key) => (e) => {
    setForm({ ...form, [key]: e.target.value });
    if (validationErrors[key]) {
      setValidationErrors({ ...validationErrors, [key]: '' });
    }
    if (serverError) setServerError('');
  };

  const switchMode = (loginMode) => {
    setIsLogin(loginMode);
    setServerError('');
    setValidationErrors({});
  };

  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row bg-[#0B0D10] text-[#E6E8EC]">
      {/* ─── Left Brand Column ───────────────────────────────────────── */}
      <div className="md:w-1/2 flex flex-col justify-between p-8 md:p-14 border-b md:border-b-0 md:border-r border-[#1F2530] bg-[#0B0D10]">
        <div>
          {/* Logo & Product Name */}
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-8 h-8 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex items-center justify-center text-[#5B8DEF]">
              <Database size={18} strokeWidth={1.75} />
            </div>
            <span className="text-base font-semibold tracking-tight text-[#E6E8EC]">NodeVault</span>
          </div>

          {/* Tagline */}
          <p className="text-sm text-[#98A1B0] max-w-md">
            Fault-tolerant distributed object storage
          </p>

          {/* 3 Facts */}
          <div className="mt-12 space-y-6 max-w-md">
            <div className="flex items-start gap-3.5">
              <div className="w-8 h-8 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex items-center justify-center shrink-0 text-[#98A1B0] mt-0.5">
                <Layers size={16} strokeWidth={1.75} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[#E6E8EC]">3-Way Replication</h2>
                <p className="text-xs text-[#98A1B0] mt-1 leading-relaxed">
                  Synchronous quorum writes (W=2, R=2) across independent storage nodes with automated failover and peer recovery.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3.5">
              <div className="w-8 h-8 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex items-center justify-center shrink-0 text-[#98A1B0] mt-0.5">
                <ShieldCheck size={16} strokeWidth={1.75} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[#E6E8EC]">SHA-256 Integrity</h2>
                <p className="text-xs text-[#98A1B0] mt-1 leading-relaxed">
                  End-to-end cryptographic checksum verification, background bit-rot scrubbing, and peer-driven self-healing.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3.5">
              <div className="w-8 h-8 rounded-[6px] bg-[#161A21] border border-[#1F2530] flex items-center justify-center shrink-0 text-[#98A1B0] mt-0.5">
                <ScrollText size={16} strokeWidth={1.75} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[#E6E8EC]">Tamper-Evident Audit Log</h2>
                <p className="text-xs text-[#98A1B0] mt-1 leading-relaxed">
                  Cryptographically linked hash-chain ledger providing non-repudiation and verifiable state provenance.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Meta */}
        <div className="pt-8 mt-8 border-t border-[#1F2530] flex items-center justify-between text-xs text-[#667085]">
          <div className="flex items-center gap-2">
            <Server size={14} strokeWidth={1.75} />
            <span>NodeVault Cluster 2.4</span>
          </div>
          <span className="font-mono text-[11px]">127.0.0.1:5000</span>
        </div>
      </div>

      {/* ─── Right Form Column ──────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-[380px] bg-[#11141A] border border-[#1F2530] rounded-[8px] p-6 shadow-none">
          {/* Mode Switcher */}
          <div className="flex border-b border-[#1F2530] mb-5">
            <button
              type="button"
              onClick={() => switchMode(true)}
              className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors -mb-px ${
                isLogin
                  ? 'border-[#5B8DEF] text-[#E6E8EC]'
                  : 'border-transparent text-[#667085] hover:text-[#98A1B0]'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => switchMode(false)}
              className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors -mb-px ${
                !isLogin
                  ? 'border-[#5B8DEF] text-[#E6E8EC]'
                  : 'border-transparent text-[#667085] hover:text-[#98A1B0]'
              }`}
            >
              Create account
            </button>
          </div>

          {/* Server Error Alert */}
          {serverError && (
            <div className="mb-4 p-2.5 rounded-[6px] bg-[rgba(242,96,92,0.1)] border border-[rgba(242,96,92,0.3)] text-[#F2605C] text-xs flex items-start gap-2">
              <AlertCircle size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
              <span>{serverError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
            {/* Full Name (register mode only) */}
            {!isLogin && (
              <div>
                <label className="block text-xs font-medium text-[#98A1B0] mb-1.5">
                  Full name
                </label>
                <input
                  type="text"
                  placeholder="Engineer Name"
                  value={form.name}
                  onChange={handleFieldChange('name')}
                  className={`w-full bg-[#0B0D10] border ${
                    validationErrors.name ? 'border-[#F2605C]' : 'border-[#1F2530] focus:border-[#5B8DEF]'
                  } rounded-[6px] px-3 py-1.5 text-xs text-[#E6E8EC] placeholder-[#667085] outline-none transition-colors`}
                  autoComplete="name"
                />
                {validationErrors.name && (
                  <p className="text-[11px] text-[#F2605C] mt-1">{validationErrors.name}</p>
                )}
              </div>
            )}

            {/* Email */}
            <div>
              <label className="block text-xs font-medium text-[#98A1B0] mb-1.5">
                Email
              </label>
              <input
                type="email"
                placeholder="admin@nodevault.local"
                value={form.email}
                onChange={handleFieldChange('email')}
                className={`w-full bg-[#0B0D10] border ${
                  validationErrors.email ? 'border-[#F2605C]' : 'border-[#1F2530] focus:border-[#5B8DEF]'
                } rounded-[6px] px-3 py-1.5 text-xs text-[#E6E8EC] placeholder-[#667085] outline-none transition-colors`}
                autoComplete="email"
              />
              {validationErrors.email && (
                <p className="text-[11px] text-[#F2605C] mt-1">{validationErrors.email}</p>
              )}
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-medium text-[#98A1B0] mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={handleFieldChange('password')}
                  className={`w-full bg-[#0B0D10] border ${
                    validationErrors.password ? 'border-[#F2605C]' : 'border-[#1F2530] focus:border-[#5B8DEF]'
                  } rounded-[6px] pl-3 pr-9 py-1.5 text-xs text-[#E6E8EC] placeholder-[#667085] outline-none transition-colors`}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#667085] hover:text-[#98A1B0] transition-colors"
                >
                  {showPassword ? (
                    <EyeOff size={14} strokeWidth={1.75} />
                  ) : (
                    <Eye size={14} strokeWidth={1.75} />
                  )}
                </button>
              </div>
              {validationErrors.password && (
                <p className="text-[11px] text-[#F2605C] mt-1">{validationErrors.password}</p>
              )}
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              className="w-full mt-2"
            >
              {loading ? 'Authenticating...' : isLogin ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          {/* Quick Demo Credential Helper */}
          {isLogin && (
            <div className="pt-4 border-t border-[#1F2530] mt-4 space-y-2">
              <p className="text-[11px] text-[#667085] uppercase tracking-wider font-medium">
                Quick Fill Credentials
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setForm({ name: '', email: 'admin@nodevault.local', password: 'admin-password-2026' });
                    setValidationErrors({});
                    setServerError('');
                  }}
                  className="text-left px-2.5 py-2 rounded-[6px] border border-[#1F2530] bg-[#161A21] hover:border-[#2A3140] text-xs text-[#98A1B0] hover:text-[#E6E8EC] transition-colors"
                >
                  <div className="font-medium text-[#E6E8EC]">Admin</div>
                  <div className="text-[11px] text-[#667085] truncate font-mono">admin@nodevault.local</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setForm({ name: '', email: 'demo@nodevault.local', password: 'demo-password-2026' });
                    setValidationErrors({});
                    setServerError('');
                  }}
                  className="text-left px-2.5 py-2 rounded-[6px] border border-[#1F2530] bg-[#161A21] hover:border-[#2A3140] text-xs text-[#98A1B0] hover:text-[#E6E8EC] transition-colors"
                >
                  <div className="font-medium text-[#E6E8EC]">Standard User</div>
                  <div className="text-[11px] text-[#667085] truncate font-mono">demo@nodevault.local</div>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
