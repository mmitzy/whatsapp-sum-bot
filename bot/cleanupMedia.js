// bot/cleanupMedia.js
//
// Simple retention cleanup for local media.
// Strategy (v1):
// - Delete media_objects rows older than RETENTION_DAYS (by created_ts)
// - Only handles storage='local' and ref starting with local://
// - For each deleted file:
//     - remove file from disk
//     - mark media_objects.status='deleted' and clear ref OR keep ref but status deleted
//
// You can run this:
//   node bot/cleanupMedia.js
//
// Or call runCleanup() from your bot startup and/or daily interval.

const path = require('path');
const fs = require('fs/promises');
const sqlite3 = require('sqlite3').verbose();

const config = require('./config');
const { deleteLocalRef, mediaBaseDir } = require('./mediaStore');

// ---- Config defaults ----
const DATA_DIR = config.DATA_DIR;
const DB_FILE = process.env.DB_FILE || 'bot.sqlite';

const RETENTION_DAYS = parseInt(process.env.MEDIA_RETENTION_DAYS || '', 10) || 30;
const DRY_RUN = (process.env.MEDIA_CLEANUP_DRY_RUN || '').toLowerCase() === 'true';

// If true, keep ref for audit even after deletion (status=deleted).
// If false, clear ref to avoid dangling pointers.
const KEEP_REF_AFTER_DELETE = (process.env.MEDIA_KEEP_REF_AFTER_DELETE || '').toLowerCase() === 'true';

function dbPath() {
  return path.join(DATA_DIR, DB_FILE);
}

function getDb() {
  return new sqlite3.Database(dbPath());
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function cutoffTs(days) {
  return nowTs() - days * 86400;
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes || 0 });
    });
  });
}

async function ensureMediaObjectsTable(db) {
  // If someone runs cleanup before schema upgrade, fail gracefully.
  const rows = await dbAll(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='media_objects'`);
  return rows.length > 0;
}

async function runCleanup({ retentionDays = RETENTION_DAYS } = {}) {
  const db = getDb();
  const cutoff = cutoffTs(retentionDays);

  try {
    const ok = await ensureMediaObjectsTable(db);
    if (!ok) {
      console.log('cleanupMedia: media_objects table not found. Did you apply schema upgrade?');
      return { ok: false, reason: 'no_media_objects' };
    }

    // Pick candidates. Only stored local items older than cutoff.
    const candidates = await dbAll(
      db,
      `
      SELECT media_id, ref, storage, created_ts, status
      FROM media_objects
      WHERE storage='local'
        AND status='stored'
        AND created_ts < ?
      ORDER BY created_ts ASC
      LIMIT 500
      `,
      [cutoff]
    );

    if (!candidates.length) {
      console.log(`cleanupMedia: nothing to delete (retentionDays=${retentionDays})`);
      return { ok: true, deleted: 0, scanned: 0 };
    }

    console.log(`cleanupMedia: found ${candidates.length} candidates older than ${retentionDays} days`);
    console.log(`media dir: ${mediaBaseDir()}`);
    if (DRY_RUN) console.log('cleanupMedia: DRY_RUN=true, no deletions will occur');

    let deleted = 0;
    let missing = 0;
    let failed = 0;

    for (const c of candidates) {
      const ref = c.ref || '';
      if (!ref.startsWith('local://')) continue;

      try {
        if (!DRY_RUN) {
          // delete file (if missing, treat as missing but still mark deleted)
          try {
            await deleteLocalRef(ref);
            deleted++;
          } catch (e) {
            // likely already missing
            missing++;
          }

          // Mark DB row
          if (KEEP_REF_AFTER_DELETE) {
            await dbRun(db, `UPDATE media_objects SET status='deleted' WHERE media_id=?`, [c.media_id]);
          } else {
            await dbRun(db, `UPDATE media_objects SET status='deleted', ref='' WHERE media_id=?`, [c.media_id]);
          }
        } else {
          console.log(`[DRY] would delete media_id=${c.media_id} ref=${ref}`);
        }
      } catch (e) {
        failed++;
        console.error(`cleanupMedia: failed media_id=${c.media_id}`, e);
      }
    }

    console.log(`cleanupMedia: done. deleted=${deleted}, missing=${missing}, failed=${failed}`);
    return { ok: true, scanned: candidates.length, deleted, missing, failed };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  runCleanup().catch((e) => {
    console.error('cleanupMedia: fatal', e);
    process.exitCode = 1;
  });
}

module.exports = { runCleanup };
