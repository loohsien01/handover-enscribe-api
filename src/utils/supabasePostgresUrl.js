/**
 * Reject copy-paste snippets that still say REGION / YOUR-PASSWORD (common ENOTFOUND cause).
 * @param {string} url
 */
function assertNoObviousSupabaseUrlPlaceholders(url) {
  if (/aws-\d+-REGION\.|\.REGION\.pooler/i.test(url)) {
    throw new Error(
      'Postgres URL still contains the literal REGION in the host (e.g. aws-0-REGION.pooler…). ' +
        'Replace REGION with your Supabase pool region (e.g. us-east-1). Copy the full connection string from ' +
        'Supabase Dashboard → Project Settings → Database → Connection string (URI).'
    );
  }
  if (/\[YOUR-PASSWORD\]/i.test(url) || /:\/\/YOUR-PASSWORD@/i.test(url) || /:\/\/\[YOUR-PASSWORD\]@/i.test(url)) {
    throw new Error(
      'Postgres URL still contains the YOUR-PASSWORD placeholder. Set the real database password in ' +
        'SUPABASE_DB_DIRECT_URL (or DATABASE_URL / SUPABASE_DB_URL).'
    );
  }
}

/**
 * Postgres connection URL for `pg` pool, migrations, and inspect scripts.
 * Feeds `supabasePostgresPool.js` and `npm run migrate:apply-psql`.
 *
 * Resolution (first non-empty wins):
 * 1. `DATABASE_URL_LOCAL` — **dev/local only** (`NODE_ENV !== 'production'`); SSH tunnel to RDS
 *    (`127.0.0.1:15432` while `npm run db:tunnel` is running). Ignored on EC2 prod.
 * 2. `SUPABASE_DB_DIRECT_URL` — legacy name; prefer `DATABASE_URL` for RDS after cutover
 * 3. `DATABASE_URL` — canonical RDS URI on EC2 (`*.rds.amazonaws.com`)
 * 4. `SUPABASE_DB_URL`
 * 5. Composed from `SUPABASE_DB_HOST` + `SUPABASE_DB_PASSWORD` (dev only)
 *
 * TLS for `pg`: see `SUPABASE_DB_SSL_REJECT_UNAUTHORIZED` in `supabasePostgresPool.js`.
 *
 * @returns {string | null}
 */
export function getSupabasePostgresUrl() {
  const fromEnv = (k) => {
    const v = process.env[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  if (process.env.NODE_ENV !== 'production') {
    const local = fromEnv('DATABASE_URL_LOCAL');
    if (local) {
      assertNoObviousSupabaseUrlPlaceholders(local);
      return local;
    }
  }

  const direct = fromEnv('SUPABASE_DB_DIRECT_URL');
  if (direct) {
    assertNoObviousSupabaseUrlPlaceholders(direct);
    return direct;
  }

  const urlFallback = fromEnv('DATABASE_URL') || fromEnv('SUPABASE_DB_URL');
  if (urlFallback) {
    assertNoObviousSupabaseUrlPlaceholders(urlFallback);
    return urlFallback;
  }

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const host = fromEnv('SUPABASE_DB_HOST');
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!host || password === undefined || password === null || String(password) === '') {
    return null;
  }

  const user = fromEnv('SUPABASE_DB_USER') || 'postgres';
  const database = fromEnv('SUPABASE_DB_NAME') || 'postgres';
  const port = fromEnv('SUPABASE_DB_PORT') || '5432';
  const sslmode = fromEnv('SUPABASE_DB_SSLMODE') || 'require';

  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(String(password));
  const encDb = encodeURIComponent(database);

  const built = `postgresql://${encUser}:${encPass}@${host}:${port}/${encDb}?sslmode=${encodeURIComponent(sslmode)}`;
  assertNoObviousSupabaseUrlPlaceholders(built);
  return built;
}
