const { Router } = require('express');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');
const { getAuditLog, verifyAuditChain, exportAuditLog } = require('../controllers/auditController');

const router = Router();

router.get('/',       auth, getAuditLog);
router.get('/verify', auth, requireAdmin, verifyAuditChain);
router.get('/export', auth, requireAdmin, exportAuditLog);

module.exports = router;
