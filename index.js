const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require("discord.js");

require("dotenv").config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CRICAPI_KEY = process.env.CRICAPI_KEY;

// Default: update every 15 minutes.
// Change UPDATE_INTERVAL_MS in Railway if your API quota allows faster updates.
const UPDATE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.UPDATE_INTERVAL_MS || 900_000)
);

if (!TOKEN || !CLIENT_ID || !CRICAPI_KEY) {
  console.error(
    "Missing environment variables. Required: DISCORD_TOKEN, CLIENT_ID, CRICAPI_KEY"
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Active live scoreboards
// Key = Discord scoreboard message ID
const activeScoreboards = new Map();

function shorten(text, max = 100) {
  const value = String(text || "");

  return value.length > max
    ? `${value.slice(0, max - 1)}…`
    : value;
}

function matchTitle(match) {
  return (
    match.name ||
    [match.t1, match.t2].filter(Boolean).join(" vs ") ||
    "Cricket Match"
  );
}

function isLive(match) {
  const ms = String(match.ms || "").toLowerCase();
  const status = String(match.status || "").toLowerCase();

  return (
    ms === "live" ||
    status.includes("live") ||
    status.includes("in progress") ||
    status.includes("innings break") ||
    status.includes("rain")
  );
}

// ==============================
// CRICAPI
// ==============================

async function fetchCricScore() {
  const url = new URL(
    "https://api.cricapi.com/v1/cricScore"
  );

  url.searchParams.set(
    "apikey",
    CRICAPI_KEY
  );

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `CricAPI HTTP ${response.status}: ${response.statusText}`
    );
  }

  const payload = await response.json();

  if (
    payload.status &&
    String(payload.status).toLowerCase() === "failure"
  ) {
    throw new Error(
      payload.reason || "CricAPI returned failure"
    );
  }

  if (!Array.isArray(payload.data)) {
    throw new Error(
      "Unexpected CricAPI response: data is not an array."
    );
  }

  return payload.data;
}

async function getLiveMatches() {
  const matches = await fetchCricScore();

  return matches.filter(isLive);
}

async function getMatchById(matchId) {
  const matches = await fetchCricScore();

  return (
    matches.find(
      (match) =>
        String(match.id) === String(matchId)
    ) || null
  );
}

// ==============================
// SCOREBOARD EMBED
// ==============================

function scoreText(score) {
  if (
    score === undefined ||
    score === null ||
    score === ""
  ) {
    return "Yet to bat";
  }

  return String(score);
}

function buildScoreEmbed(match, stopped = false) {
  const title = matchTitle(match);

  const team1 =
    match.t1 || "Team 1";

  const team2 =
    match.t2 || "Team 2";

  const embed = new EmbedBuilder()
    .setTitle(
      `🏏 ${shorten(title, 240)}`
    )

    .addFields(
      {
        name: shorten(team1, 256),
        value: `**${scoreText(match.t1s)}**`,
        inline: true,
      },

      {
        name: shorten(team2, 256),
        value: `**${scoreText(match.t2s)}**`,
        inline: true,
      },

      {
        name: "Status",
        value: shorten(
          match.status ||
            match.ms ||
            "Live",
          1024
        ),
        inline: false,
      }
    )

    .setFooter({
      text: stopped
        ? "Live updates stopped • CricAPI"
        : `Auto-updating • every ${Math.round(
            UPDATE_INTERVAL_MS / 60000
          )} min • CricAPI`,
    })

    .setTimestamp();

  if (match.matchType) {
    embed.addFields({
      name: "Format",
      value: String(
        match.matchType
      ).toUpperCase(),
      inline: true,
    });
  }

  if (match.series) {
    embed.addFields({
      name: "Series",
      value: shorten(
        match.series,
        1024
      ),
      inline: true,
    });
  }

  if (match.t1img) {
    try {
      embed.setThumbnail(
        match.t1img
      );
    } catch {}
  }

  return embed;
}

function buildStoppedEmbed(
  match,
  reason
) {
  const embed =
    buildScoreEmbed(
      match,
      true
    );

  embed.addFields({
    name: "Updater",
    value: reason,
    inline: false,
  });

  return embed;
}

// ==============================
// SLASH COMMANDS
// ==============================

const commands = [
  new SlashCommandBuilder()
    .setName("livesb")
    .setDescription(
      "Choose a live cricket match and start a live scoreboard"
    ),

  new SlashCommandBuilder()
    .setName("stopsb")
    .setDescription(
      "Stop a live scoreboard in this channel"
    ),
].map((command) =>
  command.toJSON()
);

// ==============================
// REGISTER GLOBAL COMMANDS
// ==============================

async function registerCommands() {
  const rest =
    new REST({
      version: "10",
    }).setToken(TOKEN);

  await rest.put(
    Routes.applicationCommands(
      CLIENT_ID
    ),
    {
      body: commands,
    }
  );

  console.log(
    "✅ Registered global slash commands"
  );
}

// ==============================
// /livesb
// ==============================

async function handleLiveScoreCommand(
  interaction
) {
  await interaction.deferReply({
    ephemeral: true,
  });

  try {
    const matches =
      await getLiveMatches();

    if (!matches.length) {
      return interaction.editReply(
        "🏏 No live matches were found by CricAPI right now."
      );
    }

    // Discord menus support max 25 options
    const shown =
      matches.slice(0, 25);

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(
          `livesb_select:${interaction.user.id}`
        )

        .setPlaceholder(
          "Choose a live match"
        )

        .addOptions(
          shown.map(
            (match) => ({
              label: shorten(
                [
                  match.t1,
                  match.t2,
                ]
                  .filter(Boolean)
                  .join(" vs ") ||
                  matchTitle(
                    match
                  ),
                100
              ),

              description:
                shorten(
                  match.status ||
                    match.series ||
                    match.matchType ||
                    "Live match",
                  100
                ),

              value:
                String(
                  match.id
                ),
            })
          )
        );

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    await interaction.editReply({
      content:
        matches.length > 25
          ? `Found ${matches.length} live matches. Showing the first 25:`
          : `Found ${matches.length} live match${
              matches.length === 1
                ? ""
                : "es"
            }:`,
      components: [row],
    });

  } catch (error) {
    console.error(
      "/livesb error:",
      error
    );

    await interaction.editReply(
      `❌ Couldn't load live matches.\n\`${shorten(
        error.message,
        1500
      )}\``
    );
  }
}

// ==============================
// MATCH SELECTED
// ==============================

async function handleMatchSelection(
  interaction
) {
  const [, ownerId] =
    interaction.customId.split(
      ":"
    );

  if (
    interaction.user.id !==
    ownerId
  ) {
    return interaction.reply({
      content:
        "Only the person who ran `/livesb` can use this menu.",
      ephemeral: true,
    });
  }

  await interaction.deferUpdate();

  const matchId =
    interaction.values[0];

  try {
    const match =
      await getMatchById(
        matchId
      );

    if (!match) {
      return interaction.editReply({
        content:
          "❌ That match is no longer available from CricAPI.",
        components: [],
      });
    }

    const scoreboardMessage =
      await interaction.channel.send({
        embeds: [
          buildScoreEmbed(
            match
          ),
        ],
      });

    activeScoreboards.set(
      scoreboardMessage.id,
      {
        channelId:
          scoreboardMessage.channelId,

        matchId:
          String(matchId),

        lastMatch:
          match,
      }
    );

    await interaction.editReply({
      content:
        `✅ Live scoreboard started: ${scoreboardMessage.url}`,

      components: [],
    });

  } catch (error) {
    console.error(
      "Selection error:",
      error
    );

    await interaction.editReply({
      content:
        `❌ Couldn't start scoreboard.\n\`${shorten(
          error.message,
          1500
        )}\``,

      components: [],
    });
  }
}

// ==============================
// /stopsb
// ==============================

async function handleStopScoreboard(
  interaction
) {
  const inThisChannel =
    [
      ...activeScoreboards.entries(),
    ].filter(
      ([, data]) =>
        data.channelId ===
        interaction.channelId
    );

  if (
    !inThisChannel.length
  ) {
    return interaction.reply({
      content:
        "There are no active scoreboards in this channel.",
      ephemeral: true,
    });
  }

  // Only one scoreboard
  if (
    inThisChannel.length === 1
  ) {
    const [
      messageId,
      data,
    ] = inThisChannel[0];

    activeScoreboards.delete(
      messageId
    );

    try {
      const message =
        await interaction.channel.messages.fetch(
          messageId
        );

      await message.edit({
        embeds: [
          buildStoppedEmbed(
            data.lastMatch,
            "Stopped manually with /stopsb."
          ),
        ],
      });

    } catch {}

    return interaction.reply({
      content:
        "🛑 Live scoreboard stopped.",
      ephemeral: true,
    });
  }

  // Multiple scoreboards
  const menu =
    new StringSelectMenuBuilder()

      .setCustomId(
        `stopsb_select:${interaction.user.id}`
      )

      .setPlaceholder(
        "Choose a scoreboard to stop"
      )

      .addOptions(
        inThisChannel
          .slice(0, 25)
          .map(
            ([
              messageId,
              data,
            ]) => ({
              label:
                shorten(
                  matchTitle(
                    data.lastMatch
                  ),
                  100
                ),

              description:
                shorten(
                  data.lastMatch
                    .status ||
                    "Live scoreboard",
                  100
                ),

              value:
                messageId,
            })
          )
      );

  return interaction.reply({
    content:
      "Choose the scoreboard you want to stop:",

    components: [
      new ActionRowBuilder()
        .addComponents(
          menu
        ),
    ],

    ephemeral: true,
  });
}

// ==============================
// STOP MENU
// ==============================

async function handleStopSelection(
  interaction
) {
  const [, ownerId] =
    interaction.customId.split(
      ":"
    );

  if (
    interaction.user.id !==
    ownerId
  ) {
    return interaction.reply({
      content:
        "Only the person who ran `/stopsb` can use this menu.",
      ephemeral: true,
    });
  }

  const messageId =
    interaction.values[0];

  const data =
    activeScoreboards.get(
      messageId
    );

  if (!data) {
    return interaction.update({
      content:
        "That scoreboard is already stopped.",
      components: [],
    });
  }

  activeScoreboards.delete(
    messageId
  );

  try {
    const message =
      await interaction.channel.messages.fetch(
        messageId
      );

    await message.edit({
      embeds: [
        buildStoppedEmbed(
          data.lastMatch,
          "Stopped manually with /stopsb."
        ),
      ],
    });

  } catch {}

  return interaction.update({
    content:
      "🛑 Live scoreboard stopped.",

    components: [],
  });
}

// ==============================
// AUTOMATIC REFRESH
// ==============================

async function refreshAllScoreboards() {
  if (
    !activeScoreboards.size
  ) {
    return;
  }

  let matches;

  try {
    // One API request refreshes every
    // currently active scoreboard.
    matches =
      await fetchCricScore();

  } catch (error) {
    console.error(
      "Scoreboard refresh API error:",
      error
    );

    return;
  }

  const byId =
    new Map(
      matches.map(
        (match) => [
          String(match.id),
          match,
        ]
      )
    );

  for (
    const [
      messageId,
      board,
    ] of activeScoreboards
  ) {
    try {
      const channel =
        await client.channels.fetch(
          board.channelId
        );

      if (
        !channel ||
        !channel.isTextBased()
      ) {
        activeScoreboards.delete(
          messageId
        );

        continue;
      }

      const message =
        await channel.messages
          .fetch(messageId)
          .catch(
            () => null
          );

      if (!message) {
        activeScoreboards.delete(
          messageId
        );

        continue;
      }

      const match =
        byId.get(
          board.matchId
        );

      if (!match) {
        activeScoreboards.delete(
          messageId
        );

        await message.edit({
          embeds: [
            buildStoppedEmbed(
              board.lastMatch,
              "Match disappeared from the CricAPI score feed."
            ),
          ],
        });

        continue;
      }

      board.lastMatch =
        match;

      // Match finished
      if (!isLive(match)) {
        activeScoreboards.delete(
          messageId
        );

        await message.edit({
          embeds: [
            buildStoppedEmbed(
              match,
              "Match is no longer live. Automatic updates ended."
            ),
          ],
        });

        continue;
      }

      // Update scoreboard
      await message.edit({
        embeds: [
          buildScoreEmbed(
            match
          ),
        ],
      });

    } catch (error) {
      console.error(
        `Refresh failed for message ${messageId}:`,
        error
      );
    }
  }
}

// ==============================
// INTERACTIONS
// ==============================

client.on(
  "interactionCreate",
  async (interaction) => {
    try {
      if (
        interaction.isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          "livesb"
        ) {
          return handleLiveScoreCommand(
            interaction
          );
        }

        if (
          interaction.commandName ===
          "stopsb"
        ) {
          return handleStopScoreboard(
            interaction
          );
        }
      }

      if (
        interaction.isStringSelectMenu()
      ) {
        if (
          interaction.customId.startsWith(
            "livesb_select:"
          )
        ) {
          return handleMatchSelection(
            interaction
          );
        }

        if (
          interaction.customId.startsWith(
            "stopsb_select:"
          )
        ) {
          return handleStopSelection(
            interaction
          );
        }
      }

    } catch (error) {
      console.error(
        "Interaction handler error:",
        error
      );

      if (
        !interaction.isRepliable()
      ) {
        return;
      }

      const payload = {
        content:
          "❌ Something went wrong while handling that interaction.",
        ephemeral: true,
      };

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction
          .followUp(payload)
          .catch(() => {});

      } else {
        await interaction
          .reply(payload)
          .catch(() => {});
      }
    }
  }
);

// ==============================
// BOT READY
// ==============================

client.once(
  "clientReady",
  () => {
    console.log(
      `✅ Logged in as ${client.user.tag}`
    );

    console.log(
      `🔄 Scoreboard refresh: every ${Math.round(
        UPDATE_INTERVAL_MS /
          60000
      )} minute(s)`
    );

    setInterval(
      refreshAllScoreboards,
      UPDATE_INTERVAL_MS
    );
  }
);

// ==============================
// START BOT
// ==============================

(async () => {
  try {
    await registerCommands();

    await client.login(
      TOKEN
    );

  } catch (error) {
    console.error(
      "Fatal startup error:",
      error
    );

    process.exit(1);
  }
})();
