import Stripe from 'stripe';

let stripeSingleton = null;

/**
 * @returns {Stripe | null} Stripe client, or null if STRIPE_SECRET_KEY is unset
 */
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripeSingleton) {
    stripeSingleton = new Stripe(key);
  }
  return stripeSingleton;
}
