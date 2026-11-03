# NodeVault — Architecture & Design Decisions

This document records architectural alternatives considered, implementation trials, trade-offs analyzed, and reasons for accepting or rejecting specific patterns.

---

## 1. Metadata Storage: Dual Mode (MongoDB + Append-Only JSON)

### Alternatives Considered:
1. Pure Embedded SQLite (via `better-sqlite3`)
2. Exclusively MongoDB (via `mongoose`)
3. Hybrid MongoDB with local JSON file fallback

### Decision & Trade-offs:
- **Adopted**: Hybrid architecture. The coordinator connects to MongoDB if available, but falls back gracefully to local JSON persistence (`coordinator/data/`) if the database server is not provisioned or crashes during a demonstration.
- **Why SQLite was rejected**: While SQLite is robust for local storage, native C++ compilation bindings frequently fail across diverse developer environments (Windows node-gyp / MSBuild toolchain discrepancies).
- **Why exclusive MongoDB was rejected**: In offline evaluation or interview scenarios without running daemon containers, requiring MongoDB creates fragile launch friction.

---

## 2. In-Flight Quota Reservation vs. Optimistic Post-Upload Checks

### Alternatives Considered:
1. **Optimistic Check**: Calculate quota upon upload completion before persisting metadata.
2. **Atomic Reservation**: Reserve incoming byte size before accepting the file stream.

### What Failed:
- Optimistic checks suffered from race conditions under concurrent uploads: two parallel 300 MB uploads from a user with a 500 MB quota both observed 0 MB used, proceeded simultaneously, and committed 600 MB of data to the cluster, violating the hard quota SLA.

### Decision:
- Implemented in-flight quota reservations (`reserveQuota`). When an upload starts, incoming byte volume is atomically registered into an active reservation map. If concurrent requests exceed 500 MB, subsequent requests are rejected before buffering network bytes. The reservation is released upon request termination.

---

## 3. Deduplication Architecture: Block-Level vs File-Level

### Alternatives Considered:
1. Variable-sized Content Defined Chunking (CDC via Rabin Fingerprints / FastCDC)
2. Whole-File Content-Addressable Hashing (SHA-256)

### Analysis & Trade-offs:
- **Why CDC was rejected for v1**: Variable-chunking adds significant metadata fragmentation overhead (manifests, chunk trees, garbage collection sweeps) without proportional savings for media files and pre-compressed formats (JPEG, MP4, ZIP) where minor edits invalidate boundary anchors.
- **Adopted**: Whole-file content-addressable deduplication with reference counting (`refCount`).
- **Known Security Trade-Off Documented**: Cross-user deduplication introduces an inference side-channel. An attacker can infer if another tenant has uploaded a specific file by testing upload latencies. In multi-tenant enterprise deployments, deduplication must be scoped per-tenant or paired with Convergent Encryption.

---

## 4. Public File Sharing: Plaintext Tokens vs. Cryptographic Token Hashes

### What was Tried Initially:
- Random 64-character tokens were generated and stored directly in the database. Anyone with read access to the database or backups could impersonate share links.

### Decision:
- Shifted to the security pattern utilized by GitHub Personal Access Tokens and AWS IAM credentials:
  - Coordinator generates 256-bit entropy via `crypto.randomBytes(32)`.
  - The plaintext token is delivered once to the user.
  - The database stores only `tokenHash = SHA256(rawToken)`.
  - Downloads hash the incoming URL token and search by hash index.
  - Expiration and download quotas are validated server-side.

---

## 5. Audit Log: Standard Logging vs. Cryptographic Hash Chain

### Alternatives Considered:
1. Standard logging to MongoDB collection or stdout
2. Append-only cryptographic hash ledger (`prevHash` -> `hash`)

### Decision:
- Implemented an immutable hash chain:
  `hash = SHA256(prevHash | timestamp | userId | action | resource | ip | status)`
- Any modification, deletion, or backdating of a historical log entry breaks subsequent hash pointers, enabling deterministic tamper verification through `verifyChain()`.

---

## 6. Real-Time Telemetry: Polling vs. Event-Driven WebSocket

### What was Tried:
- Coordinator broadcasted full cluster snapshots every 3 seconds across WebSocket connections. This was effectively polling over a persistent socket, wasting CPU cycles and network frames when the cluster state was static.

### Decision:
- Switched to an event-driven state machine:
  - WebSocket pushes only fire when real state transitions occur (`node_status_change`: online <-> offline).
  - Lightweight keepalive pings fire every 15 seconds.
  - Client handles reconnects using exponential backoff with randomized jitter and requests a state resync (`{ type: "resync" }`) upon reconnect.

---

## 7. Metrics Exposition: JSON vs. Prometheus Text Format

### Decision:
- Maintained `/api/stats` as JSON for UI dashboard consumption.
- Implemented RFC-standard text exposition format on `/metrics` with standard Prometheus headers:
  - `dfs_node_up{node=...}` (gauge)
  - `dfs_node_latency_seconds{node=...}` (gauge)
  - `dfs_chunk_upload_bytes_total` (counter)
  - `dfs_replication_pending_chunks` (gauge)
  - `dfs_request_duration_seconds` (histogram with p50, p95, p99 buckets)
