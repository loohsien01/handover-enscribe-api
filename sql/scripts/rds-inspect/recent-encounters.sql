SELECT
  id,
  user_id,
  created_at,
  updated_at
FROM public."patientEncounters"
ORDER BY created_at DESC NULLS LAST
LIMIT 10;
