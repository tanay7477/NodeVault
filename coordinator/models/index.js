/**
 * Unified data layer with MongoDB and JSON-file fallback.
 */

const mongoose = require('mongoose');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrateUserRoles } = require('../migrations/migrateRoles');
const { migrateImportance } = require('../migrations/migrateImportance');

// Ensure JSON file user roles and file importance are migrated
migrateUserRoles();
migrateImportance();

let mongoConnected = false;

/* ─── Schemas ─────────────────────────────────────────── */

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role:     { type: String, enum: ['admin', 'user'], default: 'user' },
}, { timestamps: true });

const fileSchema = new mongoose.Schema({
  fileId:        { type: String, required: true, index: true },
  originalName:  { type: String, required: true },
  mimeType:      { type: String, required: true },
  sizeBytes:     { type: Number, required: true },
  checksum:      { type: String, required: true, index: true },
  owner:         { type: String, required: true, index: true },
  refCount:      { type: Number, default: 1 },
  distribution: [{
    nodeId: String,
    role:   { type: String, enum: ['primary', 'replica', 'backup', 'hot', 'cold'] },
  }],
  importance:    { type: String, enum: ['critical', 'high', 'normal', 'low'], default: 'normal' },
  category:      { type: String, enum: ['video', 'image', 'document', 'archive', 'other'], default: 'other' },
  policy_reason: { type: String, default: '' },
  deleted_at:    { type: Date, default: null, index: true },
  purge_at:      { type: Date, default: null, index: true },
  access_count:  { type: Number, default: 0 },
  last_access:   { type: Date, default: Date.now },
  aiSummary:     { type: String, default: '' },
  tags:          [{ type: String }],
}, { timestamps: true });

// Tamper-evident Audit Log Schema with cryptographic hash chain
const auditSchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  action:    { type: String, required: true },
  resource:  { type: String, default: '' },
  actorIp:   { type: String, default: '127.0.0.1' },
  requestId: { type: String, default: '' },
  prevHash:  { type: String, default: '0000000000000000000000000000000000000000000000000000000000000000' },
  hash:      { type: String, required: true },
  meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
  status:    { type: String, enum: ['success', 'failure', 'info'], default: 'success' },
}, { timestamps: true });

// Share Link Schema - token is stored hashed in DB, never plaintext
const shareLinkSchema = new mongoose.Schema({
  tokenHash:    { type: String, required: true, unique: true, index: true },
  fileId:       { type: String, required: true },
  fileUUID:     { type: String, required: true },
  fileName:     { type: String, required: true },
  mimeType:     { type: String, required: true },
  owner:        { type: String, required: true },
  expiresAt:    { type: Date, required: true, index: true },
  downloads:    { type: Number, default: 0 },
  maxDownloads: { type: Number, default: null },
  distribution: [{ nodeId: String, role: String }],
}, { timestamps: true });

const MongoUser = mongoose.model('User', userSchema);
const MongoFile = mongoose.model('FileMetadata', fileSchema);
const MongoAudit = mongoose.model('AuditLog', auditSchema);
const MongoShare = mongoose.model('ShareLink', shareLinkSchema);

/* ─── JSON File Store Fallback ────────────────────────── */

class JsonStore {
  constructor(name) {
    this.dir = path.join(__dirname, '..', 'data');
    this.filePath = path.join(this.dir, `${name}.json`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.records = fs.existsSync(this.filePath)
      ? JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      : [];
  }

  _persist() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  _matches(item, query) {
    return Object.entries(query).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        if ('$ne' in v) return item[k] !== v.$ne;
        if ('$exists' in v) return v.$exists ? (item[k] !== undefined) : (item[k] === undefined);
        if ('$lte' in v) return item[k] != null && new Date(item[k]) <= new Date(v.$lte);
        if ('$gte' in v) return item[k] != null && new Date(item[k]) >= new Date(v.$gte);
        if ('$in' in v) return Array.isArray(v.$in) && v.$in.includes(item[k]);
      }
      if (v === null) return item[k] === null || item[k] === undefined;
      return item[k] === v;
    });
  }

  async create(data) {
    const doc = {
      _id: crypto.randomUUID(),
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.push(doc);
    this._persist();
    return doc;
  }

  async findOne(query) {
    return this.records.find(r => this._matches(r, query)) || null;
  }

  async findById(id) {
    return this.records.find(r => r._id === id) || null;
  }

  async find(query = {}, opts = {}) {
    let results = this.records.filter(r => this._matches(r, query));
    if (opts.sort) {
      const [field, order] = Object.entries(opts.sort)[0];
      results.sort((a, b) => {
        if (a[field] < b[field]) return order === -1 ? 1 : -1;
        if (a[field] > b[field]) return order === -1 ? -1 : 1;
        return 0;
      });
    }
    return results;
  }

  async updateOne(query, update) {
    const idx = this.records.findIndex(r => this._matches(r, query));
    if (idx === -1) return { modifiedCount: 0 };
    if (update.$set || update.$inc) {
      if (update.$set) Object.assign(this.records[idx], update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          this.records[idx][k] = (this.records[idx][k] || 0) + v;
        }
      }
    } else {
      Object.assign(this.records[idx], update);
    }
    this.records[idx].updatedAt = new Date().toISOString();
    this._persist();
    return { modifiedCount: 1 };
  }

  async deleteOne(query) {
    const idx = this.records.findIndex(r => this._matches(r, query));
    if (idx === -1) return { deletedCount: 0 };
    this.records.splice(idx, 1);
    this._persist();
    return { deletedCount: 1 };
  }

  async updateMany(query, update) {
    let modifiedCount = 0;
    for (let idx = 0; idx < this.records.length; idx++) {
      if (this._matches(this.records[idx], query)) {
        if (update.$set || update.$inc) {
          if (update.$set) Object.assign(this.records[idx], update.$set);
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              this.records[idx][k] = (this.records[idx][k] || 0) + v;
            }
          }
        } else {
          Object.assign(this.records[idx], update);
        }
        this.records[idx].updatedAt = new Date().toISOString();
        modifiedCount++;
      }
    }
    if (modifiedCount > 0) this._persist();
    return { modifiedCount };
  }

  async deleteMany(query) {
    const before = this.records.length;
    this.records = this.records.filter(r => !this._matches(r, query));
    const deletedCount = before - this.records.length;
    if (deletedCount > 0) this._persist();
    return { deletedCount };
  }
}

function createRepo(Model, storeName) {
  const jsonStore = new JsonStore(storeName);

  return {
    async create(data) {
      if (mongoConnected) return (await Model.create(data)).toObject();
      return jsonStore.create(data);
    },
    async findOne(query) {
      if (mongoConnected) return Model.findOne(query).lean();
      return jsonStore.findOne(query);
    },
    async findById(id) {
      if (mongoConnected) return Model.findById(id).lean();
      return jsonStore.findById(id);
    },
    async find(query = {}, opts = {}) {
      if (mongoConnected) {
        let q = Model.find(query);
        if (opts.sort) q = q.sort(opts.sort);
        return q.lean();
      }
      return jsonStore.find(query, opts);
    },
    async updateOne(query, update) {
      if (mongoConnected) return Model.updateOne(query, update);
      return jsonStore.updateOne(query, update);
    },
    async updateMany(query, update) {
      if (mongoConnected) return Model.updateMany(query, update);
      return jsonStore.updateMany(query, update);
    },
    async deleteOne(query) {
      if (mongoConnected) return Model.deleteOne(query);
      return jsonStore.deleteOne(query);
    },
    async deleteMany(query) {
      if (mongoConnected) return Model.deleteMany(query);
      return jsonStore.deleteMany(query);
    },
  };
}

const User         = createRepo(MongoUser, 'users');
const FileMetadata = createRepo(MongoFile, 'files');
const AuditLog     = createRepo(MongoAudit, 'audit');
const ShareLink    = createRepo(MongoShare, 'shares');

async function connectDB(uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    mongoConnected = true;
    console.log('[DB] Connected to MongoDB');

    try {
      const adminEmail = (process.env.ADMIN_EMAIL || 'admin@nodevault.local').toLowerCase().trim();
      await MongoUser.updateMany({ role: { $exists: false } }, { $set: { role: 'user' } });
      await MongoUser.updateMany({ email: { $in: ['admin@nodevault.local', adminEmail] } }, { $set: { role: 'admin' } });
    } catch (_) {}
  } catch (err) {
    console.warn(`[DB] MongoDB unavailable (${err.message}). Using persistent JSON store in coordinator/data/`);
  }
}

module.exports = { User, FileMetadata, AuditLog, ShareLink, connectDB };
