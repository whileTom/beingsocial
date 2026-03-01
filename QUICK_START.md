# 🚀 Quick Start - Multi-Key Setup

## Your `.env` File Format

```bash
# Your 4 Gemini API keys (comma-separated, NO SPACES)
GEMINI_API_KEYS=AIzaSyAbc123...,AIzaSyDef456...,AIzaSyGhi789...,AIzaSyJkl012...

# Models for each key (comma-separated)
GEMINI_MODELS=gemini-2.0-flash-exp,gemini-1.5-flash,gemini-1.5-flash,gemini-1.5-flash

# Rate limits
GEMINI_DAILY_LIMIT=20
GEMINI_MINUTE_LIMIT=5

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Leave these empty unless you want other providers
AI_PROVIDER=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

## Testing

```bash
# Restart the bot
npm run dev
```

Look for logs like:
```
🤖 Using AI provider: GEMINI
📊 gemini-0 (gemini-2.0-flash-exp): 1/5 req/min, 1/20 req/day
```

This means it's working! The bot will automatically rotate through all 4 keys.

## Capacity Check

With your setup:
- **4 keys × 20 requests/day = 80 total requests/day**
- **Rotates every 5 minutes** to stay under per-minute limits
- **Completely free!**

Perfect for 30-50 messages per day of personal use.
