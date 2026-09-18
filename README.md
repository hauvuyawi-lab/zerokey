# zerokey

An unofficial serverless proxy that turns free web chats (Google Gemini and DeepAI) into an OpenAI-compatible API. No API keys, no accounts, and no paid subscriptions required.

Works as a drop-in replacement with standard OpenAI SDKs, LangChain, or any client where you can set a custom `baseURL`.

> [!CAUTION]
> **Read before using:**
> - **Not an official API**: This project reverse-engineers public web clients. It does not use official paid APIs.
> - **Fragile by nature**: If Google or DeepAI changes their frontend scripts, hashing logic, or endpoints, this proxy will break until the scraper is updated.
> - **Privacy warning**: Never send passwords, API keys, personal credentials, or confidential business data. Your prompts travel through public web chat interfaces that log data for moderation and training.
> - **Not for production / SaaS**: Do not use this as the backend for a commercial product or mission-critical app. Use official APIs (OpenAI, Google AI Studio, Anthropic) if you need reliable uptime, SLAs, and data privacy agreements.
> - **Terms of Service**: Automated use of web chat interfaces generally violates the respective website's Terms of Service. Use responsibly for personal projects, testing, and hobby scripts.

---

## Why Use This?

- **Zero setup**: Clone, deploy to Vercel/Cloudflare, and immediately get an OpenAI-compatible endpoint.
- **No credit card or accounts**: Useful for hobby projects, local scripts, CLI tools, or personal Discord bots where paying for API tokens doesn't make sense.
- **Multiple models**: Access Google Gemini and 15+ models available on DeepAI (`gpt-4o-mini`, `llama-3.3-70b-instruct`, `deepseek-v3.2`, `qwen3.8-flash`, etc.).
- **Zero hardcoded model lists**: Scrapes available unlocked models directly from the web app live.
- **Stateless & serverless**: Pure TypeScript fetch requests. No Puppeteer, no headless browser, no heavy Docker containers.
- **Streaming supported**: Supports real-time Server-Sent Events (SSE).

---

## Limitations to Know

| Feature | Reality |
| :--- | :--- |
| **Response Latency** | ~1.2s – 2.8s. Fast enough for chatting, but slower than dedicated enterprise API tiers. |
| **Tool / Function Calling** | **No native `tool_calls` object.** If you use agent frameworks, instruct the model in your prompt to return structured JSON or markdown actions. |
| **Context Window** | Limited. DeepAI caps chat history around ~30 messages. Not suitable for feeding entire codebases or 50-page PDFs. |
| **Flagship Paid Models** | Locked models like `claude-opus-5` or `gpt-6-astra` require a paid DeepAI Pro account and cannot be used here. Only unlocked models work. |
| **Streaming Style** | Returns standard OpenAI SSE chunks, but upstream services sometimes send tokens in short bursts rather than smooth character-by-character streams. |

---

## Rate Limits & Security: Read This Before Deploying

### 1. Does this project have a rate limiter?
**No.** By default, this repository is completely stateless and has **no built-in rate limiter and no authentication**. 

If you deploy this to a public Vercel URL and post the link publicly:
- Anyone can spam your endpoint.
- You could quickly exhaust your free Vercel monthly bandwidth/invocation limits.
- If you intend to share your deployment, add a basic secret check (e.g. require `Authorization: Bearer <secret>`) or configure Cloudflare / Upstash Redis rate limiting.

### 2. How do upstream rate limits work?
Both DeepAI and Google rate limit anonymous traffic by IP address:
- If an IP sends too many requests in a short period, DeepAI returns `429 Too Many Requests` (`"anonymous try it exceeded"`).
- Running this serverlessly on Vercel or Cloudflare Workers helps because outgoing traffic is spread across rotating edge datacenter IPs. For personal or small-team use, you will rarely hit limits.

---

## Quickstart

### 1. Python (using standard `openai` library)

```python
from openai import OpenAI

# Point client to your zerokey deployment
client = OpenAI(
    base_url="https://your-deployment.vercel.app/v1",
    api_key="none"  # Any dummy string works
)

# Standard completion
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": "You are a concise assistant."},
        {"role": "user", "content": "Why is the sky blue in 1 sentence?"}
    ]
)
print(response.choices[0].message.content)

# Streaming completion
stream = client.chat.completions.create(
    model="llama-3.3-70b-instruct",
    messages=[{"role": "user", "content": "Count from 1 to 5."}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

### 2. Node.js / TypeScript (using `openai` package)

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'https://your-deployment.vercel.app/v1',
    apiKey: 'none'
});

const response = await openai.chat.completions.create({
    model: 'deepseek-v3.2',
    messages: [{ role: 'user', content: 'What is 2 + 2?' }]
});

console.log(response.choices[0].message.content);
```

### 3. cURL

```bash
# OpenAI compatible chat
curl -X POST https://your-deployment.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Check currently unlocked models
curl https://your-deployment.vercel.app/v1/models
```

## How Multi-Turn Chat Works (Gemini vs. DeepAI)

When sending a `messages` array through `/v1/chat/completions`:

- **DeepAI models** (`gpt-4o-mini`, `llama-3.3-70b`, `deepseek-v3.2`, etc.):
  DeepAI's web client natively accepts chat history. The entire `messages` array is forwarded directly to DeepAI preserving multi-turn roles (`user`, `assistant`, `system`).
- **Google Gemini** (`gemini`):
  Google's web interface evaluates single-turn prompts anonymously. To support multi-turn conversations and system instructions without requiring stateful server-side sessions, `zerokey` automatically formats multi-message arrays into dialogue transcripts:
  ```text
  Instructions: You are a concise coding assistant.

  User: How do I read a file in Bun?

  Assistant: Use Bun.file("path").text().

  User: Can I read it as JSON?
  ```
  Frontier LLMs like Gemini are pre-trained on transcript patterns and follow these instructions and conversational contexts reliably. Single user messages are sent cleanly with zero prefixes.

---

## Complete API Reference

### 1. OpenAI-Compatible Route: `POST /v1/chat/completions`

#### Request Structure
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "What is the speed of sound?" }
    ],
    "stream": false
  }
  ```
  - `model` *(string, optional)*: Model ID (e.g. `gemini`, `gpt-4o-mini`, `llama-3.3-70b-instruct`, `deepseek-v3.2`). Defaults to DeepAI's default model.
  - `messages` *(array, required)*: List of message objects. Each object requires `role` (`"system" | "user" | "assistant" | "developer"`) and string `content`.
  - `stream` *(boolean, optional, default: `false`)*: When `true`, returns real-time Server-Sent Events (SSE).

#### Response: Non-Streaming (`stream: false`)
- **Status**: `200 OK`
- **Content-Type**: `application/json`
```json
{
  "id": "chatcmpl-f42d2a0edb58e32d1fd303ee",
  "object": "chat.completion",
  "created": 1789737594,
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The speed of sound in dry air at 20°C is approximately 343 meters per second."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 18,
    "total_tokens": 30
  }
}
```

#### Response: Streaming (`stream: true`)
- **Status**: `200 OK`
- **Content-Type**: `text/event-stream; charset=utf-8`
```text
data: {"id":"chatcmpl-b57c65d5","object":"chat.completion.chunk","created":1789737605,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-b57c65d5","object":"chat.completion.chunk","created":1789737605,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"The speed of sound"},"finish_reason":null}]}

data: {"id":"chatcmpl-b57c65d5","object":"chat.completion.chunk","created":1789737605,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":" is 343 m/s."},"finish_reason":null}]}

data: {"id":"chatcmpl-b57c65d5","object":"chat.completion.chunk","created":1789737605,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

#### Error Response
- **Status**: `400` / `429` / `500` / `502`
```json
{
  "error": {
    "message": "Missing or invalid \"messages\" array in request body.",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "missing_messages"
  }
}
```

---

### 2. Model Catalog Route: `GET /v1/models`

- **Status**: `200 OK`
- **Response Schema**:
```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini",
      "object": "model",
      "created": 1773800000,
      "owned_by": "google"
    },
    {
      "id": "gpt-4o-mini",
      "object": "model",
      "created": 1773800000,
      "owned_by": "openai"
    },
    {
      "id": "llama-3.3-70b-instruct",
      "object": "model",
      "created": 1773800000,
      "owned_by": "meta"
    }
  ]
}
```

---

### 3. Lean Provider Routes: `POST /deepai` & `POST /gemini`

If you prefer compact responses without OpenAI's wrapper objects:

#### Request Structure
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "prompt": "Explain gravity in 1 sentence.",
    "model": "llama-3.3-70b-instruct",
    "stream": false
  }
  ```
  *(Alternatively, you can pass a `"messages": [...]` array instead of `"prompt"`)*.

#### Response: Non-Streaming (`stream: false`)
- **Status**: `200 OK`
```json
{
  "response": "Gravity is the fundamental force by which masses attract one another.",
  "model": "llama-3.3-70b-instruct",
  "timeMs": 1820
}
```

#### Response: Streaming (`stream: true`)
- **Content-Type**: `text/event-stream; charset=utf-8`
```text
data: {"chunk":"Gravity is the","model":"llama-3.3-70b-instruct"}

data: {"chunk":" force of attraction.","model":"llama-3.3-70b-instruct"}

data: [DONE]
```

#### Error Response
```json
{
  "status": 400,
  "error": "Field 'prompt' cannot be empty."
}
```

---

### 4. Direct Model Discovery: `GET /deepai` & `GET /gemini`

```bash
curl https://your-deployment.vercel.app/deepai
```
**Response**:
```json
{
  "provider": "deepai",
  "models": [
    { "id": "standard", "name": "Standard", "provider": "deepai", "locked": false },
    { "id": "gpt-4o-mini", "name": "GPT-4o mini", "provider": "openai", "locked": false },
    { "id": "llama-3.3-70b-instruct", "name": "Llama 3.3 70B Instruct", "provider": "meta", "locked": false },
    { "id": "deepseek-v3.2", "name": "DeepSeek V3.2", "provider": "deepseek", "locked": false }
  ]
}
```

---

## Local Development & Testing

```bash
# Install dependencies
bun install

# Run the test suite (runs real live network tests against scrapers & chat endpoints)
bun test

# Type check
bun run typecheck

# Start local Vercel development server
bun x vercel dev
```
