const { Router } = require('express');
const auth = require('../middleware/auth');
const { single } = require('../middleware/upload');
const {
  upload,
  list,
  trash,
  restore,
  restoreBackup,
  updateImportance,
  download,
  remove,
  quota,
  verify,
} = require('../controllers/fileController');

const router = Router();
router.post('/upload',               auth, single, upload);
router.get('/',                      auth, list);
router.get('/trash',                 auth, trash);
router.get('/quota',                 auth, quota);            // user storage quota
router.post('/:id/restore',          auth, restore);
router.post('/:id/restore-backup',   auth, restoreBackup);
router.patch('/:id/importance',      auth, updateImportance);
router.get('/:id/download',          auth, download);
router.get('/:id/verify',            auth, verify);
router.delete('/:id',                auth, remove);

module.exports = router;
