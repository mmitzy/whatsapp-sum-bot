// bot/mediaStore.js
//
// Local, photo-only media storage (storage-agnostic design via URI refs)
// - Stores bytes on disk under: <DATA_DIR>/media/images/YYYY/MM/<sha256>.<ext>
// - Returns stable media_ref: local://images/YYYY/MM/<sha256>.<ext>
// - Enforces allowlist + size cap
// - Atomic write + dedupe by sha256
//
// Later you can swap to R2 by implementing the same exported function signature.

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const config = require('./config');

const DATA_DIR = config.DATA_DIR;

// ---- Config defaults (override via env if you want) ----
const MEDIA_DIRNAME = config.MEDIA_DIRNAME;
const MAX_IMAGE_BYTES = config.MAX_IMAGE_BYTES;
const ALLOWED_MIME = config.ALLOWED_MIME;
const EXT_BY_MIME = config.EXT_BY_MIME;

function mediaBaseDir() {
  return path.join(DATA_DIR, MEDIA_DIRNAME);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensureWithin(baseDir, targetPath) {
  const rel = path.relative(baseDir, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path traversal blocked');
  }
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * putImageIfAllowed
 * @param {Object} params
 * @param {Buffer} params.bytes
 * @param {string} params.mime
 * @param {number} params.ts - unix seconds (message timestamp)
 * @param {string} params.chatId - used only for future partitioning; not currently in path
 * @returns {Promise<{ref:string, sha256:string, size:number, mime:string}>}
 */
async function putImageIfAllowed({ bytes, mime, ts, chatId }) { // chatId reserved
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error(`Unsupported image mime: ${mime}`);
  }
  if (!Buffer.isBuffer(bytes)) throw new Error('bytes must be Buffer');
  if (bytes.length === 0) throw new Error('empty image');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${bytes.length} > ${MAX_IMAGE_BYTES}`);
  }

  const sha = sha256Hex(bytes);
  const ext = EXT_BY_MIME[mime] || 'bin';

  const d = new Date((ts || Math.floor(Date.now() / 1000)) * 1000);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');

  const relDir = path.join('images', yyyy, mm);
  const relName = `${sha}.${ext}`;
  const relPath = path.join(relDir, relName);

  const baseDir = mediaBaseDir();
  const absDir = path.join(baseDir, relDir);
  const absPath = path.join(baseDir, relPath);

  ensureWithin(baseDir, absPath);

  await fs.mkdir(absDir, { recursive: true });

  // Dedupe: if already exists, just return ref
  if (await fileExists(absPath)) {
    return {
      ref: `local://${relPath.replace(/\\/g, '/')}`,
      sha256: sha,
      size: bytes.length,
      mime
    };
  }

  // Atomic write
  const tmpPath = absPath + `.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, bytes, { flag: 'wx' });
  await fs.rename(tmpPath, absPath);

  return {
    ref: `local://${relPath.replace(/\\/g, '/')}`,
    sha256: sha,
    size: bytes.length,
    mime
  };
}

/**
 * Delete a local:// ref from disk (used by cleanup)
 */
async function deleteLocalRef(ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('local://')) {
    throw new Error('deleteLocalRef expects local:// ref');
  }
  const rel = ref.replace(/^local:\/\//, ''); // images/YYYY/MM/...
  const baseDir = mediaBaseDir();
  const abs = path.join(baseDir, rel);
  ensureWithin(baseDir, abs);
  await fs.unlink(abs);
}

/**
 * Resolve a local:// ref into an absolute path (useful for debugging)
 */
function resolveLocalRef(ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('local://')) return null;
  const rel = ref.replace(/^local:\/\//, '');
  const baseDir = mediaBaseDir();
  const abs = path.join(baseDir, rel);
  ensureWithin(baseDir, abs);
  return abs;
}

module.exports = {
  putImageIfAllowed,
  deleteLocalRef,
  resolveLocalRef,
  mediaBaseDir,
  MAX_IMAGE_BYTES,
  ALLOWED_MIME
};
