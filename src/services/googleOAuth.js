import { google } from 'googleapis';
import crypto from 'crypto';

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// Scopes required for Google Calendar integration
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
];

/**
 * Create OAuth2 client
 */
function createOAuth2Client() {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('Google OAuth credentials not configured');
  }

  return new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI
  );
}

/**
 * Generate authorization URL for user to connect their Google Calendar to a chatbot
 */
export function generateAuthUrl(userId, chatbotId) {
  const oauth2Client = createOAuth2Client();

  // Create a state parameter with HMAC signature to prevent CSRF and tampering
  const payload = JSON.stringify({
    userId,
    chatbotId,
    timestamp: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex')
  });

  // Sign the payload with HMAC
  const signature = crypto
    .createHmac('sha256', ENCRYPTION_KEY || 'fallback-key')
    .update(payload)
    .digest('hex');

  const state = Buffer.from(JSON.stringify({
    payload,
    signature
  })).toString('base64');

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Get refresh token
    scope: CALENDAR_SCOPES,
    state,
    prompt: 'consent' // Force consent screen to always get refresh token
  });

  return { url, state };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code) {
  const oauth2Client = createOAuth2Client();

  const { tokens } = await oauth2Client.getToken(code);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
  };
}

/**
 * Refresh an access token using the refresh token
 */
export async function refreshAccessToken(refreshToken) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const { credentials } = await oauth2Client.refreshAccessToken();

  return {
    accessToken: credentials.access_token,
    expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null
  };
}

/**
 * Create an OAuth2 client with user's tokens
 */
export function createUserOAuth2Client(accessToken, refreshToken) {
  const oauth2Client = createOAuth2Client();

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  return oauth2Client;
}

/**
 * Get user's Google Calendar list
 */
export async function getUserCalendars(accessToken, refreshToken) {
  const oauth2Client = createUserOAuth2Client(accessToken, refreshToken);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const response = await calendar.calendarList.list({
    minAccessRole: 'writer' // Only calendars they can write to
  });

  return response.data.items.map(cal => ({
    id: cal.id,
    summary: cal.summary,
    primary: cal.primary || false,
    backgroundColor: cal.backgroundColor
  }));
}

/**
 * Revoke user's OAuth tokens
 */
export async function revokeToken(accessToken) {
  const oauth2Client = createOAuth2Client();

  try {
    await oauth2Client.revokeToken(accessToken);
    return { success: true };
  } catch (error) {
    console.error('Failed to revoke token:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Encrypt a token for secure storage
 */
export function encryptToken(token) {
  if (!token) return null;
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required for secure token storage');
  }

  // Use a unique salt per encryption for better security
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Format: salt:iv:encrypted
  return salt.toString('hex') + ':' + iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a stored token
 */
export function decryptToken(encryptedToken) {
  if (!encryptedToken) return null;
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required for token decryption');
  }

  try {
    const parts = encryptedToken.split(':');

    // Handle new format (salt:iv:encrypted)
    if (parts.length === 3) {
      const [saltHex, ivHex, encrypted] = parts;
      const salt = Buffer.from(saltHex, 'hex');
      const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    // Handle old format (iv:encrypted) for backward compatibility
    if (parts.length === 2) {
      const [ivHex, encrypted] = parts;
      const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    throw new Error('Invalid encrypted token format');
  } catch (error) {
    console.error('Token decryption failed:', error);
    throw new Error('Failed to decrypt token');
  }
}

/**
 * Validate state parameter from OAuth callback
 */
export function validateState(state) {
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    const { payload, signature } = decoded;

    if (!payload || !signature) {
      return { valid: false, error: 'Invalid state format' };
    }

    // Verify HMAC signature to prevent tampering
    const expectedSignature = crypto
      .createHmac('sha256', ENCRYPTION_KEY || 'fallback-key')
      .update(payload)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
      return { valid: false, error: 'Invalid state signature' };
    }

    const data = JSON.parse(payload);

    // Check if state is not too old (5 minutes max)
    if (Date.now() - data.timestamp > 5 * 60 * 1000) {
      return { valid: false, error: 'State expired' };
    }

    return { valid: true, userId: data.userId, chatbotId: data.chatbotId };
  } catch (error) {
    return { valid: false, error: 'Invalid state' };
  }
}

/**
 * Check if Google OAuth is properly configured
 */
export function isGoogleOAuthConfigured() {
  return !!(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI);
}
