/**
 * AI Service & Controller Tests
 *
 * Tests cover:
 *  1. Indexing text and skipping video / unsupported formats
 *  2. Text truncation to maxCharsPerFile
 *  3. removeDoc deletes from store
 *  4. 503 error when AI is not configured (missing key or model)
 *  5. No LLM call when user has no files
 *  6. OWNER ISOLATION: another user's text must never appear in the LLM payload
 *  7. Hallucinated sources removed (keep only exact matches)
 *  8. Fenced JSON parsed cleanly
 *  9. 429 and 500/502 error mapping
 * 10. Total context budget (maxCharsTotal) and filesSkipped tracking
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

describe('AI Feature ("Ask my files")', () => {
  let aiService;
  let testStorePath;
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeAll(() => {
    testStorePath = path.join(os.tmpdir(), `nodevault-test-ai-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.AI_STORE_PATH = testStorePath;
    aiService = require('../services/aiService');
  });

  afterAll(() => {
    if (fs.existsSync(testStorePath)) {
      try { fs.unlinkSync(testStorePath); } catch (_) {}
    }
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    if (fs.existsSync(testStorePath)) {
      try { fs.unlinkSync(testStorePath); } catch (_) {}
    }
    aiService.saveStore({});
    process.env.AI_STORE_PATH = testStorePath;
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_API_KEY = 'test-gemini-key';
    process.env.AI_MODEL = 'gemini-1.5-flash';
    delete process.env.AI_BASE_URL;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // 1. Indexing text and skipping video
  test('indexes text files and skips video/unsupported formats', async () => {
    const textEntry = await aiService.indexFile({
      docId: 'doc-1',
      fileId: 'file-uuid-1',
      owner: 'user-1',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Important meeting notes for 2026.'),
    });

    expect(textEntry).toBeDefined();
    expect(textEntry.fileName).toBe('notes.txt');
    expect(textEntry.text).toBe('Important meeting notes for 2026.');
    expect(textEntry.truncated).toBe(false);

    // Video should be skipped
    const videoEntry = await aiService.indexFile({
      docId: 'doc-2',
      fileId: 'file-uuid-2',
      owner: 'user-1',
      fileName: 'presentation.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
    });

    expect(videoEntry).toBeNull();

    const indexed = aiService.listIndexed('user-1');
    expect(indexed.length).toBe(1);
    expect(indexed[0].docId).toBe('doc-1');
  });

  // 2. Text truncation to maxCharsPerFile
  test('truncates file text exceeding maxCharsPerFile', async () => {
    const longText = 'A'.repeat(25000);
    const entry = await aiService.indexFile({
      docId: 'doc-long',
      fileId: 'file-uuid-long',
      owner: 'user-1',
      fileName: 'long-log.log',
      mimeType: 'text/plain',
      buffer: Buffer.from(longText),
    });

    expect(entry).toBeDefined();
    expect(entry.truncated).toBe(true);
    expect(entry.text.length).toBe(20000);
  });

  // 3. removeDoc deletes indexed doc
  test('removeDoc removes the indexed document', async () => {
    await aiService.indexFile({
      docId: 'doc-to-delete',
      fileId: 'f-del',
      owner: 'user-1',
      fileName: 'temp.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Temporary Markdown'),
    });

    expect(aiService.listIndexed('user-1').length).toBe(1);

    const removed = aiService.removeDoc('doc-to-delete');
    expect(removed).toBe(true);
    expect(aiService.listIndexed('user-1').length).toBe(0);
  });

  // 4. 503 when not configured
  test('throws 503 when AI_API_KEY or AI_MODEL is missing', async () => {
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;

    await expect(aiService.askQuestion('user-1', 'What is the plan?')).rejects.toMatchObject({
      status: 503,
      name: 'AiError',
    });
  });

  // 5. No LLM call when user has no files
  test('returns friendly message and skips LLM call when user has no readable files', async () => {
    const res = await aiService.askQuestion('user-with-no-files', 'What is the quarterly revenue?');

    expect(res.filesSearched).toBe(0);
    expect(res.sources).toEqual([]);
    expect(res.answer).toMatch(/no readable text files/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 6. OWNER ISOLATION
  test('OWNER ISOLATION: another user text is never sent to the LLM', async () => {
    // User A's confidential file
    await aiService.indexFile({
      docId: 'doc-a',
      fileId: 'f-a',
      owner: 'user-A',
      fileName: 'confidential_a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('SECRET_PASSWORD_ALPHA_999'),
    });

    // User B's file
    await aiService.indexFile({
      docId: 'doc-b',
      fileId: 'f-b',
      owner: 'user-B',
      fileName: 'notes_b.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Grocery shopping list: Milk, Eggs, Bread.'),
    });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ answer: 'Milk, Eggs, Bread', sources: ['notes_b.txt'] }) }],
            },
          },
        ],
      }),
    });

    const result = await aiService.askQuestion('user-B', 'What should I buy?');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    const sentUserPrompt = requestBody.contents[0].parts[0].text;

    // Must contain user-B's file
    expect(sentUserPrompt).toContain('Grocery shopping list');
    expect(sentUserPrompt).toContain('notes_b.txt');

    // MUST NOT CONTAIN USER-A's file or secret!
    expect(sentUserPrompt).not.toContain('SECRET_PASSWORD_ALPHA_999');
    expect(sentUserPrompt).not.toContain('confidential_a.txt');

    expect(result.sources).toEqual(['notes_b.txt']);
  });

  // 7. Hallucinated sources removed
  test('removes hallucinated source file names not present in prompt', async () => {
    await aiService.indexFile({
      docId: 'doc-real',
      fileId: 'f-real',
      owner: 'user-1',
      fileName: 'real-doc.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Quarterly growth was 14%.'),
    });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    answer: 'Growth was 14%',
                    sources: ['real-doc.txt', 'phantom-report.pdf', 'fake-wiki.md'],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });

    const result = await aiService.askQuestion('user-1', 'What was the growth?');
    // Only real-doc.txt must remain; phantom and fake sources stripped
    expect(result.sources).toEqual(['real-doc.txt']);
  });

  // 8. Fenced JSON handled
  test('handles fenced markdown JSON responses from LLM', async () => {
    await aiService.indexFile({
      docId: 'doc-fenced',
      fileId: 'f-fenced',
      owner: 'user-1',
      fileName: 'data.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"metric": 42}'),
    });

    const fencedOutput = '```json\n{\n  "answer": "The metric value is 42.",\n  "sources": ["data.json"]\n}\n```';

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: fencedOutput }],
            },
          },
        ],
      }),
    });

    const result = await aiService.askQuestion('user-1', 'What is the metric?');
    expect(result.answer).toBe('The metric value is 42.');
    expect(result.sources).toEqual(['data.json']);
  });

  // 9. 429 and 500 error mapping
  test('maps HTTP 429 rate limit to AiError 429', async () => {
    await aiService.indexFile({
      docId: 'doc-rate',
      fileId: 'f-rate',
      owner: 'user-1',
      fileName: 'file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Hello world'),
    });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Quota exceeded',
    });

    await expect(aiService.askQuestion('user-1', 'Hello?')).rejects.toMatchObject({
      status: 429,
      name: 'AiError',
    });
  });

  test('maps HTTP 500 upstream failure to AiError 502', async () => {
    await aiService.indexFile({
      docId: 'doc-fail',
      fileId: 'f-fail',
      owner: 'user-1',
      fileName: 'file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Hello world'),
    });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Provider crashed',
    });

    await expect(aiService.askQuestion('user-1', 'Hello?')).rejects.toMatchObject({
      status: 502,
      name: 'AiError',
    });
  });

  // 10. Total context budget
  test('respects total context budget maxCharsTotal and tracks filesSkipped', async () => {
    // 5 files of 20000 characters each = 100,000 chars total
    for (let i = 1; i <= 6; i++) {
      await aiService.indexFile({
        docId: `doc-budget-${i}`,
        fileId: `f-budget-${i}`,
        owner: 'user-budget',
        fileName: `file-${i}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('X'.repeat(20000)),
      });
    }

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ answer: 'Budget test answer', sources: ['file-1.txt'] }) }],
            },
          },
        ],
      }),
    });

    const result = await aiService.askQuestion('user-budget', 'Summarize');
    // maxCharsTotal is 100,000. 5 files * 20,000 = 100,000. 6th file cannot fit and is skipped.
    expect(result.filesSearched).toBe(5);
    expect(result.filesSkipped).toBe(1);
  });
});

