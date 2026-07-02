SELECT
  table_schema,
  table_name
FROM information_schema.tables
WHERE table_schema IN ('public', 'archive', 'auth')
  AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name;
