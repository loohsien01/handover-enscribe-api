SELECT
  schemaname AS schema,
  relname AS table_name,
  n_live_tup AS est_rows,
  last_vacuum,
  last_autovacuum,
  last_analyze
FROM pg_stat_user_tables
WHERE schemaname IN ('public', 'archive', 'auth')
ORDER BY schemaname, n_live_tup DESC;
