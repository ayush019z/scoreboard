# Cricket Live Score Discord Bot

A clean Discord bot using CricAPI's `/v1/cricScore` endpoint.

## Commands

- `/livesb` — fetches CricAPI, shows live matches in a dropdown, then starts an updating scoreboard.
- `/stopsb` — stops an active scoreboard in the current channel.

## 1. Create your Discord bot

In the Discord Developer Portal:

1. Create an application.
2. Open **Bot** and create/copy the bot token.
3. Copy the **Application ID** from General Information.
4. Invite the bot with `bot` and `applications.commands` scopes.
5. Give it permission to View Channels, Send Messages and Embed Links.

## 2. Environment variables

Do **not** put tokens or API keys in `index.js`.

Set:

```env
DISCORD_TOKEN=...
CLIENT_ID=...
GUILD_ID=...
CRICAPI_KEY=...
UPDATE_INTERVAL_MS=900000
```

`GUILD_ID` is optional. If set, slash commands are registered immediately to that server.
Without it, global command registration can take longer to appear.

## 3. Install and run locally

```bash
npm install
npm start
```

## 4. Railway

Upload/push these files, then add the environment variables in Railway.

Start command:

```bash
npm start
```

No public web server/port is required for this Discord gateway bot.

## CricAPI quota

The CricketData/CricAPI documentation says the free tier has a daily request quota.
`900000` ms = 15 minutes, or about 96 scheduled refreshes/day if a scoreboard runs
all day, plus requests used by `/livesb` and selections.

If you have a larger quota, examples:

- `300000` = 5 minutes
- `60000` = 1 minute

The bot enforces a minimum of 60 seconds.

## Notes

The bot currently uses the simplified `cricScore` data:
- team names
- compact team scores
- match status
- format
- series when supplied by the API

Detailed current batters/bowlers need a richer match/scorecard endpoint and can be added next.
