#!/usr/bin/env node
/**
 * Local TablePlus → VPC-private RDS via SSH or SSM port-forward through EC2.
 *
 *   localhost:15432  →  EC2  →  RDS:5432
 *
 * Required in .env.local (you likely already have these):
 *   DATABASE_URL=postgresql://…@enscribe-prod….rds.amazonaws.com:5432/enscribe?…
 *   EC2_DEPLOY_HOST=ec2-user@54.91.218.64
 *   EC2_DEPLOY_SSH_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY----- … (multiline OK)
 *
 * Optional:
 *   DB_TUNNEL_MODE=ssh          default: ssh when EC2 deploy vars exist, else ssm
 *   DB_TUNNEL_LOCAL_PORT=15432
 *   EC2_DEPLOY_SSH_KEY_PATH=keys/ec2.pem   file instead of inline key
 *   EC2_INSTANCE_ID=i-086b6…                SSM mode only
 *
 * Usage:
 *   npm run db:tunnel
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { isRdsPostgresHost } from '../../src/utils/postgresConnection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const ENV_LOCAL_PATH = path.join(REPO_ROOT, '.env.local');
const DEFAULT_CA_BUNDLE = path.join(REPO_ROOT, 'certs/rds-global-bundle.crt');
const DEFAULT_INSTANCE_ID = 'i-086b6a2ef671e8c63';

dotenv.config({ path: ENV_LOCAL_PATH, override: true });

/** @type {(() => void) | null} */
let sshKeyCleanup = null;

process.on('exit', () => sshKeyCleanup?.());
process.on('SIGINT', () => {
  sshKeyCleanup?.();
  process.exit(130);
});
process.on('SIGTERM', () => {
  sshKeyCleanup?.();
  process.exit(143);
});

/**
 * @param {string} key
 */
function envFirst(...keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * @returns {{ url: string; source: string } | null}
 */
function getTunnelDatabaseUrl() {
  const url = envFirst('DATABASE_URL');
  return url ? { url, source: 'DATABASE_URL' } : null;
}

/**
 * dotenv only reads the first line of unquoted multiline PEM blocks.
 * @param {string} envKey
 */
function readMultilinePemFromEnvFile(envKey) {
  if (!fs.existsSync(ENV_LOCAL_PATH)) return null;
  const lines = fs.readFileSync(ENV_LOCAL_PATH, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(`${envKey}=`)) continue;

    let block = line.slice(envKey.length + 1);
    if (!block.includes('BEGIN')) return block.trim() || null;

    const parts = [block];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(lines[j])) break;
      parts.push(lines[j]);
      if (lines[j].includes('END')) break;
    }
    return parts.join('\n').trim();
  }
  return null;
}

/**
 * @returns {{ path: string; source: string }}
 */
function resolveSshKeyPath() {
  const fileCandidates = [
    envFirst('EC2_DEPLOY_SSH_KEY_PATH'),
    path.join(REPO_ROOT, 'keys', 'ec2-deploy.pem'),
    path.join(REPO_ROOT, 'keys', 'enscribe-api.pem'),
  ].filter(Boolean);

  for (const candidate of fileCandidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.join(REPO_ROOT, candidate);
    if (fs.existsSync(abs)) {
      return { path: abs, source: path.relative(REPO_ROOT, abs) || abs };
    }
  }

  const inline =
    readMultilinePemFromEnvFile('EC2_DEPLOY_SSH_PRIVATE_KEY') ||
    envFirst('EC2_DEPLOY_SSH_PRIVATE_KEY');
  if (!inline || !inline.includes('BEGIN') || !inline.includes('END')) {
    throw new Error(
      'No SSH key found. Use EC2_DEPLOY_SSH_PRIVATE_KEY in .env.local (multiline PEM),\n' +
        'or save the key to keys/ec2-deploy.pem (gitignored) and set EC2_DEPLOY_SSH_KEY_PATH.'
    );
  }

  const pem = inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enscribe-ssh-'));
  const keyFile = path.join(dir, 'ec2-deploy.pem');
  fs.writeFileSync(keyFile, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o600 });
  sshKeyCleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  return { path: keyFile, source: 'EC2_DEPLOY_SSH_PRIVATE_KEY (.env.local)' };
}

/**
 * @returns {{ host: string; user: string }}
 */
function resolveEc2DeployHost() {
  const raw = envFirst('EC2_DEPLOY_HOST');
  if (!raw) {
    throw new Error('Missing EC2_DEPLOY_HOST in .env.local (e.g. ec2-user@54.91.218.64).');
  }
  const m = /^([^@]+)@(.+)$/.exec(raw);
  if (m) return { user: m[1], host: m[2] };
  return { user: 'ec2-user', host: raw };
}

/**
 * @param {string} connectionString
 */
function parsePostgresUrl(connectionString) {
  const normalized = connectionString.trim().replace(/^postgresql:/i, 'postgres:');
  const u = new URL(normalized);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres');
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port || '5432',
    database,
  };
}

function printUsage() {
  console.log(`Local RDS tunnel for TablePlus

  npm run db:tunnel

Uses existing .env.local vars (no RDS_ prefix):
  DATABASE_URL
  EC2_DEPLOY_HOST
  EC2_DEPLOY_SSH_PRIVATE_KEY   (multiline PEM — same as GitHub deploy)

Optional:
  DB_TUNNEL_MODE=ssh|ssm       default: ssh when deploy vars exist
  DB_TUNNEL_LOCAL_PORT=15432
  EC2_DEPLOY_SSH_KEY_PATH=keys/ec2-deploy.pem`);
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function waitForChild(child) {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * @param {{
 *   localPort: number;
 *   user: string;
 *   database: string;
 *   caPath: string;
 *   rdsHost: string;
 *   mode: string;
 * }} opts
 */
function printTablePlusInstructions(opts) {
  const { localPort, user, database, caPath, rdsHost, mode } = opts;
  console.log(`
══════════════════════════════════════════════════════════════
  TablePlus — use these settings (tunnel via ${mode})
══════════════════════════════════════════════════════════════

  Host:             127.0.0.1
  Port:             ${localPort}
  User:             ${user}
  Password:         ← from DATABASE_URL in .env.local
  Database:         ${database}
  SSL:              Require
  Root certificate: ${caPath}

  Remote RDS:       ${rdsHost}

  Keep this terminal open while using TablePlus. Ctrl+C to stop.
══════════════════════════════════════════════════════════════
`);
}

/**
 * @param {string} cmd
 */
function commandExists(cmd) {
  return new Promise((resolve) => {
    const p = spawn('which', [cmd], { stdio: 'ignore' });
    p.on('close', (code) => resolve(code === 0));
  });
}

/**
 * @param {string} mode
 */
function resolveTunnelMode(mode) {
  const normalized = (mode || 'auto').toLowerCase();
  if (normalized === 'auto') {
    const hasDeploy =
      envFirst('EC2_DEPLOY_HOST') &&
      (readMultilinePemFromEnvFile('EC2_DEPLOY_SSH_PRIVATE_KEY') ||
        envFirst('EC2_DEPLOY_SSH_PRIVATE_KEY') ||
        fs.existsSync(path.join(REPO_ROOT, 'keys', 'ec2-deploy.pem')));
    return hasDeploy ? 'ssh' : 'ssm';
  }
  return normalized;
}

/**
 * @param {number} port
 * @param {number} [timeoutMs]
 */
function waitForLocalPort(port, timeoutMs = 25000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(
            new Error(
              `Nothing is listening on 127.0.0.1:${port} after ${Math.round(timeoutMs / 1000)}s.\n` +
                'The SSH/SSM tunnel did not start — see errors above.'
            )
          );
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} localPort
 */
function waitForTunnelReady(child, localPort) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.once('exit', (code) => {
      fail(
        new Error(
          `Tunnel process exited before port ${localPort} opened (exit ${code ?? 1}).\n` +
            'TablePlus "connection refused" means this step failed — fix SSH/SSM first.'
        )
      );
    });

    waitForLocalPort(localPort).then(ok).catch(fail);
  });
}

async function startSshTunnel(pg, localPort, tablePlusOpts) {
  const { user, host } = resolveEc2DeployHost();
  const { path: sshKey, source: keySource } = resolveSshKeyPath();

  if (!(await commandExists('ssh'))) {
    throw new Error('ssh not found on PATH');
  }

  console.log(`SSH key: ${keySource}`);
  console.log(`Opening SSH tunnel ${localPort} → ${pg.host}:${pg.port} via ${user}@${host} …`);
  console.log('(If this hangs >25s, EC2 may be blocking SSH from your IP on port 22.)\n');

  const child = spawn(
    'ssh',
    [
      '-i',
      sshKey,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'BatchMode=yes',
      '-N',
      '-L',
      `127.0.0.1:${localPort}:${pg.host}:${pg.port}`,
      '-o',
      'ServerAliveInterval=60',
      `${user}@${host}`,
    ],
    { stdio: 'inherit' }
  );

  try {
    await waitForTunnelReady(child, localPort);
  } catch (err) {
    child.kill('SIGTERM');
    console.error(err instanceof Error ? err.message : err);
    console.error(`
SSH troubleshooting:
  1. EC2 security group must allow inbound TCP 22 from YOUR public IP
  2. EC2_DEPLOY_HOST must be the current public IP/DNS (check AWS console)
  3. EC2_DEPLOY_SSH_PRIVATE_KEY must match the key on the instance
  4. Test: ssh -i <keyfile> ${user}@${host}
`);
    process.exit(1);
  }

  console.log(`✓ Tunnel ready on 127.0.0.1:${localPort}\n`);
  printTablePlusInstructions(tablePlusOpts);

  const code = await waitForChild(child);
  if (code !== 0) {
    console.error(`\nSSH tunnel closed (exit ${code}).`);
  }
  process.exit(code);
}

async function startSsmTunnel(pg, localPort, region, tablePlusOpts) {
  const instanceId = envFirst('EC2_INSTANCE_ID', 'RDS_TUNNEL_EC2_INSTANCE_ID') || DEFAULT_INSTANCE_ID;

  if (!(await commandExists('aws'))) {
    throw new Error('AWS CLI not found');
  }
  if (!(await commandExists('session-manager-plugin'))) {
    throw new Error('Session Manager plugin not installed');
  }

  console.log(`SSM tunnel ${localPort} → ${pg.host}:${pg.port}`);
  console.log(`  region:   ${region}`);
  console.log(`  instance: ${instanceId}\n`);

  const parameters = JSON.stringify({
    host: [pg.host],
    portNumber: [String(pg.port)],
    localPortNumber: [String(localPort)],
  });

  const child = spawn(
    'aws',
    [
      'ssm',
      'start-session',
      '--region',
      region,
      '--target',
      instanceId,
      '--document-name',
      'AWS-StartPortForwardingSessionToRemoteHost',
      '--parameters',
      parameters,
    ],
    { stdio: 'inherit' }
  );

  try {
    await waitForTunnelReady(child, localPort);
  } catch (err) {
    child.kill('SIGTERM');
    console.error(err instanceof Error ? err.message : err);
    console.error(`
SSM failed. Add to .env.local and retry:

  DB_TUNNEL_MODE=ssh
`);
    process.exit(1);
  }

  console.log(`✓ Tunnel ready on 127.0.0.1:${localPort}\n`);
  printTablePlusInstructions(tablePlusOpts);

  const code = await waitForChild(child);
  if (code !== 0) {
    console.error(`
SSM tunnel failed (exit ${code}). If you saw 403 Forbidden, add to .env.local:

  DB_TUNNEL_MODE=ssh

Then rerun — uses EC2_DEPLOY_HOST + EC2_DEPLOY_SSH_PRIVATE_KEY (no .pem file path needed).
`);
  }
  process.exit(code);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const resolved = getTunnelDatabaseUrl();
  if (!resolved) {
    console.error('Missing DATABASE_URL in .env.local (RDS *.rds.amazonaws.com URI).');
    process.exit(1);
  }

  const { url: dbUrl, source } = resolved;
  console.log(`Postgres URL from ${source}`);

  const pg = parsePostgresUrl(dbUrl);
  if (!isRdsPostgresHost(pg.host)) {
    console.error(`${source} host is "${pg.host}" — expected *.rds.amazonaws.com.`);
    process.exit(1);
  }

  const region = envFirst('AWS_REGION') || 'us-east-1';
  const localPort = Number(envFirst('DB_TUNNEL_LOCAL_PORT', 'RDS_TUNNEL_LOCAL_PORT') || '15432');
  const mode = resolveTunnelMode(envFirst('DB_TUNNEL_MODE', 'RDS_TUNNEL_MODE'));
  const caPath = fs.existsSync(DEFAULT_CA_BUNDLE)
    ? DEFAULT_CA_BUNDLE
    : 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

  const tablePlusOpts = {
    localPort,
    user: pg.user,
    database: pg.database,
    caPath,
    rdsHost: pg.host,
    mode,
  };

  if (mode === 'ssh') {
    await startSshTunnel(pg, localPort, tablePlusOpts);
    return;
  }

  if (mode === 'ssm') {
    await startSsmTunnel(pg, localPort, region, tablePlusOpts);
    return;
  }

  console.error(`Unknown DB_TUNNEL_MODE="${mode}" — use ssh or ssm.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
