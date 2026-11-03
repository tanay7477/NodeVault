/**
 * Storage Quota Service with In-Flight Space Reservations
 *
 * Prevents race conditions where concurrent uploads bypass the quota limit.
 * Charges quota based on logical storage usage.
 */

const { FileMetadata } = require('../models');

const USER_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB per user

// In-flight reservation tracker: userId -> reservedBytes
const reservations = new Map();

/**
 * Returns total logical bytes stored by a user.
 */
async function getUserUsage(userId) {
  if (!userId) {
    const allFiles = await FileMetadata.find({});
    return allFiles.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);
  }
  const files = await FileMetadata.find({ owner: userId });
  return files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);
}

/**
 * Atomically reserve storage space before accepting upload payload.
 * Returns { success: boolean, release: Function, error?: string }
 */
async function reserveQuota(userId, incomingBytes) {
  const currentUsage = await getUserUsage(userId);
  const currentlyReserved = reservations.get(userId) || 0;
  const projectedTotal = currentUsage + currentlyReserved + incomingBytes;

  if (projectedTotal > USER_QUOTA_BYTES) {
    return {
      allowed: false,
      usedBytes: currentUsage,
      reservedBytes: currentlyReserved,
      quotaBytes: USER_QUOTA_BYTES,
      error: 'Insufficient quota: concurrent or existing uploads exceed 500 MB limit',
    };
  }

  // Atomically lock reservation
  reservations.set(userId, currentlyReserved + incomingBytes);

  return {
    allowed: true,
    release: () => {
      const active = reservations.get(userId) || 0;
      const updated = Math.max(0, active - incomingBytes);
      if (updated === 0) {
        reservations.delete(userId);
      } else {
        reservations.set(userId, updated);
      }
    },
  };
}

/**
 * Returns full quota metrics for console display.
 */
async function getQuotaInfo(userId) {
  const usedBytes = await getUserUsage(userId);
  const reservedBytes = reservations.get(userId) || 0;
  return {
    usedBytes,
    reservedBytes,
    quotaBytes: USER_QUOTA_BYTES,
    maxBytes: USER_QUOTA_BYTES,
    remainingBytes: Math.max(0, USER_QUOTA_BYTES - (usedBytes + reservedBytes)),
    usedPercent: Math.min(100, Math.round(((usedBytes + reservedBytes) / USER_QUOTA_BYTES) * 100)),
  };
}

module.exports = { reserveQuota, getQuotaInfo, USER_QUOTA_BYTES };
