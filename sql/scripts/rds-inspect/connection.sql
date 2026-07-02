SELECT
  current_database() AS database,
  current_user AS db_user,
  inet_server_addr()::text AS server_addr,
  version() AS postgres_version,
  now() AS server_time;
