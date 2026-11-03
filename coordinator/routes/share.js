const { Router } = require('express');
const auth = require('../middleware/auth');
const {
  createShare, listShares, revokeShare,
  publicDownload, getShareInfo,
} = require('../controllers/shareController');

const router = Router();

// Public (no auth) — anyone with the token can download
router.get('/:token/download', publicDownload);
router.get('/:token/info',     getShareInfo);

// Authenticated — manage your own shares
router.post('/files/:id/share',        auth, createShare);
router.get('/my-links',                auth, listShares);
router.delete('/links/:shareId',       auth, revokeShare);

module.exports = router;
