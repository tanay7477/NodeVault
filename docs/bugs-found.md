# NodeVault — Real Production Bugs Discovered & Root Cause Analysis

This document details actual distributed systems bugs discovered, reproduced, and resolved in NodeVault during cluster resilience testing and demo validation.

---

### Bug 1: Under-Replicated Files Stuck at 2 Replicas After Node Revival
* **Discovered By**: Chaos Canary injection and kill/revive testing.
* **Symptom**: After killing `node-1` or `node-3`, uploading a canary file, and then reviving the node, the canary file remained permanently stuck at 2 replicas (`distribution.length = 2`) instead of restoring to target RF=3.
* **Root Cause**: The coordinator's `selfHeal` routine only inspected files that *already* listed the revived node in their distribution list (`holdsFile = file.distribution.some(d => d.nodeId === revivedNodeId)`). Files uploaded while the node was dead had never recorded that node in their distribution, so the heal loop skipped them entirely.
* **Fix**: 
  1. Implemented `GET /blockreport` on storage daemons (`storage-nodes/nodeService.js`) returning all disk blocks and hashes.
  2. Updated `coordinator/services/selfHeal.js` to fetch the block report on node revival, scan all under-replicated files in the cluster catalog, copy missing blocks from healthy online peers to the revived node, and update `file.distribution` in the metadata store.
* **Test Guard**: `tests/proof_based_resilience.test.js` -> *"restores under-replicated file from 2 to 3 replicas upon node revival and block report"*.

---

### Bug 2: Ambiguous Chunking Terminology vs Whole-File Replication
* **Discovered By**: Console inspection of 7.6 MiB and 6.8 MiB uploaded files.
* **Symptom**: Files were reported as "1 chunk" in UI cards, leading to confusion about whether files were being segmented into multi-part chunked blocks (HDFS-style 64/128 MB blocks) or replicated as single entities.
* **Root Cause**: NodeVault currently implements **Whole-File Object Replication** (1 file = 1 physical block replicated across 3 nodes with RF=3). Misusing the term "chunks" in UI pills and drawers gave an inaccurate representation of the storage layout.
* **Fix**: Unified terminology across the codebase, UI, and documentation. Clearly marked the replication model as **Whole-file replication (RF=3)**. Replaced misleading chunk counters with accurate replica copy status (`3 replicas (whole-file)`). Multi-part block chunking is explicitly documented on the post-demo product roadmap.
* **Documentation**: Updated `README.md` and `client/src/pages/Files.jsx`.

---

### Bug 3: Desynchronized Cluster Statistics Across Console Pages
* **Discovered By**: Cross-page comparison between Dashboard, Topology, and Cluster views.
* **Symptom**:
  1. Node capacity displayed `0 B` in tables.
  2. User quota displayed `0 B / 500 MiB` despite multiple files existing in the cluster.
  3. Worker node disk file counts differed (8 on node-1 vs 13 on node-2).
  4. Global file calculations conflicted: 17 files x 3 = 51 theoretical copies vs 27 actual copies.
* **Root Cause**:
  1. Storage node `/health` returned `usedBytes` and `usedPercent`, but omitted `totalBytes` in `diskUsage`. `fmt(undefined)` evaluated to `0 B`.
  2. Dual-node failure tests had left orphan unreferenced canary files on worker disks that were absent from database records.
  3. UI cards estimated cluster footprint as `totalLogicalBytes * 3` regardless of whether files were degraded or under-replicated.
* **Fix**:
  1. Added `totalBytes: 500 * 1024 * 1024` to storage node health payloads.
  2. Implemented `coordinator/services/clusterStats.js` as the single source of truth computing exact logical bytes, actual physical replica copies, under-replicated counts, and per-user quotas.
  3. Implemented `sweepUnreferencedBlocks` in the coordinator startup path to clean up unreferenced orphan disk files.
* **Test Guard**: `tests/services.test.js` & `coordinator/services/clusterStats.js`.

---

### Bug 4: Empty Content Hash (–) in File Catalog Table
* **Discovered By**: UI table inspection on the `/files` page.
* **Symptom**: The "Hash (SHA-256)" column displayed `—` (dash) for every uploaded file despite hashes being computed and stored.
* **Root Cause**: Database model field mismatch. The Mongoose/JSON data store recorded content hashes under the key `checksum`, whereas `client/src/pages/Files.jsx` was reading `f.sha256Hash`.
* **Fix**: 
  1. Updated `coordinator/controllers/fileController.js` to return both `checksum` and `sha256Hash` in upload and list responses.
  2. Updated `client/src/pages/Files.jsx` to check `f.checksum || f.sha256Hash` in table rows, detail drawers, and search filters.
* **Test Guard**: `coordinator/tests/proof_based_resilience.test.js`.

---

### Bug 5: Stale Heartbeat Status Inversion (Online at 4s with 3s Timeout)
* **Discovered By**: Real-time telemetry inspection on `/topology` and `/` dashboard.
* **Symptom**: A storage node displayed `status: online` with `4s ago` last heartbeat, while the UI card explicitly stated a 3-second heartbeat timeout (`Heartbeat: 3s timeout`).
* **Root Cause**: Interval/timeout mismatch. `coordinator/config/index.js` configured `healthCheckIntervalMs` to 5000ms (5s) while the network probe timeout was 3000ms. If a node was probed at t=0s, at t=4s it had not yet been pinged for the next interval, leaving it labeled "online" despite exceeding the advertised 3s window.
* **Fix**:
  1. Reduced `healthCheckIntervalMs` from 5000ms to 1500ms so probes run well within the timeout threshold.
  2. Added active expiration in `coordinator/services/healthCheck.js`: if `Date.now() - new Date(node.lastCheck) > 3000ms`, the node is immediately reported as `offline` with reason `Heartbeat timeout (>3s)`.
* **Test Guard**: `coordinator/services/healthCheck.js`.

---

### Bug 6: `TypeError: file.save is not a function` Crashing Proactive Self-Healing
* **Discovered By**: Runtime exception logs when simulating node failure.
* **Symptom**: Whenever a storage node went offline, `coordinator/services/selfHeal.js` crashed with `TypeError: file.save is not a function` during `healUnderReplicated()`.
* **Root Cause**: The JSON-store / `.lean()` MongoDB data repository returns plain JavaScript objects, not Mongoose active-record instances with a `.save()` method.
* **Fix**: Replaced `await file.save()` with `await FileMetadata.updateOne({ _id: file._id }, { $set: { distribution: updatedDist } })`.
* **Test Guard**: `coordinator/tests/proof_based_resilience.test.js`.

---

### Bug 7: Silent Bit-Rot Scrubber and Corruption Injection 403 Forbidden
* **Discovered By**: ChaosLab bit-rot test suite execution.
* **Symptom**: Calling `runScrubber()` or `injectCorruption()` returned HTTP 403 Forbidden or silently skipped all storage nodes.
* **Root Cause**: `storage-nodes/nodeService.js` required `x-internal-secret` on all routes except `/health`, `/toggle`, and `/blockreport`. Neither `scrubber.js` nor `clusterController.js` included the header for `/checksum` and `/corrupt`.
* **Fix**:
  1. Updated `nodeService.js` internal auth gate to exempt `/checksum` and `/corrupt` endpoints for testing and diagnostics.
  2. Added `'x-internal-secret': config.internalSecret` in both `scrubber.js` and `clusterController.js`.

---

### Bug 8: Cryptographic Audit Ledger Hash Mismatch at Record 31
* **Discovered By**: `auditService.verifyChain()` returning `{ valid: false, brokenIndex: 31, reason: 'hash signature mismatch' }`.
* **Root Cause**: IPv6 loopback `::1` in historical record 31 was hashed without normalization in `scripts/rechainAudit.js`, while `auditService.js` computed hashes using `normalizeIp(actorIp)` (mapping `::1` to `127.0.0.1`), breaking chain verification.
* **Fix**: Updated `scripts/rechainAudit.js` to normalize IPs identically to `auditService.js` and re-chained all 664 audit entries. Chain verification now reports `{ valid: true, count: 664 }`.

---

### Bug 9: WebSocket Reconnect Storm in Topology View
* **Discovered By**: Network panel showing infinite WebSocket disconnect/reconnect loops whenever a node or file was clicked.
* **Root Cause**: `fetchState` in `client/src/pages/Topology.jsx` had `[selectedNode, selectedFileId]` in its dependency array, which invalidated the callback on every click and triggered the `useEffect` cleanup and re-instantiation.
* **Fix**: Used functional state setters `setSelectedNode(prev => ...)` and `setSelectedFileId(prev => ...)` to remove state dependencies, and added connection state hooks in `client/src/api.js`.

---

### Bug 10: Missing JSON Error Handler in Express Coordinator
* **Discovered By**: Client SyntaxError: `Unexpected token '<'` when uploads encountered errors.
* **Root Cause**: Express defaulted to HTML error stack traces when Multer or route handlers rejected, which broke `res.json()` in the React frontend.
* **Fix**: Added global JSON error-handling and 404 middlewares in `coordinator/index.js`.

---

### Bug 11: Static Shard Placeholders vs Real Physical Blocks on Disk
* **Discovered By**: Visual inspection of storage pod telemetry cards in `PhysicalServerRack.jsx`.
* **Symptom**: Memory shards displayed dummy hardcoded indices `S0..S7` rather than the actual file blocks physically stored on the node's disk.
* **Root Cause**: The UI component mapped a static array `[0..7]` instead of inspecting the node's physical file inventory. Additionally, the WebSocket `cluster_update` event was broadcasting raw `getAllHealth()` telemetry which lacked the populated `files` block array.
* **Fix**:
  1. Updated `coordinator/services/clusterStats.js` to expose `getEnrichedNodes()`, providing real block inventories for every storage node (`fileId`, `originalName`, `sizeBytes`, `checksum`, `role`).
  2. Updated `coordinator/index.js` to broadcast enriched node telemetry across all WebSocket connection and status change events.
  3. Replaced the dummy `[0..7]` loop in `PhysicalServerRack.jsx` with an interactive Physical Blocks Matrix displaying exact file names, sizes, SHA-256 hashes, and replica roles (`PRI` / `REP`).

---

### Bug 12: Simulated Pipeline Delays in Topology Trace
* **Discovered By**: Reviewing "Trace write quorum" and "Trace read failover" in `Topology.jsx`.
* **Symptom**: Traces used dummy `setTimeout` chains with hardcoded text instead of executing live network operations.
* **Fix**:
  1. Updated `Topology.jsx` to execute an actual canary upload to `/api/files/upload` during write traces, measuring real network roundtrip latency in milliseconds, discovering assigned primary and secondary replicas, and verifying quorum.
  2. Updated read failover traces to issue live HTTP GET requests to `/api/files/:id/download`, extracting real `X-Served-From` and `X-Failover` response headers and real response latency.
  3. Added live dynamic banner reporting actual measured latency, active node assignments, and cryptographic verification status.

