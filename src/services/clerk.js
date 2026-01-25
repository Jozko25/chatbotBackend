import { createClerkClient } from '@clerk/backend';

const clerkSecretKey = process.env.CLERK_SECRET_KEY;

export const clerkClient = clerkSecretKey
  ? createClerkClient({ secretKey: clerkSecretKey })
  : null;

export function requireClerkSecretKey() {
  if (!clerkSecretKey) {
    throw new Error('CLERK_SECRET_KEY is not set');
  }
  return clerkSecretKey;
}
