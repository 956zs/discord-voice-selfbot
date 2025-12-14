# Discord Voice Channel Selfbot

A simple selfbot that keeps your Discord account always connected to a specific voice channel.

## Features

- Auto-join specified voice channel on startup
- Auto-reconnect when disconnected or moved
- **Smart pause**: When you manually join the channel, the bot pauses automatically
- Resume control via command

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   
   Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

   ```env
   DISCORD_TOKEN=your_discord_token
   GUILD_ID=your_server_id
   CHANNEL_ID=your_voice_channel_id
   ```

3. **Run the bot**
   ```bash
   npm start
   ```

## Commands

| Command | Description |
|---------|-------------|
| `&povv` | Resume bot and rejoin channel |
| `!vc pause` | Pause bot and leave channel |
| `!vc status` | Check current status |

> Commands are auto-deleted after execution.

## Requirements

- Node.js >= 18.0.0
- npm >= 7.0.0
