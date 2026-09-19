# zerokey

An OpenAI-compatible API gateway that wraps public web chat services (**Google Gemini**, **DuckAI**, and **DeepAI**) into a unified `/v1/chat/completions` and `/v1/models` interface. No API keys, accounts, or payment credentials required.

Works as a drop-in replacement with standard OpenAI SDKs, LangChain, LibreChat, Chatbox, Cursor, Continue.dev, Aider, or any tool that supports a custom `baseURL`.

---

## How It Works

- **Unified OpenAI Interface**: Accepts standard `messages` arrays at `POST /v1/chat/completions` and returns standard OpenAI JSON or SSE chunks.
- **3-Tier Routing Hierarchy**: Automatically resolves models by priority: **Gemini -> DuckAI -> DeepAI**.
  - Requests for Google models (e.g. `gemini`) route to Gemini.
  - Requests matching DuckAI's free catalog route to DuckAI.
  - Remaining models fall back to DeepAI.
  - Specific providers can be forced using prefixes (e.g. `duckai/<model>` or `deepai/<model>`).
- **Dynamic Model Discovery**: Zero hardcoded model lists. `/v1/models` dynamically queries upstream provider manifests for currently unlocked, free-tier models and deduplicates them so higher-priority providers take precedence.
- **Real-Time Streaming**: Supports Server-Sent Events (`stream: true`) using standard Web Streams.
- **Auto-Continuation (`?ac=1`)**: Upstream web interfaces often enforce token limits per turn (~2,500–4,000 tokens). When enabled via query parameter, the proxy detects if output was cut off mid-code or mid-sentence, automatically requests continuation, deduplicates the seam, and emits a single uninterrupted stream.
- **Automated DuckAI Token Sync**: DuckAI requires an active anti-bot challenge pass (`X-Vqd-Hash-1`). Zerokey includes a headless browser harvester (`scripts/harvest.js`) and GitHub Action (`.github/workflows/harvest.yml`) to keep the token fresh in storage without redeploying code.

---

## Comparison: zerokey vs. Official Paid APIs

| Dimension | 🔑 zerokey | 🏢 Official APIs (OpenAI / Anthropic / Google) |
| :--- | :--- | :--- |
| **Cost** | **$0.00** (Free web backends) | Pay-per-token ($0.15 – $15.00+ / 1M tokens) |
| **Authentication** | Zero API keys, phone numbers, or credit cards | Requires vendor account, KYC, and payment card |
| **Model Access** | Unified multi-provider catalog in one endpoint | Locked to a single vendor per API key |
| **Context Window** | **~4,000 – 8,000 tokens** (Web UI limit) | **128,000 – 2,000,000 tokens** |
| **Max Output Length** | **~2,500 – 5,000 tokens** (With `?ac=1`) | 4,096 – 16,384 tokens native |
| **Streaming TTFT** | **~600 ms – 1,200 ms** | ~300 ms – 700 ms |
| **Native Tool Calling** | Synthetic prompt formatting (JSON prompt) | Native AST `tool_calls` parameter |
| **Multimodal / Files** | Text-only (No file/image attachments) | Full vision, audio, PDF, and image support |
| **Reliability & SLA** | Best-effort (subject to upstream web changes) | 99.9% uptime SLA with versioned stability |
| **Best Suited For** | Personal scripts, CLI tools, local bots | Commercial production, enterprise SaaS |

---

## Known Limitations

1. **Input Context Limits**: Upstream web interfaces truncate prompts beyond ~4,000–8,000 tokens. It is not suitable for feeding entire repositories or large document dumps into a single prompt.
2. **Text-Only**: Image uploads, audio generation, and file attachments are not supported.
3. **No Native Tool Calling AST**: Models do not support the structured `tool_calls` JSON schema parameter natively. If you need JSON outputs or function calls, instruct the model in your prompt to respond strictly in JSON.
4. **Upstream Challenges & Rate Limits**: Upstream web endpoints utilize anti-bot mitigations. While DeepAI and Gemini handle standard usage without sessions, DuckAI requires an active VQD token (maintained by the automated harvester). Identical-millisecond bursts from a single IP can trigger upstream cooldowns.
5. **No Uptime SLA**: This project reverse-engineers public web endpoints. If Google, DuckAI, or DeepAI changes their frontend scripts, hashing logic, or internal payload structures, endpoints may break until adaptors are updated.

---

## API Reference

### 1. Chat Completions: `POST /v1/chat/completions`

Standard OpenAI-compatible payload:

```json
{
  "model": "claude-haiku-4-5",
  "messages": [
    { "role": "system", "content": "You are a concise assistant." },
    { "role": "user", "content": "Explain quantum superposition." }
  ],
  "stream": false
}
```

- **Query Parameters**:
  - `?ac=1` (or `?auto_continue=true`): Opt in to auto-continuation if output hits upstream length limits. Disabled by default.

### 2. Model Catalog: `GET /v1/models`

Returns the live, dynamically discovered, and deduplicated catalog across all providers:

```json
{
  "object": "list",
  "data": [
    { "id": "gemini", "object": "model", "owned_by": "google" },
    { "id": "claude-haiku-4-5", "object": "model", "owned_by": "anthropic" },
    { "id": "llama-3.3-70b-instruct", "object": "model", "owned_by": "meta" }
  ]
}
```

### 3. Direct Provider Endpoints

Lightweight endpoints without OpenAI wrappers:
- `POST /gemini` — `{"prompt": "Hello"}`
- `POST /duckai` — `{"prompt": "Hello", "model": "<model_id>"}`
- `POST /deepai` — `{"prompt": "Hello", "model": "<model_id>"}`

### 4. DuckAI Token Management: `/duckai/token`

- `POST /duckai/token`: Ingestion endpoint used by the harvester to store fresh VQD tokens (`{"vqd": "..."}`). Guarded by `Authorization: Bearer <ADMIN_KEY>`.
- `GET /duckai/token`: Returns current token status (`{"hasToken": true, "tokenLength": 952}`). Guarded by `Authorization: Bearer <ADMIN_KEY>`.

---

## Usage Examples

### cURL

```bash
# Standard request
curl -X POST https://<your-host>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini",
    "messages": [{"role": "user", "content": "Explain event loops in 2 sentences."}]
  }'

# Real-time streaming with auto-continuation
curl -N -X POST "https://<your-host>/v1/chat/completions?ac=1" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "duckai/gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Write a complete LRU cache in TypeScript."}],
    "stream": true
  }'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-host>/v1",
    api_key="none"  # Not required, any dummy string works
)

response = client.chat.completions.create(
    model="claude-haiku-4-5",
    messages=[{"role": "user", "content": "What are the trade-offs of microservices?"}],
    stream=False
)
print(response.choices[0].message.content)
```

### TypeScript / Node.js (OpenAI SDK)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: 'https://<your-host>/v1',
    apiKey: 'none'
});

const stream = await client.chat.completions.create({
    model: 'gemini',
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
    stream: true
});

for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## Configuration & Environment Variables

| Variable | Location | Description |
| :--- | :--- | :--- |
| `ADMIN_KEY` | Worker Secret & GitHub Secret | Secret password protecting `POST /duckai/token`. |
| `WORKER_URL` | GitHub Repository Variable | Target URL (e.g. `https://<subdomain>.workers.dev`) used by the harvester. |
| `ZEROKEY_KV` | Cloudflare KV Binding | Cloudflare KV namespace binding for storing the active DuckAI session token. |
| `DUCKAI_VQD` | Environment Variable (Optional) | Static fallback DuckAI token if KV is not bound. |

---

## Autonomous Token Harvesting

DuckAI uses anti-bot challenge passes (`x-vqd-hash-1`) that expire periodically. Zerokey automates token maintenance:

1. **GitHub Action (`.github/workflows/harvest.yml`)**:
   - Runs automatically on a 2-hour cron schedule (or manually via **Actions > Run workflow**).
   - Solves the challenge using headless Chrome and posts the token to `/duckai/token`.
   - Requires repository secret `ADMIN_KEY` and repository variable `WORKER_URL`.

2. **Local Harvesting**:
   ```bash
   # Run locally to capture token and update .env.local:
   bun run harvest
   ```

---

## Development

```bash
# Install dependencies
bun install

# Run full test suite (82 tests covering scrapers, router, and worker)
bun test

# Type check
bun run typecheck

# Start local development server
bun run dev

# Deploy to Cloudflare Workers
bun run deploy
```

---

## Disclaimer

This project reverse-engineers public web chat interfaces for personal experimentation, research, and hobby use. It is not affiliated with, endorsed by, or connected to Google, DuckDuckGo, or DeepAI. Automated use of web interfaces may violate third-party Terms of Service. Do not use this service to process sensitive, personal, or confidential information.
