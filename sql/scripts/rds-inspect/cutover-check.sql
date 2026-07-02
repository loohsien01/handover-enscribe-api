SELECT 'auth.users' AS table_name, count(*)::bigint AS row_count FROM auth.users
UNION ALL
SELECT 'patientEncounters', count(*)::bigint FROM public."patientEncounters"
UNION ALL
SELECT 'recordings', count(*)::bigint FROM public.recordings
UNION ALL
SELECT 'notes', count(*)::bigint FROM public.notes
UNION ALL
SELECT 'transcripts', count(*)::bigint FROM public.transcripts
UNION ALL
SELECT 'userProfiles', count(*)::bigint FROM public."userProfiles"
ORDER BY table_name;
