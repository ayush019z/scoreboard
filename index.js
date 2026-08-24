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

// 2 minutes — suitable for limited CricAPI quota
const UPDATE_INTERVAL_MS = 120000;

if (!TOKEN || !CLIENT_ID || !CRICAPI_KEY) {
  console.error(
    "❌ Missing DISCORD_TOKEN, CLIENT_ID or CRICAPI_KEY"
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Scoreboards currently being tracked
const activeScoreboards = new Map();

// ======================================================
// CRICAPI
// ======================================================

async function fetchCurrentMatches() {
  const url = new URL(
    "https://api.cricapi.com/v1/currentMatches"
  );

  url.searchParams.set("apikey", CRICAPI_KEY);
  url.searchParams.set("offset", "0");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `CricAPI HTTP ${response.status}`
    );
  }

  const json = await response.json();

  if (json.status === "failure") {
    throw new Error(
      json.reason || "CricAPI request failed"
    );
  }

  return Array.isArray(json.data)
    ? json.data
    : [];
}

// ======================================================
// MATCH HELPERS
// ======================================================

function isLive(match) {
  if (
    match.matchStarted &&
    !match.matchEnded
  ) {
    return true;
  }

  const status =
    String(match.status || "")
      .toLowerCase();

  return (
    status.includes("live") ||
    status.includes("rain") ||
    status.includes("delay") ||
    status.includes("innings break") ||
    status.includes("innings interval")
  );
}

function getLiveMatches(matches) {
  return matches.filter(isLive);
}

function currentInnings(match) {
  if (
    !Array.isArray(match.score) ||
    match.score.length === 0
  ) {
    return null;
  }

  return match.score[
    match.score.length - 1
  ];
}

function currentOver(match) {
  const innings =
    currentInnings(match);

  return innings?.o ?? null;
}

function shorten(text, max = 100) {
  const value =
    String(text || "");

  if (value.length <= max) {
    return value;
  }

  return (
    value.slice(0, max - 1) +
    "…"
  );
}

// IMPORTANT:
// Status is included so rain/delay changes
// update Discord even if the score doesn't change.
function matchSignature(match) {
  return JSON.stringify({
    score: match.score || [],
    status: match.status || "",
    started: match.matchStarted,
    ended: match.matchEnded,
  });
}

// ======================================================
// MATCH STATE
// ======================================================

function getMatchState(
  match,
  stopped = false
) {
  if (stopped) {
    return {
      label:
        "⚪ SCOREBOARD STOPPED",
      color: 0x808080,
    };
  }

  const status =
    String(match.status || "")
      .toLowerCase();

  // RAIN
  if (
    status.includes("rain") ||
    status.includes("wet outfield")
  ) {
    return {
      label:
        "🌧️ PLAY STOPPED • RAIN DELAY",
      color: 0x3498db,
    };
  }

  // INNINGS BREAK
  if (
    status.includes(
      "innings break"
    ) ||
    status.includes(
      "innings interval"
    )
  ) {
    return {
      label:
        "⏸️ INNINGS BREAK",
      color: 0xf1c40f,
    };
  }

  // OTHER DELAYS
  if (
    status.includes("delay") ||
    status.includes("delayed")
  ) {
    return {
      label:
        "⏳ MATCH DELAYED",
      color: 0xe67e22,
    };
  }

  // FINISHED
  if (match.matchEnded) {
    return {
      label:
        "🏁 MATCH FINISHED",
      color: 0x95a5a6,
    };
  }

  // NORMAL LIVE MATCH
  return {
    label: "🔴 LIVE",
    color: 0x2ecc71,
  };
}

// ======================================================
// TEAM HELPERS
// ======================================================

function getTeams(match) {
  if (
    Array.isArray(match.teams) &&
    match.teams.length >= 2
  ) {
    return [
      match.teams[0],
      match.teams[1],
    ];
  }

  // Fallback if API doesn't provide teams[]
  const parts =
    String(match.name || "")
      .split(/\s+vs\s+/i)
      .map((x) => x.trim())
      .filter(Boolean);

  if (parts.length >= 2) {
    return [
      parts[0],
      parts[1],
    ];
  }

  return [
    "Team 1",
    "Team 2",
  ];
}

function inningsForTeam(
  match,
  team
) {
  if (
    !Array.isArray(match.score)
  ) {
    return [];
  }

  const teamName =
    String(team)
      .toLowerCase();

  return match.score.filter(
    (innings) =>
      String(
        innings.inning || ""
      )
        .toLowerCase()
        .includes(teamName)
  );
}

// ======================================================
// SCORE DISPLAY
// ======================================================

function formatTeamScore(
  team,
  inningsList
) {
  if (!inningsList.length) {
    return (
      `**${team}**\n` +
      `*Yet to bat*`
    );
  }

  return inningsList
    .map((innings) => {
      const runs =
        innings.r ?? 0;

      const wickets =
        innings.w ?? 0;

      const overs =
        innings.o ?? 0;

      return (
        `**${team}**\n` +
        `## ${runs}/${wickets}\n` +
        `**${overs} overs**`
      );
    })
    .join("\n");
}

// ======================================================
// SCOREBOARD EMBED
// ======================================================

function buildScoreEmbed(
  match,
  stopped = false
) {
  const state =
    getMatchState(
      match,
      stopped
    );

  const [
    team1,
    team2,
  ] = getTeams(match);

  const team1Innings =
    inningsForTeam(
      match,
      team1
    );

  const team2Innings =
    inningsForTeam(
      match,
      team2
    );

  const title =
    match.name ||
    `${team1} vs ${team2}`;

  const sections = [
    state.label,

    match.status
      ? `> ${match.status}`
      : null,

    "",

    formatTeamScore(
      team1,
      team1Innings
    ),

    "",

    formatTeamScore(
      team2,
      team2Innings
    ),
  ];

  const description =
    sections
      .filter(
        (item) =>
          item !== null
      )
      .join("\n");

  const embed =
    new EmbedBuilder()

      .setTitle(
        `🏏 ${shorten(
          title,
          240
        )}`
      )

      .setDescription(
        description
      )

      .setColor(
        state.color
      );

  // FORMAT
  if (match.matchType) {
    embed.addFields({
      name: "🏏 Format",
      value:
        String(
          match.matchType
        ).toUpperCase(),
      inline: true,
    });
  }

  // VENUE
  if (match.venue) {
    embed.addFields({
      name: "🏟️ Venue",
      value:
        shorten(
          match.venue,
          1024
        ),
      inline: true,
    });
  }

  embed
    .setFooter({
      text: stopped
        ? "Live updates ended"
        : "Over-by-over scoreboard • CricAPI",
    })
    .setTimestamp();

  return embed;
}

// ======================================================
// SLASH COMMANDS
// ======================================================

const commands = [
  new SlashCommandBuilder()

    .setName("livesb")

    .setDescription(
      "Start a live cricket scoreboard"
    ),

  new SlashCommandBuilder()

    .setName("stopsb")

    .setDescription(
      "Stop a live cricket scoreboard"
    ),
].map(
  (command) =>
    command.toJSON()
);

// ======================================================
// REGISTER GLOBAL COMMANDS
// ======================================================

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
    "✅ Global slash commands registered"
  );
}

// ======================================================
// /livesb
// ======================================================

async function handleLiveSB(
  interaction
) {
  await interaction.deferReply({
    ephemeral: true,
  });

  try {
    const matches =
      await fetchCurrentMatches();

    const liveMatches =
      getLiveMatches(matches);

    if (
      liveMatches.length === 0
    ) {
      return interaction.editReply(
        "🏏 No live matches found."
      );
    }

    const shown =
      liveMatches.slice(
        0,
        25
      );

    const menu =
      new StringSelectMenuBuilder()

        .setCustomId(
          `livesb:${interaction.user.id}`
        )

        .setPlaceholder(
          "🏏 Select a live match"
        )

        .addOptions(
          shown.map(
            (match) => ({
              label:
                shorten(
                  match.name ||
                    "Live match",
                  100
                ),

              description:
                shorten(
                  match.status ||
                    match.matchType ||
                    "Live",
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
        .addComponents(
          menu
        );

    await interaction.editReply({
      content:
        `🔴 **${liveMatches.length} live match${
          liveMatches.length === 1
            ? ""
            : "es"
        } found**\n\nChoose a match:`,

      components: [
        row,
      ],
    });

  } catch (error) {
    console.error(
      "/livesb error:",
      error
    );

    await interaction.editReply(
      `❌ CricAPI error: ${error.message}`
    );
  }
}

// ======================================================
// MATCH SELECTED
// ======================================================

async function handleMatchSelect(
  interaction
) {
  const [, ownerId] =
    interaction.customId
      .split(":");

  if (
    interaction.user.id !==
    ownerId
  ) {
    return interaction.reply({
      content:
        "Only the person who used `/livesb` can select this match.",

      ephemeral: true,
    });
  }

  await interaction.deferUpdate();

  try {
    const matchId =
      interaction.values[0];

    const matches =
      await fetchCurrentMatches();

    const match =
      matches.find(
        (m) =>
          String(m.id) ===
          String(matchId)
      );

    if (!match) {
      return interaction.editReply({
        content:
          "❌ Match is no longer available.",

        components: [],
      });
    }

    // Send scoreboard
    const message =
      await interaction.channel.send({
        embeds: [
          buildScoreEmbed(
            match
          ),
        ],
      });

    // Store scoreboard
    activeScoreboards.set(
      message.id,
      {
        channelId:
          message.channelId,

        matchId:
          String(
            matchId
          ),

        lastSignature:
          matchSignature(
            match
          ),

        lastOver:
          currentOver(
            match
          ),

        lastMatch:
          match,
      }
    );

    await interaction.editReply({
      content:
        `✅ **Live scoreboard started**\n${message.url}`,

      components: [],
    });

  } catch (error) {
    console.error(
      "Match selection error:",
      error
    );

    await interaction.editReply({
      content:
        `❌ Couldn't start scoreboard: ${error.message}`,

      components: [],
    });
  }
}

// ======================================================
// /stopsb
// ======================================================

async function handleStopSB(
  interaction
) {
  const boards =
    [
      ...activeScoreboards.entries(),
    ].filter(
      ([, board]) =>
        board.channelId ===
        interaction.channelId
    );

  if (
    boards.length === 0
  ) {
    return interaction.reply({
      content:
        "There is no active scoreboard in this channel.",

      ephemeral: true,
    });
  }

  const [
    messageId,
    board,
  ] = boards[0];

  activeScoreboards.delete(
    messageId
  );

  try {
    const message =
      await interaction.channel
        .messages
        .fetch(
          messageId
        );

    await message.edit({
      embeds: [
        buildScoreEmbed(
          board.lastMatch,
          true
        ),
      ],
    });

  } catch (error) {
    console.error(
      "Stop scoreboard edit error:",
      error
    );
  }

  await interaction.reply({
    content:
      "🛑 Live scoreboard stopped.",

    ephemeral: true,
  });
}

// ======================================================
// AUTOMATIC SCORE REFRESH
// ======================================================

async function refreshScoreboards() {
  console.log(
    `🔄 Refresh | Active: ${activeScoreboards.size} | ${new Date().toISOString()}`
  );

  // IMPORTANT:
  // No API requests when there are
  // no active scoreboards.
  if (
    activeScoreboards.size === 0
  ) {
    return;
  }

  let matches;

  try {
    matches =
      await fetchCurrentMatches();

    console.log(
      `✅ CricAPI returned ${matches.length} matches`
    );

  } catch (error) {
    console.error(
      "❌ CricAPI refresh error:",
      error
    );

    return;
  }

  const matchMap =
    new Map(
      matches.map(
        (match) => [
          String(
            match.id
          ),
          match,
        ]
      )
    );

  for (
    const [
      messageId,
      board,
    ]
    of activeScoreboards
  ) {
    const match =
      matchMap.get(
        board.matchId
      );

    if (!match) {
      console.log(
        `⚠️ Match ${board.matchId} not found`
      );

      continue;
    }

    const signature =
      matchSignature(
        match
      );

    // Score AND status unchanged.
    // Don't waste a Discord edit.
    if (
      signature ===
      board.lastSignature
    ) {
      console.log(
        `⏸️ No change: ${match.name}`
      );

      continue;
    }

    console.log(
      `🏏 Match updated: ${match.name}`
    );

    board.lastSignature =
      signature;

    board.lastOver =
      currentOver(
        match
      );

    board.lastMatch =
      match;

    try {
      const channel =
        await client.channels.fetch(
          board.channelId
        );

      if (
        !channel ||
        !channel.isTextBased()
      ) {
        continue;
      }

      const message =
        await channel.messages.fetch(
          messageId
        );

      await message.edit({
        embeds: [
          buildScoreEmbed(
            match
          ),
        ],
      });

      // Finished match
      if (
        match.matchEnded
      ) {
        activeScoreboards.delete(
          messageId
        );

        console.log(
          `🏁 Match ended: ${match.name}`
        );
      }

    } catch (error) {
      console.error(
        "❌ Scoreboard update error:",
        error
      );
    }
  }
}

// ======================================================
// INTERACTIONS
// ======================================================

client.on(
  "interactionCreate",

  async (
    interaction
  ) => {
    try {
      // Slash commands
      if (
        interaction
          .isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          "livesb"
        ) {
          return handleLiveSB(
            interaction
          );
        }

        if (
          interaction.commandName ===
          "stopsb"
        ) {
          return handleStopSB(
            interaction
          );
        }
      }

      // Match dropdown
      if (
        interaction
          .isStringSelectMenu()
      ) {
        if (
          interaction.customId
            .startsWith(
              "livesb:"
            )
        ) {
          return handleMatchSelect(
            interaction
          );
        }
      }

    } catch (error) {
      console.error(
        "Interaction error:",
        error
      );

      if (
        !interaction
          .isRepliable()
      ) {
        return;
      }

      const response = {
        content:
          "❌ Something went wrong.",

        ephemeral: true,
      };

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction
          .followUp(
            response
          )
          .catch(
            () => {}
          );

      } else {
        await interaction
          .reply(
            response
          )
          .catch(
            () => {}
          );
      }
    }
  }
);

// ======================================================
// BOT READY
// ======================================================

client.once(
  "clientReady",

  () => {
    console.log(
      `✅ Logged in as ${client.user.tag}`
    );

    console.log(
      "🏏 Cricket scoreboard ready"
    );

    console.log(
      "🔄 Refresh interval: 2 minutes"
    );

    setInterval(
      refreshScoreboards,
      UPDATE_INTERVAL_MS
    );
  }
);

// ======================================================
// START
// ======================================================

(async () => {
  try {
    await registerCommands();

    await client.login(
      TOKEN
    );

  } catch (error) {
    console.error(
      "❌ Startup error:",
      error
    );

    process.exit(1);
  }
})();
