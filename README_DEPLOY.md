# NEXUS AI Engine 4.1 — Server + Live AI Test

## What is included
- Public business URL analyzer for websites and publicly readable profile pages.
- Business Brain JSON stored in SQLite and injected into the AI agent prompt.
- OpenAI Responses API integration (server-side key only).
- Free test activation and live test chat.
- Generic inbound channel endpoint.
- Meta webhook verification endpoint.
- Meta OAuth scaffold and Meta inbound webhook handler.
- Dockerfile for deployment on a Node 20 host.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Put your OpenAI API key in `OPENAI_API_KEY`.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000` — do NOT open `index.html` directly.

## Important for the user's phone test
The AI provider key and Meta webhooks must live on a public server. A file opened from Android (`file://` or `content://`) cannot receive Meta webhooks and should not contain secrets.

For the first free test, deploy this folder to a Node host and set:
- `OPENAI_API_KEY`
- `BASE_URL`
- `OPENAI_MODEL=gpt-5.6-luna`

Open the public HTTPS URL on the phone. Paste the Instagram profile URL into NEXUS and press **Analyze my business**. The server attempts to read publicly available page data and builds a Business Brain. If Instagram limits public HTML, the UI should use the Meta Connect flow for authorized account data.

## Real Instagram / Facebook messaging
A real Meta app is required. Configure the Meta App ID/secret, OAuth redirect URI and webhook URL:
- Verification: `GET /api/webhooks/meta`
- Events: `POST /api/webhooks/meta`
- OAuth start: `/api/meta/connect`
- OAuth callback: `/api/meta/callback`

Use Meta's current official permissions/products for the account type you are connecting. Do not collect an Instagram/Facebook password in NEXUS.

## Security
- Never put `OPENAI_API_KEY`, Meta app secret, or user access tokens in `index.html`.
- Use HTTPS in production.
- Replace `META_VERIFY_TOKEN` before going live.
- Encrypt or use a managed secret store for production channel tokens.
- Add tenant/user authentication before selling this as a multi-customer SaaS.

## Payments
Payment is intentionally not required for the free test. Add PayPal or a bank-payment confirmation flow only after the AI/channel flow is verified.
