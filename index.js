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

// 2 minutes
const UPDATE_INTERVAL_MS = 120000;

if (!TOKEN || !CLIENT_ID || !CRICAPI_KEY) {
  console.error(
    "Missing DISCORD_TOKEN, CLIENT_ID or CRICAPI_KEY"
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const activeScoreboards = new Map();

// =========================
// API
// =========================

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

// =========================
// HELPERS
// =========================

function isLive(match) {
  if (match.matchStarted && !match.matchEnded) {
    return true;
  }

  const status =
    String(match.status || "").toLowerCase();

  return (
    status.includes("live") ||
    status.includes("innings break") ||
    status.includes("rain")
  );
}

function getLiveMatches(matches) {
  return matches.filter(isLive);
}

function currentInnings(match) {
  if (!Array.isArray(match.score)) {
    return null;
  }

  if (!match.score.length) {
    return null;
  }

  return match.score[
    match.score.length - 1
  ];
}

function currentOver(match) {
  const innings =
    currentInnings(match);

  if (!innings) {
    return null;
  }

  return innings.o ?? null;
}

function scoreSignature(match) {
  if (!Array.isArray(match.score)) {
    return "";
  }

  return JSON.stringify(
    match.score.map((innings) => ({
      r: innings.r,
      w: innings.w,
      o: innings.o,
      inning: innings.inning,
    }))
  );
}

function shorten(text, max = 100) {
  text = String(text || "");

  if (text.length <= max) {
    return text;
  }

  return text.slice(0, max - 1) + "…";
}

// =========================
// SCORE FORMATTING
// =========================

function formatInnings(match) {
  if (
    !Array.isArray(match.score) ||
    match.score.length === 0
  ) {
    return "Score not available yet.";
  }

  return match.score
    .map((innings) => {
      const name =
        innings.inning ||
        "Innings";

      const runs =
        innings.r ?? 0;

      const wickets =
        innings.w ?? 0;

      const overs =
        innings.o ?? 0;

      return (
        `**${name}**\n` +
        `🏏 **${runs}/${wickets}**  •  ${overs} overs`
      );
    })
    .join("\n\n");
}

// =========================
// EMBED
// =========================

function buildScoreEmbed(match, stopped = false) {
  const current =
    currentInnings(match);

  const embed = new EmbedBuilder()
    .setTitle(
      `🏏 ${shorten(
        match.name || "Live Cricket",
        240
      )}`
    )

    .setDescription(
      stopped
        ? "⚪ **Updates stopped**"
        : `🔴 **LIVE**\n${
            match.status ||
            "Match in progress"
          }`
    )

    .addFields({
      name: "📊 SCORECARD",
      value: formatInnings(match),
      inline: false,
    });

  if (current) {
    embed.addFields({
      name: "🔥 Current Innings",
      value:
        `**${
          current.inning ||
          "Current innings"
        }**\n` +
        `### ${current.r ?? 0}/${
          current.w ?? 0
        }\n` +
        `**${current.o ?? 0} overs**`,
      inline: false,
    });
  }

  if (match.matchType) {
    embed.addFields({
      name: "Format",
      value:
        String(
          match.matchType
        ).toUpperCase(),
      inline: true,
    });
  }

  if (match.venue) {
    embed.addFields({
      name: "Venue",
      value: shorten(
        match.venue,
        1024
      ),
      inline: true,
    });
  }

  embed
    .setFooter({
      text: stopped
        ? "Scoreboard stopped"
        : "Over-by-over scoreboard • CricAPI",
    })
    .setTimestamp();

  return embed;
}

// =========================
// COMMANDS
// =========================

const commands = [
  new SlashCommandBuilder()
    .setName("livesb")
    .setDescription(
      "Start a live cricket scoreboard"
    ),

  new SlashCommandBuilder()
    .setName("stopsb")
    .setDescription(
      "Stop a live scoreboard"
    ),
].map((command) =>
  command.toJSON()
);

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

// =========================
// /livesb
// =========================

async function handleLiveSB(interaction) {
  await interaction.deferReply({
    ephemeral: true,
  });

  try {
    const matches =
      await fetchCurrentMatches();

    const liveMatches =
      getLiveMatches(matches);

    if (!liveMatches.length) {
      return interaction.editReply(
        "🏏 No live matches found."
      );
    }

    const shown =
      liveMatches.slice(0, 25);

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(
          `livesb:${interaction.user.id}`
        )
        .setPlaceholder(
          "Select a live match"
        )
        .addOptions(
          shown.map((match) => ({
            label: shorten(
              match.name ||
              "Live match",
              100
            ),

            description: shorten(
              match.status ||
              match.matchType ||
              "Live",
              100
            ),

            value:
              String(match.id),
          }))
        );

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    await interaction.editReply({
      content:
        `🏏 Found ${liveMatches.length} live match${
          liveMatches.length === 1
            ? ""
            : "es"
        }.`,
      components: [row],
    });

  } catch (error) {
    console.error(error);

    await interaction.editReply(
      `❌ Error: ${error.message}`
    );
  }
}

// =========================
// SELECT MATCH
// =========================

async function handleMatchSelect(
  interaction
) {
  const [, ownerId] =
    interaction.customId.split(":");

  if (
    interaction.user.id !==
    ownerId
  ) {
    return interaction.reply({
      content:
        "Only the person who used `/livesb` can choose this match.",
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
          "❌ Match not found anymore.",
        components: [],
      });
    }

    const message =
      await interaction.channel.send({
        embeds: [
          buildScoreEmbed(match),
        ],
      });

    activeScoreboards.set(
      message.id,
      {
        channelId:
          message.channelId,

        matchId:
          String(matchId),

        lastScoreSignature:
          scoreSignature(match),

        lastOver:
          currentOver(match),

        lastMatch:
          match,
      }
    );

    await interaction.editReply({
      content:
        `✅ Scoreboard started: ${message.url}`,
      components: [],
    });

  } catch (error) {
    console.error(error);

    await interaction.editReply({
      content:
        `❌ Couldn't start scoreboard: ${error.message}`,
      components: [],
    });
  }
}

// =========================
// /stopsb
// =========================

async function handleStopSB(
  interaction
) {
  const boards =
    [...activeScoreboards.entries()]
      .filter(
        ([, board]) =>
          board.channelId ===
          interaction.channelId
      );

  if (!boards.length) {
    return interaction.reply({
      content:
        "No active scoreboard in this channel.",
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
      await interaction.channel.messages.fetch(
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
  } catch {}

  await interaction.reply({
    content:
      "🛑 Scoreboard stopped.",
    ephemeral: true,
  });
}

// =========================
// AUTO REFRESH
// =========================

async function refreshScoreboards() {
  if (
    activeScoreboards.size === 0
  ) {
    return;
  }

  let matches;

  try {
    matches =
      await fetchCurrentMatches();

  } catch (error) {
    console.error(
      "Refresh API error:",
      error
    );

    return;
  }

  const matchMap =
    new Map(
      matches.map((match) => [
        String(match.id),
        match,
      ])
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
      continue;
    }

    const signature =
      scoreSignature(match);

    const over =
      currentOver(match);

    // Nothing changed
    if (
      signature ===
      board.lastScoreSignature
    ) {
      continue;
    }

    board.lastScoreSignature =
      signature;

    board.lastOver =
      over;

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
          buildScoreEmbed(match),
        ],
      });

      // Match finished
      if (!isLive(match)) {
        activeScoreboards.delete(
          messageId
        );
      }

    } catch (error) {
      console.error(
        "Scoreboard edit error:",
        error
      );
    }
  }
}

// =========================
// INTERACTIONS
// =========================

client.on(
  "interactionCreate",
  async (interaction) => {

    if (
      interaction.isChatInputCommand()
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

    if (
      interaction.isStringSelectMenu()
    ) {
      if (
        interaction.customId.startsWith(
          "livesb:"
        )
      ) {
        return handleMatchSelect(
          interaction
        );
      }
    }
  }
);

// =========================
// READY
// =========================

client.once(
  "clientReady",
  () => {
    console.log(
      `✅ Logged in as ${client.user.tag}`
    );

    console.log(
      "🏏 Live scoreboard ready"
    );

    setInterval(
      refreshScoreboards,
      UPDATE_INTERVAL_MS
    );
  }
);

// =========================
// START
// =========================

(async () => {
  try {
    await registerCommands();

    await client.login(
      TOKEN
    );

  } catch (error) {
    console.error(
      "Startup error:",
      error
    );

    process.exit(1);
  }
})();
