/**
 * src/cloud/endpoints.ts
 *
 * HARDCODED cloud endpoints. NOT configurable from ~/.engram/config.json
 * or any env var. Forks attempting to redirect engram-mcp to a self-hosted
 * cloud must modify and recompile from source — this is intentional.
 *
 * Why hardcoded:
 *   - Pair flow, billing, sync — all require our backend to validate
 *     subscriptions and route relays. Allowing override would let bad actors
 *     stand up clone clouds and bypass payments.
 *   - The cloud client logic itself lives in src/private/ (gitignored,
 *     closed-source). Modifying these URLs in source without the private
 *     client implementation produces a non-functional binary.
 *
 * Local-only usage (Free tier, no cloud at all) is fully supported via the
 * core MemoryStore — these endpoints are only touched when the user pairs
 * their account.
 */

/** Cloud API base — bridge relay, auth, billing, embeddings, whisper, memories endpoints */
export const ENGRAM_API_BASE = 'https://api.engram-mcp.com';

/** Web app base — pair page, dashboard, marketing */
export const ENGRAM_APP_BASE = 'https://engram-mcp.com';

/** Installer worker — `installer.engram-mcp.com/mcp` exposes install tools for agents */
export const ENGRAM_INSTALLER_BASE = 'https://installer.engram-mcp.com';
