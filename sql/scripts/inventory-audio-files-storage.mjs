#!/usr/bin/env node
/**
 * List every object in Supabase Storage bucket `audio-files` (metadata only — no downloads),
 * join to `recordings.recording_file_path`, and write durable reports for missing-file analysis.
 *
 * Mirrors sql/scripts/move-legacy-encounter-archive-s3-prefix.mjs style: dotenv, path, self-contained run.
 *
 * Usage (from repo root):
 *   node sql/scripts/inventory-audio-files-storage.mjs
 *   node sql/scripts/inventory-audio-files-storage.mjs --prefix=<user-uuid-or-subpath>
 *   node sql/scripts/inventory-audio-files-storage.mjs --cap=10
 *
 * Storage rows are sorted by `created_at` ascending (oldest first; missing dates sort first),
 * then by `storage_path`. `--cap` limits how many lines are written to `inventory-*-storage.jsonl` only
 * (full bucket is still listed; orphan JSONL still uses the full storage path set).
 *
 * Requires in .env.local: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Writes under sql/scripts/reports/audio-files-inventory/ (gitignored):
 *   - inventory-<timestamp>-summary.json
 *   - inventory-<timestamp>-storage.jsonl   (one object per line)
 *   - inventory-<timestamp>-storage-full.csv  (every storage object, all columns; sorted by path for investigation)
 *   - inventory-<timestamp>-db-path-not-in-storage.jsonl  (recording rows whose path has no object)
 *
 * Summary `stats` has three groups (console prints the same labels):
 *   1. recordings — DB rows with path; how many paths miss an object vs have one; duplicate paths
 *   2. storage — every listed object; attached (path referenced by ≥1 recording) vs unattached
 *   3. export — cap + how many lines written to storage JSONL (cap does not change groups 1–2)
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const BUCKET = 'audio-files';
const LIST_LIMIT = 1000;

/** Optional: limit recursive listing to this prefix (e.g. a user UUID folder). Empty = whole bucket. */
let PATH_PREFIX = '';

/** Max lines in *-storage.jsonl; `null` = all rows after sort. */
let CAP = null;

// --- parse argv -----------------------------------------------------------
const argv = process.argv.slice(2);
for (const a of argv) {
  if (a.startsWith('--prefix=')) {
    PATH_PREFIX = a.slice('--prefix='.length).trim().replace(/^\/+|\/+$/g, '');
  } else if (a.startsWith('--cap=')) {
    const v = a.slice('--cap='.length).trim();
    if (v === '' || /^null$/i.test(v)) {
      CAP = null;
    } else {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error('Invalid --cap: use a positive integer (e.g. --cap=10) or omit for no limit.');
        process.exit(1);
      }
      CAP = n;
    }
  } else if (a === '--help' || a === '-h') {
    console.log(
      `Usage: node sql/scripts/inventory-audio-files-storage.mjs [--prefix=sub/path] [--cap=N]\n` +
        `  --cap   optional; omit or --cap=null for no limit (default). Example: --cap=10`
    );
    process.exit(0);
  }
}

const REPORTS_DIR = path.join(__dirname, 'reports', 'audio-files-inventory');

function assertEnv() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }
}

/**
 * Bucket-relative path as used in recordings (strip optional `audio-files/` and leading slash).
 * @param {string | null | undefined} p
 */
function normalizeRecordingPath(p) {
  if (p == null || typeof p !== 'string') return '';
  let x = p.trim();
  if (x.startsWith('audio-files/')) x = x.replace(/^audio-files\//, '');
  if (x.startsWith('/')) x = x.slice(1);
  return x;
}

/**
 * Recursively list all file objects under `dirPrefix` (empty string = bucket root).
 * Folders are entries with `id == null` per Supabase Storage list API.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} dirPrefix
 * @returns {Promise<{ path: string, created_at: string | null, updated_at: string | null, size: number | null }[]>}
 */
async function listFilesRecursive(supabase, dirPrefix) {
  /** @type {{ path: string, created_at: string | null, updated_at: string | null, size: number | null }[]} */
  const out = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage.from(BUCKET).list(dirPrefix, {
      limit: LIST_LIMIT,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });

    if (error) {
      throw new Error(`storage.list(${JSON.stringify(dirPrefix)}): ${error.message}`);
    }
    if (!data?.length) break;

    for (const item of data) {
      const rel = dirPrefix ? `${dirPrefix}/${item.name}` : item.name;
      const isFolder = item.id == null;
      if (isFolder) {
        const nested = await listFilesRecursive(supabase, rel);
        out.push(...nested);
      } else {
        out.push({
          path: rel,
          created_at: item.created_at ?? null,
          updated_at: item.updated_at ?? null,
          size: item.metadata?.size != null ? Number(item.metadata.size) : null,
        });
      }
    }

    if (data.length < LIST_LIMIT) break;
    offset += LIST_LIMIT;
  }

  return out;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function fetchAllRecordingsWithPaths(supabase) {
  /** @type {{ id: number, user_id: string, patientEncounter_id: number | null, recording_file_path: string }[]} */
  const rows = [];
  const page = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('recordings')
      .select('id, user_id, patientEncounter_id, recording_file_path')
      .not('recording_file_path', 'is', null)
      .range(from, from + page - 1);

    if (error) {
      throw new Error(`recordings fetch: ${error.message}`);
    }
    if (!data?.length) break;
    for (const r of data) {
      rows.push({
        id: r.id,
        user_id: r.user_id,
        patientEncounter_id: r.patientEncounter_id ?? null,
        recording_file_path: r.recording_file_path,
      });
    }
    if (data.length < page) break;
    from += page;
  }

  return rows;
}

/**
 * @param {{ id: number, user_id: string, patientEncounter_id: number | null, recording_file_path: string }[]} rows
 * @returns {Map<string, { id: number, user_id: string, patientEncounter_id: number | null, recording_file_path: string }[]>}
 */
function buildPathIndex(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = normalizeRecordingPath(r.recording_file_path);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: r.id,
      user_id: r.user_id,
      patientEncounter_id: r.patientEncounter_id,
      recording_file_path: r.recording_file_path,
    });
  }
  return map;
}

/**
 * Filename pattern like `user@host-1761658486974-34.m4a` → embedded millis between hyphens.
 * @param {string} pathStr bucket-relative path or basename
 * @returns {{ epochMs: number | null, isoUtc: string }}
 */
function embeddedEpochFromPath(pathStr) {
  const leaf = pathStr.split('/').pop() || pathStr;
  const m = String(leaf).match(/-(\d{10,13})-/);
  if (!m) return { epochMs: null, isoUtc: '' };
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return { epochMs: null, isoUtc: '' };
  const ms = m[1].length === 10 ? n * 1000 : n;
  const d = new Date(ms);
  const iso = Number.isNaN(d.getTime()) ? '' : d.toISOString();
  return { epochMs: ms, isoUtc: iso };
}

/**
 * @param {unknown} val
 */
function escapeCsvField(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {string} outPath
 * @param {string[]} headers
 * @param {Record<string, unknown>[]} rows
 */
function writeCsv(outPath, headers, rows) {
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvField(row[h])).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Sort key: created_at first, then updated_at (ascending = oldest first). */
function createdSortKeyMs(obj) {
  const t = obj.created_at || obj.updated_at;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Oldest `created_at` first; tie-break `storage_path`.
 * @param {{ path: string, created_at: string | null, updated_at: string | null, size: number | null }[]} files
 */
function sortStorageFilesByCreatedAsc(files) {
  return [...files].sort((a, b) => {
    const d = createdSortKeyMs(a) - createdSortKeyMs(b);
    if (d !== 0) return d;
    return a.path.localeCompare(b.path);
  });
}

async function main() {
  assertEnv();

  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  console.log(`Bucket: ${BUCKET}`);
  console.log(`Prefix: ${PATH_PREFIX || '(root — full bucket)'}`);
  console.log(`Cap (storage JSONL rows): ${CAP == null ? 'none' : CAP}`);
  console.log('Fetching recordings with recording_file_path…');

  const recordingRows = await fetchAllRecordingsWithPaths(supabase);
  const pathIndex = buildPathIndex(recordingRows);

  console.log(`Listing storage objects (metadata only, recursive)…`);

  const storageFilesAll = await listFilesRecursive(supabase, PATH_PREFIX);
  const storageSorted = sortStorageFilesByCreatedAsc(storageFilesAll);
  const storageFilesReport =
    CAP != null ? storageSorted.slice(0, CAP) : storageSorted;

  const storagePathSet = new Set(storageFilesAll.map((f) => normalizeRecordingPath(f.path)));

  /** Full-bucket counts (not affected by --cap). */
  let storageAttachedFull = 0;
  let storageUnattachedFull = 0;
  for (const obj of storageSorted) {
    const norm = normalizeRecordingPath(obj.path);
    const refs = pathIndex.get(norm);
    if (refs?.length) storageAttachedFull++;
    else storageUnattachedFull++;
  }

  let recordingRowsPathFoundInStorage = 0;
  for (const r of recordingRows) {
    const norm = normalizeRecordingPath(r.recording_file_path);
    if (norm && storagePathSet.has(norm)) recordingRowsPathFoundInStorage++;
  }

  const ts = safeTimestamp();
  const base = path.join(REPORTS_DIR, `inventory-${ts}`);
  const summaryPath = `${base}-summary.json`;
  const storageJsonlPath = `${base}-storage.jsonl`;
  const orphansPath = `${base}-db-path-not-in-storage.jsonl`;

  const storageStream = fs.createWriteStream(storageJsonlPath, { encoding: 'utf8' });

  for (const obj of storageFilesReport) {
    const norm = normalizeRecordingPath(obj.path);
    const refs = pathIndex.get(norm);
    const attached = Boolean(refs?.length);

    const primary = refs?.[0];
    const line = JSON.stringify({
      storage_path: obj.path,
      attached,
      db_ref_count: refs?.length ?? 0,
      recording_id: primary?.id ?? null,
      patientEncounter_id: primary?.patientEncounter_id ?? null,
      user_id: primary?.user_id ?? null,
      storage_created_at: obj.created_at,
      storage_updated_at: obj.updated_at,
      size_bytes: obj.size,
    });
    storageStream.write(line + '\n');
  }
  await new Promise((resolve, reject) => {
    storageStream.end((err) => (err ? reject(err) : resolve()));
  });

  let dbMissingStorage = 0;
  const orphanStream = fs.createWriteStream(orphansPath, { encoding: 'utf8' });

  for (const r of recordingRows) {
    const norm = normalizeRecordingPath(r.recording_file_path);
    if (!norm) continue;
    if (storagePathSet.has(norm)) continue;
    dbMissingStorage++;
    orphanStream.write(
      JSON.stringify({
        recording_id: r.id,
        user_id: r.user_id,
        patientEncounter_id: r.patientEncounter_id,
        recording_file_path: r.recording_file_path,
        normalized_path: norm,
      }) + '\n'
    );
  }
  await new Promise((resolve, reject) => {
    orphanStream.end((err) => (err ? reject(err) : resolve()));
  });

  const CSV_HEADERS = [
    'sort_path',
    'recording_file_path',
    'storage_path',
    'normalized_path',
    'attached',
    'db_ref_count',
    'recording_id_primary',
    'recording_ids_all',
    'patientEncounter_id',
    'user_id',
    'path_embedded_epoch_ms',
    'path_embedded_iso_utc',
    'storage_created_at',
    'storage_updated_at',
    'size_bytes',
  ];

  /** Full bucket; sorted by `sort_path` (DB path when attached, else storage path) for timeline / misplaced-path checks. */
  /** @type {Record<string, string|number|boolean>[]} */
  const csvRows = [];
  for (const obj of storageSorted) {
    const norm = normalizeRecordingPath(obj.path);
    const refs = pathIndex.get(norm);
    const attached = Boolean(refs?.length);
    const primary = refs?.[0];
    const recordingPathDb =
      attached && primary?.recording_file_path ? String(primary.recording_file_path) : '';
    const sortPath = recordingPathDb || obj.path;
    const { epochMs, isoUtc } = embeddedEpochFromPath(recordingPathDb || obj.path);
    const idsAll = refs?.map((x) => x.id).join(';') ?? '';

    csvRows.push({
      sort_path: sortPath,
      recording_file_path: recordingPathDb,
      storage_path: obj.path,
      normalized_path: norm,
      attached,
      db_ref_count: refs?.length ?? 0,
      recording_id_primary: primary?.id ?? '',
      recording_ids_all: idsAll,
      patientEncounter_id: primary?.patientEncounter_id ?? '',
      user_id: primary?.user_id ?? '',
      path_embedded_epoch_ms: epochMs ?? '',
      path_embedded_iso_utc: isoUtc,
      storage_created_at: obj.created_at ?? '',
      storage_updated_at: obj.updated_at ?? '',
      size_bytes: obj.size ?? '',
    });
  }

  csvRows.sort((a, b) =>
    String(a.sort_path).localeCompare(String(b.sort_path), undefined, { numeric: true, sensitivity: 'base' })
  );

  const csvPath = `${base}-storage-full.csv`;
  writeCsv(csvPath, CSV_HEADERS, csvRows);

  /** Paths referenced by more than one recording row (data quality signal). */
  let duplicateDbPathKeys = 0;
  for (const [, refs] of pathIndex) {
    if (refs.length > 1) duplicateDbPathKeys++;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    bucket: BUCKET,
    listPrefix: PATH_PREFIX || null,
    sort: 'storage_created_at_asc',
    stats: {
      recordings: {
        rowsWithNonNullPath: recordingRows.length,
        pathMissingFileInStorage: dbMissingStorage,
        pathHasFileInStorage: recordingRowsPathFoundInStorage,
        duplicateNormalizedPathsInDb: duplicateDbPathKeys,
      },
      storage: {
        objectCount: storageFilesAll.length,
        attachedReferencedByRecording: storageAttachedFull,
        unattachedNotInDbPaths: storageUnattachedFull,
      },
      export: {
        cap: CAP,
        storageJsonlRowsWritten: storageFilesReport.length,
      },
    },
    outputFiles: {
      summary: path.relative(process.cwd(), summaryPath),
      storageJsonl: path.relative(process.cwd(), storageJsonlPath),
      storageFullCsv: path.relative(process.cwd(), csvPath),
      dbPathNotInStorageJsonl: path.relative(process.cwd(), orphansPath),
    },
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n--- 1) Recordings (DB table, recording_file_path) ---');
  console.log(JSON.stringify(summary.stats.recordings, null, 2));
  console.log('\n--- 2) Storage (bucket objects: attached vs unattached) ---');
  console.log(JSON.stringify(summary.stats.storage, null, 2));
  console.log('\n--- 3) Export (storage JSONL only) ---');
  console.log(JSON.stringify(summary.stats.export, null, 2));
  console.log('\nWrote:');
  console.log(' ', summaryPath);
  console.log(' ', storageJsonlPath);
  console.log(' ', csvPath, '(all storage objects; sorted by sort_path)');
  console.log(' ', orphansPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
