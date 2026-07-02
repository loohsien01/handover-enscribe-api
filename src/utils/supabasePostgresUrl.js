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
 * Builds a Postgres connection URL for the Supabase database (same instance as PostgREST).
 * Feeds `pg` in `supabasePostgresPool.js` and `npm run migrate:apply-psql` — any valid `postgresql://`
 * URI works, including Supabase **Transaction pooler (Shared Pooler, IPv4)**:
 * user `postgres.<project_ref>`, host `aws-0-<region>.pooler.supabase.com`, port **6543**.
 * (The env name `SUPABASE_DB_DIRECT_URL` is historical; the value is often the pooler URI on IPv4 networks.)
 *
 * Resolution (first non-empty wins):
 * 1. `SUPABASE_DB_DIRECT_URL`
 * 2. `DATABASE_URL`
 * 3. `SUPABASE_DB_URL`
 * 4. Composed from `SUPABASE_DB_HOST` + `SUPABASE_DB_PASSWORD` (+ optional port/user/db/sslmode).
 *    Dev/local only — skipped when `NODE_ENV=production` (prod uses `DATABASE_URL` on RDS).
 *    For the pooler, set `SUPABASE_DB_USER=postgres.<project_ref>` and `SUPABASE_DB_PORT=6543`.
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
