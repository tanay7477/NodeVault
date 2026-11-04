const { Router } = require('express');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');
const {
  status,
  toggleNode,
  scrub,
  repair,
  repairMetrics,
  injectCorruption,
  syncBackup,
} = require('../controllers/clusterController');

const router = Router();
router.get('/status',                  auth, requireAdmin, status);
router.post('/nodes/:nodeId/toggle',   auth, requireAdmin, toggleNode);
router.post('/scrub',                  auth, requireAdmin, scrub);
router.post('/repair',                 auth, requireAdmin, repair);
router.get('/repair-metrics',          auth, requireAdmin, repairMetrics);
router.post('/corrupt',                auth, requireAdmin, injectCorruption);
router.post('/sync-backup',            auth, requireAdmin, syncBackup);

module.exports = router;
