# Security Documentation

## Overview
This document outlines the security measures implemented in the XeloChat backend API.

## Rate Limiting

### Current Limits
- **General API**: 100 requests/minute (per user/IP)
- **Scraping**: 5 requests/minute (per user)
- **Chat**: 30 messages/minute (per user)
- **Widget**: 60 requests/minute (per API key)
- **Strict Operations** (booking): 10 requests/minute (per user/API key)

### Implementation
- Uses `express-rate-limit` with per-user key generation
- Rate limits are applied per authenticated user or API key (not just IP)
- Health check endpoints are excluded from rate limiting

## Database Security

### SQL Injection Prevention
- **Prisma ORM**: All database queries use Prisma, which uses parameterized queries
- **No Raw SQL**: No raw SQL queries are executed
- **Input Validation**: All inputs are validated before database operations

### Authorization
- All database queries include `userId` checks to ensure users can only access their own resources
- Uses `updateMany` with `where` clauses to prevent unauthorized updates
- API keys are scoped to specific chatbots when configured

## Input Validation

### Validation Functions
- `validateChatbotId()`: Alphanumeric, hyphens, underscores only
- `validateEmail()`: RFC-compliant email format
- `validatePhone()`: Basic phone number format
- `validateUrl()`: HTTP/HTTPS URLs only
- `sanitizeString()`: Trims and limits string length
- `sanitizeBookingData()`: Sanitizes all booking fields

### Applied To
- Chatbot IDs
- Booking data (names, emails, phones, notes)
- URLs for scraping
- API keys

## API Security

### Authentication
- **JWT Tokens**: Clerk JWT tokens for dashboard routes
- **API Keys**: SHA-256 hashed API keys for widget routes
- **Domain Whitelisting**: API keys can be restricted to specific domains

### Headers
- **Helmet**: Security headers (CSP, XSS protection, etc.)
- **CORS**: Configured with appropriate origins
- **Content-Type**: JSON payloads limited to 5MB

## Request Security

### Size Limits
- JSON payloads: 5MB max
- URL-encoded: 5MB max
- Request timeout: 30 seconds

### XSS Protection
- All user content is sanitized before rendering
- Shadow DOM isolation in embed.js
- Content Security Policy headers

## API Key Security

### Storage
- API keys are hashed with SHA-256 before storage
- Original keys are never stored
- Keys are validated on every request

### Validation
- Format validation (10-200 characters)
- Domain whitelist checking
- Expiration date checking
- Active status checking

## Error Handling

### Information Disclosure
- Generic error messages for production
- Detailed errors only logged server-side
- No stack traces exposed to clients

## Recommendations

### Additional Security Measures to Consider
1. **Request Logging**: Implement request logging for audit trails
2. **IP Blocking**: Add IP-based blocking for repeated violations
3. **2FA**: Consider two-factor authentication for sensitive operations
4. **Encryption**: Encrypt sensitive data at rest
5. **Backup Security**: Secure database backups
6. **Monitoring**: Set up security monitoring and alerts
7. **Penetration Testing**: Regular security audits

### Rate Limit Tuning
- Monitor usage patterns and adjust limits as needed
- Consider different limits for different user plans
- Implement burst limits for better UX

## Known Vulnerabilities

### Hono (Dev Dependency Only)
**Status**: Acknowledged, Low Risk

**Details**:
- Vulnerability: JWT algorithm confusion in Hono (CVE in Prisma dev dependencies)
- Severity: High (but dev-only)
- Location: `prisma` → `@prisma/dev` → `hono`
- Impact: **NONE** - This is a dev dependency only

**Why It's Safe**:
1. **Dev Dependency Only**: Hono is only in Prisma's dev dependencies, not installed in production
2. **Not Used in Runtime**: We use Clerk JWT verification for authentication, not Hono
3. **Prisma Runtime**: Prisma's runtime (`@prisma/client`) does not use Hono
4. **Override Applied**: Package.json includes an override to force Hono 4.11.4+ when possible

**Mitigation**:
- Override in `package.json` forces newer Hono version
- `.npmrc` configured to suppress dev dependency audit warnings
- Monitoring for Prisma updates that fix this in their dev dependencies

**Action Required**: None - this does not affect production security

## Compliance

### Data Protection
- User data is stored securely
- Booking data is sanitized before storage
- API keys are hashed and never exposed

### Privacy
- No unnecessary data collection
- User consent for data processing
- Data retention policies should be defined
