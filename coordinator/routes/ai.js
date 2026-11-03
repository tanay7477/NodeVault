const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const aiController = require('../controllers/aiController');

const router = express.Router();

const aiAskLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => req.user?.id || req.ip || 'anonymous',
  message: { error: 'Too many AI requests. Please retry in a minute.' },
});

router.post('/ask', auth, aiAskLimiter, aiController.ask);
router.get('/status', auth, aiController.status);

module.exports = router;
