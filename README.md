# zerokey

An OpenAI-compatible API gateway that wraps public web chat services (**Google Gemini** and **DuckAI**) into a unified `/v1/chat/completions` and `/v1/models` interface. No API keys, accounts, or payment credentials required.

Works as a drop-in replacement with standard OpenAI SDKs, LangChain, LibreChat, Chatbox, Cursor, Continue.dev, Aider, or any tool that supports a custom `baseURL`.

---

## How It Works

- **Unified OpenAI Interface**: Accepts standard `messages` arrays at `POST /v1/chat/completions` and returns standard OpenAI JSON or SSE chunks.
- **Direct Multi-Model Routing**: Automatically routes between **Google Gemini** (default keyless engine) and **DuckAI** (Claude 3.5 Haiku, GPT-4o mini, Mistral, Llama 3.3 70B).
  - Unspecified or unknown models default directly to **Gemini**.
  - Requests matching DuckAI's free catalog route to **DuckAI**.
  - Specific providers can be explicitly targeted using prefixes (e.g. `duckai/<model>`).
- **100% Cloudflare Worker Native**: Completely self-contained with zero external proxies or third-party serverless dependencies needed.
- **Dynamic Model Discovery**: Zero hardcoded model lists. `/v1/models` dynamically discovers live free-tier models from upstream providers with zero duplicate entries.
- **Active System Anchoring (100% Persona Retention)**: System instructions and personas are dynamically anchored directly into active user turns, ensuring 100% character retention across multi-turn chats with zero context amnesia.
- **Real-Time Streaming**: Supports Server-Sent Events (`stream: true`) using standard Web Streams with zero token latency.
- **Auto-Continuation (`?ac=1`)**: Upstream web interfaces often enforce token limits per turn (~2,500–4,000 tokens). When enabled via query parameter, ZeroKey detects if output was cut off mid-code or mid-sentence, automatically requests continuation, deduplicates the seam, and emits a single uninterrupted stream.
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
| **Multimodal / Files** | Text-only processing (Safely accepts OpenAI multimodal payloads, extracts text & strips binary media) | Full vision, audio, PDF, and image support |
| **Reliability & SLA** | Best-effort (subject to upstream web changes) | 99.9% uptime SLA with versioned stability |
| **Best Suited For** | Personal scripts, CLI tools, local bots | Commercial production, enterprise SaaS |

---

## Known Limitations

1. **Input Context Limits**: Upstream web interfaces truncate prompts beyond ~4,000–8,000 tokens. It is not suitable for feeding entire repositories or large document dumps into a single prompt.
2. **Text-Only Modality**: Upstream free anonymous endpoints are purely text-based. While ZeroKey safely accepts standard OpenAI multimodal payloads (images, audio clips, file attachments) without crashing or throwing JSON errors, it extracts all prompt text and appends contextual tags (e.g. `[Attached Image]`) while stripping heavy binary tensors. Models cannot visually inspect images or listen to audio recordings.
3. **No Native Tool Calling AST**: Models do not support the structured `tool_calls` JSON schema parameter natively. If you need JSON outputs or function calls, instruct the model in your prompt to respond strictly in JSON.
4. **Upstream Challenges**: Upstream web endpoints utilize anti-bot mitigations. Gemini handles usage directly with zero sessions or tokens, while DuckAI requires an active VQD token (maintained automatically by the headless harvester).
5. **No Uptime SLA**: This project reverse-engineers public web endpoints. If Google or DuckDuckGo changes their frontend scripts or payload structures, endpoints may break until adaptors are updated.

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

# Run full test suite (77 tests covering scrapers, router, and worker)
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

This project reverse-engineers public web chat interfaces for personal experimentation, research, and hobby use. It is not affiliated with, endorsed by, or connected to Google or DuckDuckGo. Automated use of web interfaces may violate third-party Terms of Service. Do not use this service to process sensitive, personal, or confidential information.
