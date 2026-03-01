# Being Social -- AI-Powered Social Media Response Assistant

An AI-powered assistant that monitors your social media messages (WhatsApp and Instagram), generates multiple response suggestions in different styles, and lets you review and send them via Telegram.

## Features

- **Multi-platform monitoring** -- WhatsApp (via whatsapp-web.js) and Instagram (via Puppeteer scraping)
- **Multi-style AI responses** -- generates 5 response options per message: casual, technical, transparent, brief, and detailed
- **Multi-provider AI** -- supports Gemini (free), OpenAI, and Anthropic with automatic failover
- **Gemini multi-key rotation** -- rotate across multiple free API keys to maximize daily capacity
- **Telegram control panel** -- review, edit, regenerate, or skip responses from your phone
- **Voice message transcription** -- automatically transcribes audio messages using Gemini
- **SQLite message history** -- stores conversations locally for context-aware responses
- **Customizable persona** -- define your communication style in a simple template
- **Web dashboard** -- real-time message viewer with Socket.IO

## Architecture

```
Incoming message (WhatsApp / Instagram)
       |
       v
  Monitor detects new message
       |
       v
  AI generates 5 response styles (Gemini -> OpenAI -> Anthropic fallback)
       |
       v
  Telegram notification with action buttons:
    [Approve & Send] [Edit] [Regenerate] [Skip]
       |
       v
  Approved response sent back to original platform
```

### Project Structure

```
being-social/
  src/
    index.ts              # Main entry point and orchestration
    ai/
      index.ts            # Multi-provider AI response generation
      persona.ts          # Customizable persona template
      mock.ts             # Mock AI for testing
    monitors/
      whatsapp.ts         # WhatsApp message monitor
      instagram.ts        # Instagram DM monitor (Puppeteer)
    notifications/
      telegram.ts         # Telegram bot for review/approval
    database/
      index.ts            # SQLite message storage
    dashboard/
      public/index.html   # Real-time web dashboard
    utils/
      rate-limiter.ts     # Per-key rate limiting
      request-queue.ts    # Request queue management
    scripts/              # Utility and debug scripts
  data/                   # Runtime data (gitignored)
  .wwebjs_auth/           # WhatsApp session (gitignored)
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your API keys:

- **GEMINI_API_KEYS** -- comma-separated Gemini API keys (free at [Google AI Studio](https://aistudio.google.com/app/apikey))
- **TELEGRAM_BOT_TOKEN** -- create via [@BotFather](https://t.me/botfather)
- **TELEGRAM_CHAT_ID** -- start your bot and send `/start` to get this
- *Optional:* **OPENAI_API_KEY** or **ANTHROPIC_API_KEY** for fallback providers

See [GEMINI_SETUP.md](GEMINI_SETUP.md) for detailed multi-key setup instructions.

### 3. Customize Your Persona

Edit `src/ai/persona.ts` to define your communication style. The file contains a template with placeholders -- fill in your own details.

### 4. Start the Bot

```bash
npm run dev
```

On first run, a QR code appears in the terminal. Scan it with WhatsApp (Settings > Linked Devices > Link a Device) to connect.

For Instagram, run `npm run login:ig:browser` first to authenticate.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode (auto-restart on changes) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled version |
| `npm run login:ig` | Instagram login (headless) |
| `npm run login:ig:browser` | Instagram login (visible browser) |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Get your chat ID |
| `/status` | Check bot status |

## Requirements

- Node.js 18+
- A Telegram bot (free)
- At least one AI provider API key (Gemini is free)
- Chrome/Chromium (for Instagram Puppeteer monitor)

## License

ISC
