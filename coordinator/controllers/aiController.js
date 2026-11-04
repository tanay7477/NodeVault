const aiService = require('../services/aiService');
const { logEvent } = require('../services/auditService');
const config = require('../config');

exports.ask = async (req, res) => {
  try {
    const { question } = req.body || {};

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question must be a string between 3 and 500 characters' });
    }

    const trimmed = question.trim();
    if (trimmed.length < 3 || trimmed.length > 500) {
      return res.status(400).json({ error: 'Question must be between 3 and 500 characters' });
    }

    const isAdmin = req.user?.role === 'admin';
    const result = await aiService.askQuestion(req.user.id, trimmed, isAdmin);

    // Audit log: Never write the question text to the audit log!
    await logEvent({
      userId: req.user.id,
      action: 'ai_query',
      resource: 'ai',
      actorIp: req.ip,
      meta: {
        questionChars: trimmed.length,
        filesSearched: result.filesSearched,
        sources: result.sources,
      },
      status: 'success',
    });

    return res.json(result);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT' || err.name === 'AbortError' || err.status === 504) {
      return res.status(504).json({ error: 'AI request timed out' });
    }

    if (err instanceof aiService.AiError || (typeof err.status === 'number' && err.status >= 400 && err.status < 600)) {
      return res.status(err.status).json({ error: err.message });
    }

    console.error('[AI] Ask error:', err);
    return res.status(500).json({ error: 'Failed to process AI question: ' + err.message });
  }
};

exports.status = async (req, res) => {
  try {
    const apiKey = process.env.AI_API_KEY || '';
    const model = process.env.AI_MODEL || '';
    const configured = Boolean(apiKey && model);
    const isAdmin = req.user?.role === 'admin';
    let indexed = aiService.listIndexed(req.user.id, isAdmin);
    if (indexed.length === 0) {
      await aiService.syncExistingFiles();
      indexed = aiService.listIndexed(req.user.id, isAdmin);
    }

    return res.json({
      configured,
      indexedFiles: indexed.length,
    });
  } catch (err) {
    console.error('[AI] Status error:', err);
    return res.status(500).json({ error: 'Failed to get AI status' });
  }
};

