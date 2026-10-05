#!/usr/bin/env node
/**
 * Phase D — Import RDS auth.users into Cognito (prod pool) and backfill cognito_sub.
 *
 * Supabase password hashes cannot be imported. Users get Cognito accounts with a random
 * permanent password (unknown); they set a real one via Forgot password after cutover (Phase F).
 * AdminCreateUser alone leaves FORCE_CHANGE_PASSWORD — ForgotPassword codes are not delivered.
 *
 * Usage (from repo root, local Mac with tunnel):
 *   npm run db:tunnel                                    # terminal 1
 *   npm run import:cognito-users                         # dry-run (default)
 *   npm run import:cognito-users -- --apply --confirm-prod
 *   npm run import:cognito-users -- --apply --confirm-prod --csv path/to/users.csv
 *
 * Required in .env.local:
 *   AWS_ACTIONS_ACCESS_KEY_ID / AWS_ACTIONS_SECRET_ACCESS_KEY
 *   COGNITO_USER_POOL_ID          (prod pool for Phase D)
 *   COGNITO_CLIENT_ID
 *   DATABASE_URL_LOCAL            (local tunnel) or DATABASE_URL on EC2
 *
 * Data source (pick one):
 *   --from-rds   (default) SELECT id, email FROM auth.users WHERE cognito_sub IS NULL
 *   --csv FILE   CSV with header: id,email
 *
 * Safety:
 *   Dry-run by default — lists actions only.
 *   --apply --confirm-prod required to mutate prod pool + RDS.
 *   Refuses --apply against the known dev pool unless --allow-dev-pool.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { generateCognitoCompliantPassword } from './cognitoPasswordUtils.mjs';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getAwsSdkBaseClientConfig } from '../../src/utils/awsSdkBaseClientConfig.js';
import { getResolvedPostgresHost } from '../../src/utils/postgresConnection.js';
import {
  closeSupabasePostgresPool,
  getSupabasePostgresPool,
  querySupabasePostgres,
} from '../../src/utils/supabasePostgresPool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

/** @type {readonly string[]} */
const KNOWN_DEV_POOL_IDS = [
  'us-east-1_8zgtpuUJg', // source account
  'us-east-1_oyTwIkORs', // handover / target account
];
/** @type {readonly string[]} */
const KNOWN_PROD_POOL_IDS = [
  'us-east-1_UxICChcfK', // source account
  'us-east-1_tUgu3Wiat', // handover / target account
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @typedef {{ id: string, email: string, cognitoSub?: string | null }} ImportUser
 * @typedef {{ apply: boolean, confirmProd: boolean, allowDevPool: boolean, fromRds: boolean, csvPath: string | null, includeLinked: boolean }} CliFlags
 */

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env.local`);
  }
  return value;
}

function printUsage() {
  console.log(`Phase D — Cognito user import + cognito_sub backfill

Usage:
  npm run import:cognito-users [-- options]

Options:
  --from-rds              Load users from RDS (default; rows with cognito_sub IS NULL)
  --csv <file>            Load id,email from CSV instead of RDS
  --include-linked        Also process rows that already have cognito_sub (verify/link only)
  --apply                 Create Cognito users + UPDATE auth.users (default: dry-run)
  --confirm-prod          Required with --apply when COGNITO_USER_POOL_ID is a known prod pool
  --allow-dev-pool        Allow --apply against the known dev pool (testing only)

Examples:
  npm run db:tunnel
  npm run import:cognito-users
  npm run import:cognito-users -- --apply --confirm-prod
  npm run import:cognito-users -- --apply --confirm-prod --csv ./prod-users.csv

Env: AWS_ACTIONS_*, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, DATABASE_URL_LOCAL (tunnel) or DATABASE_URL.`);
}

/**
 * @param {string[]} argv
 * @returns {CliFlags}
 */
function parseArgs(argv) {
  /** @type {CliFlags} */
  const flags = {
    apply: false,
    confirmProd: false,
    allowDevPool: false,
    fromRds: true,
    csvPath: null,
    includeLinked: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--apply') {
      flags.apply = true;
      continue;
    }
    if (arg === '--confirm-prod') {
      flags.confirmProd = true;
      continue;
    }
    if (arg === '--allow-dev-pool') {
      flags.allowDevPool = true;
      continue;
    }
    if (arg === '--from-rds') {
      flags.fromRds = true;
      flags.csvPath = null;
      continue;
    }
    if (arg === '--include-linked') {
      flags.includeLinked = true;
      continue;
    }
    if (arg === '--csv') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('--csv requires a file path');
      }
      flags.fromRds = false;
      flags.csvPath = path.resolve(process.cwd(), next);
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return flags;
}

/**
 * @param {import('@aws-sdk/client-cognito-identity-provider').AttributeType[] | undefined} attributes
 * @returns {string | null}
 */
function subFromAttributes(attributes) {
  const sub = attributes?.find((a) => a.Name === 'sub')?.Value?.trim();
  return sub || null;
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * @param {string} filePath
 * @returns {ImportUser[]}
 */
function loadUsersFromCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) {
    throw new Error(`CSV is empty: ${filePath}`);
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idIdx = header.indexOf('id');
  const emailIdx = header.indexOf('email');
  if (idIdx === -1 || emailIdx === -1) {
    throw new Error('CSV header must include id,email');
  }

  /** @type {ImportUser[]} */
  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const id = cols[idIdx]?.trim();
    const email = cols[emailIdx]?.trim();
    if (!id || !email) {
      throw new Error(`Invalid row ${i + 1}: expected id and email`);
    }
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid UUID on row ${i + 1}: ${id}`);
    }
    users.push({ id, email });
  }
  return users;
}

/**
 * @param {boolean} includeLinked
 * @returns {Promise<ImportUser[]>}
 */
async function loadUsersFromRds(includeLinked) {
  const sql = includeLinked
    ? `SELECT id::text AS id, email, cognito_sub
       FROM auth.users
       ORDER BY lower(email)`
    : `SELECT id::text AS id, email, cognito_sub
       FROM auth.users
       WHERE cognito_sub IS NULL
       ORDER BY lower(email)`;
  const result = await querySupabasePostgres(sql);
  return result.rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    cognitoSub: row.cognito_sub ? String(row.cognito_sub) : null,
  }));
}

/**
 * FORCE_CHANGE_PASSWORD blocks ForgotPassword email delivery. Set unknown permanent password → CONFIRMED.
 *
 * @param {CognitoIdentityProviderClient} cognito
 * @param {string} poolId
 * @param {string} username
 */
async function ensureUserConfirmedForForgotPassword(cognito, poolId, username) {
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: username,
      Password: generateCognitoCompliantPassword(),
      Permanent: true,
    })
  );
}

/**
 * @param {CognitoIdentityProviderClient} cognito
 * @param {string} poolId
 * @param {string} email
 * @returns {Promise<{ cognitoSub: string, created: boolean, confirmed: boolean }>}
 */
async function ensureCognitoUser(cognito, poolId, email) {
  try {
    const out = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
      })
    );
    const cognitoSub = subFromAttributes(out.User?.Attributes);
    if (!cognitoSub) {
      throw new Error('AdminCreateUser succeeded but no sub in response');
    }
    await ensureUserConfirmedForForgotPassword(cognito, poolId, email);
    return { cognitoSub, created: true, confirmed: true };
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    if (name !== 'UsernameExistsException') {
      throw err;
    }
    const existing = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: poolId,
        Username: email,
      })
    );
    const cognitoSub = subFromAttributes(existing.UserAttributes);
    if (!cognitoSub) {
      throw new Error(`Cognito user exists for ${email} but sub not found`);
    }
    let confirmed = existing.UserStatus === 'CONFIRMED';
    if (!confirmed && existing.UserStatus === 'FORCE_CHANGE_PASSWORD') {
      await ensureUserConfirmedForForgotPassword(cognito, poolId, email);
      confirmed = true;
    }
    return { cognitoSub, created: false, confirmed };
  }
}

/**
 * @param {string} userId
 * @param {string} email
 * @param {string} cognitoSub
 * @returns {Promise<void>}
 */
async function updateAuthUserCognitoSub(userId, email, cognitoSub) {
  await querySupabasePostgres(
    `UPDATE auth.users
     SET cognito_sub = $1,
         email = $2
     WHERE id = $3::uuid
       AND (cognito_sub IS NULL OR cognito_sub = $1)`,
    [cognitoSub, email, userId]
  );
}

/**
 * @param {string} poolId
 * @param {CliFlags} flags
 */
function assertApplySafety(poolId, flags) {
  if (!flags.apply) {
    return;
  }

  const isDevPool = KNOWN_DEV_POOL_IDS.includes(poolId);
  const isProdPool = KNOWN_PROD_POOL_IDS.includes(poolId);

  if (isDevPool && !flags.allowDevPool) {
    throw new Error(
      `Refusing --apply against dev pool ${poolId}. Use dev pool only for testing with --allow-dev-pool.`
    );
  }

  if (isProdPool && !flags.confirmProd) {
    throw new Error(
      `Prod pool ${poolId} requires --confirm-prod with --apply.`
    );
  }

  if (!isDevPool && !isProdPool) {
    throw new Error(
      `Unknown pool ${poolId}. Set COGNITO_USER_POOL_ID to a known dev/prod pool or extend KNOWN_* in the script.`
    );
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const poolId = requireEnv('COGNITO_USER_POOL_ID');
  requireEnv('COGNITO_CLIENT_ID');
  assertApplySafety(poolId, flags);

  const sdkConfig = getAwsSdkBaseClientConfig('Cognito user import');
  const sts = new STSClient(sdkConfig);
  const cognito = new CognitoIdentityProviderClient(sdkConfig);

  const identity = await sts.send(new GetCallerIdentityCommand({}));
  console.log('Cognito user import (Phase D)');
  console.log(`  mode:     ${flags.apply ? 'APPLY' : 'dry-run'}`);
  console.log(`  IAM:      ${identity.Arn ?? '(unknown)'}`);
  console.log(`  pool:     ${poolId}`);
  console.log(`  source:   ${flags.fromRds ? 'RDS auth.users' : flags.csvPath}`);
  console.log('');

  /** @type {ImportUser[]} */
  let users;
  if (flags.fromRds) {
    getSupabasePostgresPool();
    const host = getResolvedPostgresHost();
    console.log(`  RDS host: ${host ?? '(unknown)'}`);
    users = await loadUsersFromRds(flags.includeLinked);
  } else {
    users = loadUsersFromCsv(flags.csvPath);
  }

  if (users.length === 0) {
    console.log('No users to import (all rows may already have cognito_sub).');
    console.log('Use --include-linked to re-check linked users.');
    return;
  }

  console.log(`Found ${users.length} user(s) to process.\n`);

  let created = 0;
  let existing = 0;
  let linked = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of users) {
    const label = `${user.email} (${user.id.slice(0, 8)}…)`;
    try {
      if (user.cognitoSub && !flags.includeLinked) {
        console.log(`  skip  ${label} — cognito_sub already set`);
        skipped++;
        continue;
      }

      if (!flags.apply) {
        console.log(
          `  plan  ${label} — AdminCreateUser (or reuse) + AdminSetUserPassword (Permanent) + UPDATE cognito_sub`
        );
        continue;
      }

      const { cognitoSub, created: wasCreated } = await ensureCognitoUser(
        cognito,
        poolId,
        user.email
      );

      if (user.cognitoSub && user.cognitoSub !== cognitoSub) {
        throw new Error(
          `RDS cognito_sub mismatch: db=${user.cognitoSub} cognito=${cognitoSub}`
        );
      }

      await updateAuthUserCognitoSub(user.id, user.email, cognitoSub);

      if (wasCreated) {
        console.log(`  ok    ${label} — created, sub ${cognitoSub.slice(0, 8)}…`);
        created++;
      } else {
        console.log(`  ok    ${label} — existing Cognito user, linked sub ${cognitoSub.slice(0, 8)}…`);
        existing++;
      }
      linked++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  fail  ${label} — ${msg}`);
    }
  }

  console.log('');
  if (!flags.apply) {
    console.log('Dry-run complete. Re-run with --apply --confirm-prod to execute.');
    return;
  }

  const verify = await querySupabasePostgres(
    `SELECT
       count(*)::int AS total,
       count(cognito_sub)::int AS with_sub,
       count(*) FILTER (WHERE cognito_sub IS NULL)::int AS missing_sub
     FROM auth.users`
  );
  const row = verify.rows[0];
  console.log('Summary:');
  console.log(`  Cognito created:     ${created}`);
  console.log(`  Cognito existing:    ${existing}`);
  console.log(`  RDS linked:          ${linked}`);
  console.log(`  Skipped:             ${skipped}`);
  console.log(`  Failed:              ${failed}`);
  console.log(`  auth.users total:    ${row?.total ?? '?'}`);
  console.log(`  with cognito_sub:    ${row?.with_sub ?? '?'}`);
  console.log(`  missing cognito_sub: ${row?.missing_sub ?? '?'}`);

  if (failed > 0) {
    process.exitCode = 1;
  } else if (Number(row?.missing_sub) > 0) {
    console.warn('\nWarning: some auth.users rows still lack cognito_sub.');
    process.exitCode = 1;
  } else {
    console.log('\nPhase D import complete. Next: Phase E (FE reset), then Phase F cutover.');
  }
}

main()
  .catch((err) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await closeSupabasePostgresPool();
  });
