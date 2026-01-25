import { createClerkClient } from '@clerk/backend';

const clerkSecretKey = process.env.CLERK_SECRET_KEY;

console.log('[CLERK:INIT] CLERK_SECRET_KEY exists:', !!clerkSecretKey);
console.log('[CLERK:INIT] CLERK_SECRET_KEY length:', clerkSecretKey?.length || 0);
console.log('[CLERK:INIT] CLERK_SECRET_KEY prefix:', clerkSecretKey?.substring(0, 10) || 'N/A');

export const clerkClient = clerkSecretKey
  ? createClerkClient({ secretKey: clerkSecretKey })
  : null;

console.log('[CLERK:INIT] clerkClient created:', !!clerkClient);

export function requireClerkSecretKey() {
  if (!clerkSecretKey) {
    throw new Error('CLERK_SECRET_KEY is not set');
  }
  return clerkSecretKey;
}
