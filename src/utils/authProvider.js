/**
 * Auth identity provider selection during Supabase → Cognito migration.
 * Default `supabase` until cutover; set AUTH_PROVIDER=cognito in .env.local / EC2.
 */

/** @returns {'supabase' | 'cognito'} */
export function getAuthProvider() {
  const value = process.env.AUTH_PROVIDER?.trim().toLowerCase();
  return value === 'cognito' ? 'cognito' : 'supabase';
}

export function isCognitoAuth() {
  return getAuthProvider() === 'cognito';
}

export function isSupabaseAuth() {
  return getAuthProvider() === 'supabase';
}
