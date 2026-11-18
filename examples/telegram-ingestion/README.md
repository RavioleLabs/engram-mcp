# Telegram → Engram ingestion

Run **your own company bot** and save selected messages into Engram Cloud. Each company creates its bot with BotFather, owns its Telegram token and operates this process. Engram does not create a shared bot or receive your bot token. This is an ingestion template, not a Telegram messaging MCP or a chat assistant.

```text
Your Telegram chat → your bot process → Engram context
                                             ↑
                                  your agent via EngramMCP
```

The bot uses an ingestion-only key. The agent uses a separate, user-owned Read key. Engram verifies company membership, team membership, context and expiry on every request. A bot does not gain access to the company’s other memories.

## Setup

1. In Engram Cloud, create your workspace and invite your colleagues. Create a team and add its members, including yourself if you will configure its memory.
2. Create a team context. Create a source named `Telegram — Product`, then a key with **Write only**. Keep the default seven-day key lifetime, or use the company administrator’s chosen policy. Save the key in your own secret manager.
3. Create your bot through Telegram’s official **BotFather**. Obtain its bot ID, username and token. Add it only to chats your company has approved for collection.
4. Copy `config.example.json` to `config.local.json`. Set the Engram endpoint, expected bot ID, exact chat ID and exact topic ID. Use `null` for messages without a topic; this is **not** a wildcard for all topics. Choose a distinct Engram source/key for each configured collection boundary.
5. Save the Telegram token and Engram key to private secret files. Do not paste them into chat, source code, command arguments or configuration committed to Git.

### Docker Compose

From `examples/telegram-ingestion`:

```sh
mkdir -m 700 secrets
cp config.example.json config.local.json
# Populate secrets/telegram-bot-token and secrets/engram-product-write
# using your secret manager, then edit config.local.json.
docker compose up --build -d
docker compose logs --tail=30 ingestion
```

The secret files must be readable by the container’s `node` user (UID 1000). Protect the enclosing host directory and mount the files read-only. The image builds from the repository root. It runs without root, with dropped capabilities and a read-only filesystem; only the checkpoint volume is writable. It exposes no listening port.

For additional mappings, add corresponding Compose secrets and `keyFile` entries. Never share one Read key with the ingestion process. Rotate the file atomically while preserving its configured path; the process reads its Engram key for every delivery. Rotating the Telegram token requires a restart.

### Without Docker

Use Node.js 22.13+ and the complete repository layout. The ingestion process has no npm dependency installation step.

```sh
export ENGRAM_TELEGRAM_CONFIG=/absolute/path/config.local.json
export TELEGRAM_BOT_TOKEN_FILE=/absolute/path/private/telegram-bot-token
node examples/telegram-ingestion/src/run.mjs
```

Set `stateFile` to a durable location writable only by the service account. Use absolute `keyFile` paths. A service manager should restart the process after clean shutdown or a transient failure.

## Collect a memory

The default `command` mode collects messages starting with `/remember`, for example:

```text
/remember Product approved a December release. The owner is the product team.
```

You can address the bot explicitly with `/remember@your_bot_username`. Ordinary conversation is ignored. Each saved record includes a title, text, source ID, Telegram message identifier and, for supported private supergroups/channels, a source link. It does not store the author’s profile or download attachments. Edits to a collected command update the same record. Removing the command prefix from an edit does not delete an earlier memory; delete it in Engram using the source’s Delete key.

Set a mapping’s `mode` to `all` only when the company has intentionally enabled collection for that exact chat/topic. Telegram privacy mode and chat permissions still control which updates the bot receives. Bot-authored and protected-content messages are skipped. Audio, documents, media download, automatic summaries and historical backfill are outside this initial template.

The process checks `getMe` against the configured bot ID and refuses to start if a webhook is already configured. It never deletes an existing webhook or takes over another bot integration. Choose a dedicated bot if the company’s existing bot already handles updates.

## Recovery and deletion

- Long polling receives updates. A checkpoint is persisted before delivery, and its offset advances only after Engram accepts the record or deliberately rejects it as already deleted/expired.
- Restarting retries the same external ID and version; duplicate delivery does not create another memory. Multiple edits in the same second receive distinct versions.
- Failed credentials, revoked membership, capacity exhaustion and network outages stop acknowledgment of the failed update. Fix the configuration; subsequent retries resume delivery.
- Only one process may use a checkpoint and bot. An exclusive lock prevents concurrent consumers. After an unclean crash, stop the service, verify no other instance is using the bot, remove only `checkpoint.json.lock`, then restart. Preserve `checkpoint.json`.
- Telegram retains unconsumed updates for at most 24 hours. An outage longer than that can lose updates; this is not a guaranteed archive of the entire chat. After six idle days the template resets the high-water mark because Telegram can randomize the next update ID after a week.
- Telegram does not provide an exhaustive deletion feed for ordinary messages. Use Engram deletion and retention for cloud copies. Deleted/expired content cannot be restored by ingestion retries. Encrypted historical backups expire under the hosting provider’s backup policy.
- The initial cloud service supports 1,000 identifiers per context, including tombstones. Create a new context/source for the next collection period when it reaches capacity; do not silently drop updates.

The template never sends messages to chats and has no company-wide Read key. A future question-answering bot requires verified user identities, context permissions and destination checks. Do not add a shared company Read key to a group chatbot.

## Test

```sh
node --test examples/telegram-ingestion/tests/*.test.mjs
```

Tests use synthetic updates; they do not connect a real Telegram bot. To verify your installation, send an approved `/remember` message in the configured chat and recall a distinctive phrase through a Read-only Engram MCP connection.

References: [Telegram Bot API](https://core.telegram.org/bots/api#getupdates), [bot privacy FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get). This template follows the repository’s Elastic-2.0 license.
