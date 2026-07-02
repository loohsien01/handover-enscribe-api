#!/usr/bin/env node
/**
 * Local IAM + dev Cognito pool smoke test (Phase A Part 3).
 *
 * Loads AWS keys from .env.local (no shell export / quoting issues).
 * Same credential path as the API: getAwsSdkBaseClientConfig() + AWS_ACTIONS_*.
 *
 * Usage (from repo root):
 *   npm run smoke:cognito-dev
 *   node sql/scripts/smoke-cognito-dev.mjs
 *
 * Required in .env.local:
 *   AWS_ACTIONS_ACCESS_KEY_ID
 *   AWS_ACTIONS_SECRET_ACCESS_KEY
 *   COGNITO_USER_POOL_ID          (dev pool, e.g. us-east-1_8zgtpuUJg)
 *   COGNITO_CLIENT_ID
 *   TEST_ACCOUNT_EMAIL
 *   TEST_ACCOUNT_PASSWORD
 *
 * Optional:
 *   AWS_REGION / COGNITO_REGION   (default us-east-1)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getAwsSdkBaseClientConfig } from '../../src/utils/awsSdkBaseClientConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env.local`);
  }
  return value;
}

/**
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
async function step(label, fn) {
  process.stdout.write(`  … ${label} `);
  try {
    await fn();
    console.log('✓');
  } catch (err) {
    console.log('✗');
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} failed (${name}): ${msg}`);
  }
}

async function main() {
  const poolId = requireEnv('COGNITO_USER_POOL_ID');
  const clientId = requireEnv('COGNITO_CLIENT_ID');
  const email = requireEnv('TEST_ACCOUNT_EMAIL');
  const password = requireEnv('TEST_ACCOUNT_PASSWORD');
  const region =
    process.env.COGNITO_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    'us-east-1';

  const sdkConfig = getAwsSdkBaseClientConfig('Cognito dev smoke');
  const sts = new STSClient(sdkConfig);
  const cognito = new CognitoIdentityProviderClient(sdkConfig);

  console.log('Cognito dev smoke test');
  console.log(`  region:   ${region}`);
  console.log(`  pool:     ${poolId}`);
  console.log(`  client:   ${clientId.slice(0, 6)}…`);
  console.log(`  username: ${email.split('@')[0]}@…`);
  console.log('');

  await step('STS GetCallerIdentity (AWS_ACTIONS_* keys)', async () => {
    const out = await sts.send(new GetCallerIdentityCommand({}));
    if (!out.Arn) {
      throw new Error('No Arn in response');
    }
    console.log(`\n      IAM: ${out.Arn}`);
  });

  await step('AdminInitiateAuth (ADMIN_USER_PASSWORD_AUTH)', async () => {
    const out = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: poolId,
        ClientId: clientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      })
    );

    if (out.ChallengeName) {
      throw new Error(
        `Challenge required: ${out.ChallengeName} — set a permanent password on the user`
      );
    }

    const access = out.AuthenticationResult?.AccessToken;
    const refresh = out.AuthenticationResult?.RefreshToken;
    const expiresIn = out.AuthenticationResult?.ExpiresIn;

    if (!access || !refresh) {
      throw new Error('No AuthenticationResult tokens returned');
    }

    console.log(`\n      AccessToken: ${access.slice(0, 20)}… (${expiresIn}s)`);
    console.log(`      RefreshToken: ${refresh.slice(0, 20)}…`);
  });

  console.log('');
  console.log('✅ Cognito dev IAM smoke passed — laptop keys + Cognito policy OK.');
}

main().catch((err) => {
  console.error('');
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  console.error('');
  console.error('Fix checklist:');
  console.error('  1. .env.local has AWS_ACTIONS_ACCESS_KEY_ID + AWS_ACTIONS_SECRET_ACCESS_KEY');
  console.error('  2. Same IAM user has EnscribeCognitoAuthDevProd (dev pool ARN)');
  console.error('  3. COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID = dev pool (not prod)');
  console.error('  4. TEST_ACCOUNT_EMAIL/PASSWORD = confirmed dev user with permanent password');
  console.error('  5. App client enables ALLOW_ADMIN_USER_PASSWORD_AUTH');
  process.exit(1);
});
