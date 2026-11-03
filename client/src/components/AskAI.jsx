import { useState, useEffect, useRef } from 'react';
import { Sparkles, Send, FileText, AlertCircle } from 'lucide-react';
import { askAI, getAIStatus } from '../api';
import { Button, Badge, Skeleton } from './ui';

const EXAMPLE_QUESTIONS = [
  'What documents and records are stored?',
  'Summarize key information from my files',
  'Find key metrics, dates, or action items',
];

export default function AskAI({ refreshKey }) {
  const [status, setStatus] = useState({ configured: false, indexedFiles: 0, loading: true });
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const fetchStatus = async () => {
    const { data } = await getAIStatus();
    if (data) {
      setStatus({
        configured: Boolean(data.configured),
        indexedFiles: Number(data.indexedFiles || 0),
        loading: false,
      });
    } else {
      setStatus(prev => ({ ...prev, loading: false }));
    }
  };

  // Initial status fetch
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    fetchStatus();
  }, []);

  // Re-fetch 1.5s after the file list changes because indexing is async
  useEffect(() => {
    if (refreshKey === undefined || refreshKey === null) return;
    const timer = setTimeout(fetchStatus, 1500);
    return () => clearTimeout(timer);
  }, [refreshKey]);

  const handleSubmit = async (overrideQuestion) => {
    const q = (typeof overrideQuestion === 'string' ? overrideQuestion : question).trim();
    if (!q || loading || !status.configured) return;

    if (q.length < 3 || q.length > 500) {
      setError('Question must be between 3 and 500 characters');
      return;
    }

    setQuestion(q);
    setLoading(true);
    setError(null);
    setResult(null);

    const { data, error: err } = await askAI(q);
    setLoading(false);

    if (err) {
      setError(err);
    } else if (data) {
      setResult(data);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="bg-[#11141A] border border-[#1F2530] rounded-[8px] p-4 space-y-3.5">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#5B8DEF]" strokeWidth={1.75} />
          <h3 className="text-sm font-semibold text-[#E6E8EC]">Ask my files</h3>
          {status.loading ? (
            <Skeleton className="h-4 w-28 rounded" />
          ) : (
            <span className="text-xs text-[#98A1B0]">
              · {status.indexedFiles} readable {status.indexedFiles === 1 ? 'file' : 'files'} (.txt, .md, .pdf)
            </span>
          )}
        </div>
        <div>
          {!status.loading && !status.configured && (
            <Badge variant="warning" dot={true}>
              AI not configured on server
            </Badge>
          )}
        </div>
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={question}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!status.configured || loading}
            placeholder={
              !status.configured
                ? 'AI not configured on server'
                : 'Ask a question about your uploaded documents...'
            }
            className="w-full bg-[#161A21] border border-[#1F2530] focus:border-[#5B8DEF] focus:ring-1 focus:ring-[#5B8DEF] rounded-[6px] px-3.5 py-2 text-sm text-[#E6E8EC] placeholder-[#667085] disabled:opacity-50 disabled:cursor-not-allowed outline-none transition-colors pr-16"
          />
          {status.configured && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#667085] font-mono select-none">
              {question.length}/500
            </span>
          )}
        </div>
        <Button
          variant="primary"
          size="md"
          icon={Send}
          loading={loading}
          disabled={!status.configured || !question.trim() || loading}
          onClick={() => handleSubmit()}
        >
          Ask
        </Button>
      </div>

      {/* Example suggestions */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#98A1B0]">
        <span className="text-[#667085]">Try:</span>
        {EXAMPLE_QUESTIONS.map((eq, i) => (
          <button
            key={i}
            type="button"
            disabled={!status.configured || loading}
            onClick={() => {
              setQuestion(eq);
              handleSubmit(eq);
            }}
            className="px-2 py-0.5 rounded bg-[#161A21] hover:bg-[#1F2530] text-[#98A1B0] hover:text-[#E6E8EC] border border-[#1F2530] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-left"
          >
            {eq}
          </button>
        ))}
      </div>

      {/* Loading Skeleton */}
      {loading && (
        <div className="p-3.5 bg-[#161A21] border border-[#1F2530] rounded-[6px] space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      )}

      {/* Error display */}
      {error && !loading && (
        <div className="flex items-start gap-2.5 p-3 bg-[rgba(242,96,92,0.1)] border border-[rgba(242,96,92,0.25)] rounded-[6px] text-xs text-[#F2605C]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.75} />
          <div className="flex-1">
            <p className="font-medium text-[#F2605C]">Query failed</p>
            <p className="text-[#E6E8EC] mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Answer card */}
      {result && !loading && (
        <div className="p-4 bg-[#161A21] border border-[#1F2530] rounded-[6px] space-y-3">
          <div className="text-sm text-[#E6E8EC] leading-relaxed whitespace-pre-wrap">
            {result.answer}
          </div>

          {Array.isArray(result.sources) && result.sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-[#1F2530]">
              <span className="text-xs text-[#667085]">Sources:</span>
              {result.sources.map((src, idx) => (
                <Badge key={idx} variant="info" dot={false} className="gap-1">
                  <FileText className="w-3 h-3 text-[#5B8DEF]" strokeWidth={1.75} />
                  <span className="font-mono text-[11px]">{src}</span>
                </Badge>
              ))}
            </div>
          )}

          <div className="text-[11px] text-[#667085] pt-0.5">
            Searched {result.filesSearched} {result.filesSearched === 1 ? 'file' : 'files'}
            {result.filesSkipped > 0 && ` (${result.filesSkipped} skipped)`}
          </div>
        </div>
      )}
    </div>
  );
}

