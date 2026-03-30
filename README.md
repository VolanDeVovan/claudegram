# Claudegram

A Telegram bot that acts as an interface to Claude Code. Its key feature is **self-configuration** — all setup happens right inside the Telegram chat, no manual file editing required.

## Stack

Bun, [grammY](https://grammy.dev), [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk), bun:sqlite, LogTape.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Claude Code](https://claude.ai/code) installed and authenticated
- Telegram Bot Token (get one from [@BotFather](https://t.me/BotFather))

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/VolanDeVovan/claudegram.git
cd claudegram

# 2. Install dependencies
bun install

# 3. Start the bot — it will walk you through configuration via Telegram
bun start
```

On first launch the bot runs an interactive setup wizard directly in the chat — it tells you what to configure and applies the settings itself.

## License

MIT
