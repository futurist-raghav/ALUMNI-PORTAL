# Sentinel Security Journal

## 2026-09-20 - Hardcoded JWT Fallback Secrets Risk
**Vulnerability:** Hardcoded fallback strings (e.g., `'your-secret-key'`, `'fallback_secret'`, `'fallback_refresh_secret'`) used when `JWT_SECRET` or `JWT_REFRESH_SECRET` environment variables were not set.
**Learning:** Hardcoded fallback secrets in authentication controllers or middleware allow attackers to forge valid JWT tokens or sign tokens using known default strings if environment variable configuration fails or is omitted in deployment.
**Prevention:** Always require `JWT_SECRET` and `JWT_REFRESH_SECRET` to be defined in environment configuration and throw explicit initialization/runtime errors when they are missing, rather than falling back to default secret strings.
