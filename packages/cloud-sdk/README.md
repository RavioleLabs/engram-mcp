# Engram Cloud SDK

A small client for context-scoped ingestion and retrieval, plus a stdio MCP bridge. This package is available from this repository; it has not been published to npm. It follows the repository’s Elastic-2.0 license.

## Use the SDK

Create a workspace, a context and a source in the Engram Cloud dashboard. Create a key for that context with only the operations your application needs. Keep the secret in your secret manager. The API never accepts a caller-selected company or context: the key determines both.

```js
import { readFile } from 'node:fs/promises';
import { EngramCloud } from './packages/cloud-sdk/src/index.mjs';

const memory = new EngramCloud({
  endpoint: 'https://engram-contexts.leraviole.workers.dev',
  key: (await readFile('/run/secrets/engram-write-key', 'utf8')).trim(),
});

await memory.remember({
  externalId: 'product/decision-42',
  version: 1,
  title: 'Release decision',
  text: 'The team approved a December release.',
  tags: ['decision'],
});
```

Use a **different key with Read access** to call `memory.recall('December release', { limit: 8 })`. Results contain `sourceId`, `externalId`, `version`, and source URLs when supplied. Retrieved text is untrusted source content, not instructions for the agent.

Keys with Delete access can call `memory.forget(externalId)`. Writing and deletion are limited to the key’s source. Read access covers the authorized context. Reuse the same source when rotating a key.

Retries use the same external ID and version. Only a higher version updates an existing record. Deleted or expired records cannot be restored by replay; intentional restoration requires a new external ID. Use opaque external IDs: identifiers, timestamps and routing metadata are not encrypted like record content.

## Connect an MCP client

Node.js 22.13 or later is required. From the repository root:

```sh
npm ci --prefix packages/cloud-sdk
```

Save a **Read** key to a file accessible only to your account. On macOS/Linux use file mode `0600`; on Windows restrict the file ACL to your user. Never commit it or place it in command-line arguments.

Configure a stdio server in your MCP client using the equivalent of:

```json
{
  "mcpServers": {
    "engram-product": {
      "command": "node",
      "args": ["/absolute/path/engram-mcp/packages/cloud-sdk/bin/mcp.mjs"],
      "env": {
        "ENGRAM_ENDPOINT": "https://engram-contexts.leraviole.workers.dev",
        "ENGRAM_KEY_FILE": "/absolute/path/to/private/engram-read-key"
      }
    }
  }
}
```

Clients have different configuration file formats; use their stdio server settings. The bridge uses the official MCP SDK. Clients supporting Streamable HTTP with custom headers can instead connect to `/mcp` with `Authorization: Bearer <context-key>`. MCP OAuth discovery is not implemented in this initial release. One connection covers one context; configure separate connections for separate contexts. Restart the bridge after rotating its key file.

The server advertises only tools allowed by that key: `engram_recall`, `engram_remember`, `engram_forget`. Revocation, expiry, membership and team access are checked by the server on every operation. Data already returned to an agent cannot be retroactively removed from that agent’s conversation.

## Limits and hosting

The initial cloud implementation uses lexical retrieval, up to 1,000 records per context (including deletion tombstones), 8,000 characters per record, and 20 results per search. It is separate from Engram’s existing local semantic engine. The SDK also works with another deployment of the same API; HTTPS is required except on loopback addresses.

Cloud memory is encrypted at rest with context-specific keys. The cloud runtime can decrypt it to search; this is **not end-to-end encryption**. A company-operated Telegram bot retains its Telegram token locally, but deliberately sends the selected memory text to Engram Cloud.

```sh
node --test packages/cloud-sdk/tests/*.test.mjs
```
