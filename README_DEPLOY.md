# NEXUS AI Engine

## Render environment variables
- OPENAI_API_KEY = your OpenAI API key
- OPENAI_MODEL = gpt-5.6-luna
- BASE_URL = your Render public URL
- META_VERIFY_TOKEN = any private verification string (only for Meta webhook)
- META_APP_ID / META_APP_SECRET / META_REDIRECT_URI = only when Meta OAuth is enabled

## Main endpoints
- GET /api/health
- POST /api/business/analyze
- POST /api/agent/generate
- POST /api/agent/chat
- POST /api/channel/inbound
- GET/POST /api/webhooks/meta
- GET /api/meta/connect?agentId=...
