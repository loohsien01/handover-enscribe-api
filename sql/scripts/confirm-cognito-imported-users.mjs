#!/usr/bin/env node
/**
 * Phase D follow-up — move AdminCreateUser imports from FORCE_CHANGE_PASSWORD → CONFIRMED.
 *
 * AdminCreateUser (no temp password emailed) leaves users in FORCE_CHANGE_PASSWORD.
 * Cognito ForgotPassword does not deliver reset codes for that status (API may still return 200).
 *
 * Sets a random permanent password (unknown to anyone) so users can use Forgot password at cutover.
 *
 * Usage:
 *   npm run cognito:confirm-imported-users                         # dry-run
 *   npm run cognito:confirm-imported-users -- --apply --confirm-prod
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { generateCognitoCompliantPassword } from './cognitoPasswordUtils.mjs';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getAwsSdkBaseClientConfig } from '../../src/utils/awsSdkBaseClientConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

/** @type {readonly string[]} */
const KNOWN_DEV_POOL_IDS = ['us-east-1_8zgtpuUJg'];
/** @type {readonly string[]} */
const KNOWN_PROD_POOL_IDS = ['us-east-1_UxICChcfK'];

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env.local`);
  }
  return value;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    confirmProd: argv.includes('--confirm-prod'),
    allowDevPool: argv.includes('--allow-dev-pool'),
  };
}

/**
 * @param {string} poolId
 * @param {{ apply: boolean, confirmProd: boolean, allowDevPool: boolean }} flags
 */
function assertApplySafety(poolId, flags) {
  if (!flags.apply) {
    return;
  }
  const isDevPool = KNOWN_DEV_POOL_IDS.includes(poolId);
  const isProdPool = KNOWN_PROD_POOL_IDS.includes(poolId);
  if (isDevPool && !flags.allowDevPool) {
    throw new Error(`Refusing --apply on dev pool ${poolId}. Use --allow-dev-pool for testing.`);
  }
  if (isProdPool && !flags.confirmProd) {
    throw new Error(`Prod pool ${poolId} requires --confirm-prod with --apply.`);
  }
  if (!isDevPool && !isProdPool) {
    throw new Error(`Unknown pool ${poolId}.`);
  }
}

/**
 * @param {CognitoIdentityProviderClient} cognito
 * @param {string} poolId
 * @returns {Promise<Array<{ username: string, email: string | null, status: string }>>}
 */
async function listForceChangePasswordUsers(cognito, poolId) {
  /** @type {Array<{ username: string, email: string | null, status: string }>} */
  const users = [];
  let token;
  do {
    const out = await cognito.send(
      new ListUsersCommand({
        UserPoolId: poolId,
        Limit: 60,
        PaginationToken: token,
      })
    );
    for (const user of out.Users || []) {
      if (user.UserStatus !== 'FORCE_CHANGE_PASSWORD') {
        continue;
      }
      const email =
        user.Attributes?.find((a) => a.Name === 'email')?.Value?.trim() || null;
      users.push({
        username: user.Username ?? email ?? '(unknown)',
        email,
        status: user.UserStatus ?? 'UNKNOWN',
      });
    }
    token = out.PaginationToken;
  } while (token);
  users.sort((a, b) => (a.email || a.username).localeCompare(b.email || b.username));
  return users;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const poolId = requireEnv('COGNITO_USER_POOL_ID');
  assertApplySafety(poolId, flags);

  const sdkConfig = getAwsSdkBaseClientConfig('Cognito confirm imported users');
  const sts = new STSClient(sdkConfig);
  const cognito = new CognitoIdentityProviderClient(sdkConfig);
  const identity = await sts.send(new GetCallerIdentityCommand({}));

  console.log('Cognito import confirm (FORCE_CHANGE_PASSWORD → CONFIRMED)');
  console.log(`  mode: ${flags.apply ? 'APPLY' : 'dry-run'}`);
  console.log(`  IAM:  ${identity.Arn ?? '(unknown)'}`);
  console.log(`  pool: ${poolId}`);
  console.log('');

  const targets = await listForceChangePasswordUsers(cognito, poolId);
  if (targets.length === 0) {
    console.log('No FORCE_CHANGE_PASSWORD users found. Nothing to do.');
    return;
  }

  console.log(`Found ${targets.length} user(s) in FORCE_CHANGE_PASSWORD.\n`);

  let updated = 0;
  let failed = 0;

  for (const user of targets) {
    const label = user.email || user.username;
    if (!flags.apply) {
      console.log(`  plan  ${label} — AdminSetUserPassword (Permanent)`);
      continue;
    }
    try {
      await cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: poolId,
          Username: user.username,
          Password: generateCognitoCompliantPassword(),
          Permanent: true,
        })
      );
      console.log(`  ok    ${label} — now CONFIRMED (random permanent password set)`);
      updated++;
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

  console.log(`Summary: updated ${updated}, failed ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log('\nUsers can now receive ForgotPassword codes. Retry forgot-password smoke test.');
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
