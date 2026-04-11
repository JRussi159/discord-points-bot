require('dotenv').config();

const sqlite3 = require('sqlite3').verbose();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '';
const ADMIN_ROLE_NAME = process.env.ADMIN_ROLE_NAME || 'Point Admin';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const db = new sqlite3.Database('./botdata.sqlite');

const POINTS = {
  Average: 1,
  Substantial: 1,
  Ruthless: 1,
  Lethal: 2,
  Absolute: 3,
  Campaign: 2,
  CampaignHard: 4,
  StratagemNormal: 1,
  StratagemHard: 4,
  TrialNormal: 1,
  TrialLethal: 2,
  TrialAbsolute: 4,
  WPvP: 1,
};

const SIEGE_POINTS = {
  Siege: {
    'waves1-9': 2,
    'waves10-14': 3,
    'waves15-19': 5,
    'waves20-24': 8,
    'waves25-29': 15,
    'waves30plus': 20,
  },
  SiegeHard: {
    'waves1-9': 4,
    'waves10-14': 6,
    'waves15-19': 10,
    'waves20-24': 14,
    'waves25-29': 20,
    'waves30plus': 30,
  },
};

const STANDARD_TYPES = ['Average', 'Substantial', 'Ruthless', 'Lethal', 'Absolute'];
const OTHER_TYPES = [
  'Campaign',
  'CampaignHard',
  'StratagemNormal',
  'StratagemHard',
  'TrialNormal',
  'TrialLethal',
  'TrialAbsolute',
  'WPvP'
];
const SIEGE_TYPES = ['Siege', 'SiegeHard'];
const WAVE_TYPES = ['waves1-9', 'waves10-14', 'waves15-19', 'waves20-24', 'waves25-29', 'waves30plus'];

const slashCommands = [
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the leaderboard'),
  new SlashCommandBuilder()
    .setName('scoreboard')
    .setDescription('Show a user scoreboard')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('User to view')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('points')
    .setDescription('View current point values'),
].map(command => command.toJSON());

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      total_points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      subtype TEXT NOT NULL,
      runs INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, category, subtype)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS mission_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      author_id TEXT NOT NULL,
      difficulty_type TEXT NOT NULL,
      wave_type TEXT,
      points_each INTEGER NOT NULL,
      member_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS mission_log_members (
      mission_log_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS point_overrides (
      guild_id TEXT NOT NULL,
      key_name TEXT NOT NULL,
      points_value INTEGER NOT NULL,
      PRIMARY KEY (guild_id, key_name)
    )
  `);
}

async function registerSlashCommands() {
  if (!CLIENT_ID || !GUILD_ID) {
    console.log('Skipping slash command registration: missing DISCORD_CLIENT_ID or DISCORD_GUILD_ID');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: slashCommands }
  );

  console.log('Slash commands registered.');
}

function normalizeSpaces(text) {
  return text.replace(/\r/g, '').trim();
}

function extractLineValue(content, fieldName) {
  const regex = new RegExp(`^\\s*${fieldName}\\s*:\\s*(.+)$`, 'im');
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return member.roles.cache.some((role) => role.name.toLowerCase() === ADMIN_ROLE_NAME.toLowerCase());
}

function uniqueUsers(users) {
  const seen = new Set();
  return users.filter((user) => {
    if (seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  });
}

async function getOverridePoints(guildId, keyName) {
  const row = await get(
    `SELECT points_value FROM point_overrides WHERE guild_id = ? AND key_name = ?`,
    [guildId, keyName]
  );
  return row ? row.points_value : null;
}

async function resolvePoints(guildId, difficultyType, waveType = null) {
  if (SIEGE_TYPES.includes(difficultyType)) {
    const overrideKey = `${difficultyType}:${waveType}`;
    const override = await getOverridePoints(guildId, overrideKey);
    if (override !== null) return override;
    return SIEGE_POINTS[difficultyType][waveType] ?? null;
  }

  const override = await getOverridePoints(guildId, difficultyType);
  if (override !== null) return override;

  return POINTS[difficultyType] ?? null;
}

function parseRolesFromDifficultyLine(difficultyLine, guild) {
  const roleIds = [...difficultyLine.matchAll(/<@&(\d+)>/g)].map((m) => m[1]);

  const mentionedRoles = roleIds
    .map((id) => guild.roles.cache.get(id))
    .filter(Boolean)
    .map((role) => role.name);

  const mainTypes = mentionedRoles.filter(
    (name) => STANDARD_TYPES.includes(name) || OTHER_TYPES.includes(name) || SIEGE_TYPES.includes(name)
  );

  const waveTypes = mentionedRoles.filter((name) => WAVE_TYPES.includes(name));

  return { mentionedRoles, mainTypes, waveTypes };
}

async function ensureUser(guildId, user) {
  await run(
    `INSERT INTO users (guild_id, user_id, username, total_points)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(guild_id, user_id)
     DO UPDATE SET username = excluded.username`,
    [guildId, user.id, user.username]
  );
}

async function addPointsToUser(guildId, user, category, subtype, points) {
  await ensureUser(guildId, user);

  await run(
    `UPDATE users
     SET total_points = total_points + ?
     WHERE guild_id = ? AND user_id = ?`,
    [points, guildId, user.id]
  );

  await run(
    `INSERT INTO user_stats (guild_id, user_id, category, subtype, runs, points)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(guild_id, user_id, category, subtype)
     DO UPDATE SET
       runs = runs + 1,
       points = points + excluded.points`,
    [guildId, user.id, category, subtype, points]
  );
}

async function removePointsFromUser(guildId, user, amount) {
  await ensureUser(guildId, user);
  await run(
    `UPDATE users
     SET total_points = total_points - ?
     WHERE guild_id = ? AND user_id = ?`,
    [amount, guildId, user.id]
  );
}

function buildScoreboardText(username, totalPoints, rows) {
  const groups = {
  Standard: [],
  'Siege Hard': [],
  'Siege Normal': [],
  Stratagem: [],
  Campaign: [],
  Trial: [],
  PvP: [],
};

  for (const row of rows) {
    if (row.category === 'Standard') {
      groups.Standard.push(`- ${row.subtype}: ${row.runs} runs - ${row.points} points`);
    } else if (row.category === 'SiegeHard') {
      groups['Siege Hard'].push(`- ${row.subtype}: ${row.runs} runs - ${row.points} points`);
    } else if (row.category === 'Siege') {
      groups['Siege Normal'].push(`- ${row.subtype}: ${row.runs} runs - ${row.points} points`);
    } else if (row.category === 'Stratagem') {
      groups.Stratagem.push(`- ${row.subtype}: ${row.runs} runs - ${row.points} points`);
    } else if (row.category === 'Campaign') {
      groups.Campaign.push(`- ${row.subtype}: ${row.runs} runs - ${row.points} points`);
    } else if (row.category === 'Trial') {
      groups.Trial.push(`- ${row.subtype}: ${row.runs} runs - ${row.points} points`);
    } else if (row.category === 'PvP') {
      groups.PvP.push(`- ${row.subtype}: ${row.runs} runs - ${row.points} points`);
    }
  }

  const parts = [`**Scoreboard for ${username}**`, `Total Points: **${totalPoints}**`, ''];

  for (const [title, items] of Object.entries(groups)) {
    if (items.length) {
      parts.push(`**${title}**`);
      parts.push(...items);
      parts.push('');
    }
  }

  return parts.join('\n').trim();
}

async function showScoreboardFromMessage(message, targetUser) {
  const guildId = message.guild.id;

  const userRow = await get(
    `SELECT total_points, username FROM users WHERE guild_id = ? AND user_id = ?`,
    [guildId, targetUser.id]
  );

  const statRows = await all(
    `SELECT category, subtype, runs, points
     FROM user_stats
     WHERE guild_id = ? AND user_id = ?
     ORDER BY category, subtype`,
    [guildId, targetUser.id]
  );

  const totalPoints = userRow ? userRow.total_points : 0;
  const username = targetUser.username;
  const text = buildScoreboardText(username, totalPoints, statRows);

  await message.reply(text);
}

async function showScoreboardFromInteraction(interaction, targetUser) {
  const guildId = interaction.guild.id;

  const userRow = await get(
    `SELECT total_points, username FROM users WHERE guild_id = ? AND user_id = ?`,
    [guildId, targetUser.id]
  );

  const statRows = await all(
    `SELECT category, subtype, runs, points
     FROM user_stats
     WHERE guild_id = ? AND user_id = ?
     ORDER BY category, subtype`,
    [guildId, targetUser.id]
  );

  const totalPoints = userRow ? userRow.total_points : 0;
  const username = targetUser.username;
  const text = buildScoreboardText(username, totalPoints, statRows);

  await interaction.reply(text);
}

async function showLeaderboardFromMessage(message) {
  const rows = await all(
    `SELECT user_id, username, total_points
     FROM users
     WHERE guild_id = ?
     ORDER BY total_points DESC, username ASC
     LIMIT 15`,
    [message.guild.id]
  );

  if (!rows.length) {
    await message.reply('No records yet.');
    return;
  }

  const lines = rows.map((row, i) => `${i + 1}. <@${row.user_id}> - ${row.total_points} points`);
  await message.reply(`**Leaderboard**\n${lines.join('\n')}`);
}

async function showLeaderboardFromInteraction(interaction) {
  const rows = await all(
    `SELECT user_id, username, total_points
     FROM users
     WHERE guild_id = ?
     ORDER BY total_points DESC, username ASC
     LIMIT 15`,
    [interaction.guild.id]
  );

  if (!rows.length) {
    await interaction.reply('No records yet.');
    return;
  }

  const lines = rows.map((row, i) => `${i + 1}. <@${row.user_id}> - ${row.total_points} points`);
  await interaction.reply(`**Leaderboard**\n${lines.join('\n')}`);
}

function determineCategoryAndSubtype(difficultyType, waveType) {
  if (STANDARD_TYPES.includes(difficultyType)) {
    return { category: 'Standard', subtype: difficultyType };
  }

  if (difficultyType === 'Campaign' || difficultyType === 'CampaignHard') {
    return { category: 'Campaign', subtype: difficultyType };
  }

  if (difficultyType === 'StratagemNormal' || difficultyType === 'StratagemHard') {
    return { category: 'Stratagem', subtype: difficultyType };
  }

  if (
    difficultyType === 'TrialNormal' ||
    difficultyType === 'TrialLethal' ||
    difficultyType === 'TrialAbsolute'
  ) {
    return { category: 'Trial', subtype: difficultyType };
  }

  if (difficultyType === 'WPvP') {
    return { category: 'PvP', subtype: difficultyType };
  }

  if (difficultyType === 'Siege') {
    return { category: 'Siege', subtype: waveType };
  }

  if (difficultyType === 'SiegeHard') {
    return { category: 'SiegeHard', subtype: waveType };
  }

  return null;
}

async function processMissionSubmission(message) {
  const content = normalizeSpaces(message.content);

  const difficultyLine = extractLineValue(content, 'Difficulty');
  const membersLine = extractLineValue(content, 'Members');

  const errors = [];

  if (!difficultyLine) errors.push('Difficulty line is required.');
  if (!membersLine) errors.push('Members line is required.');

  if (errors.length) {
    await message.reply(`Error: record not saved.\n${errors.map((e) => `- ${e}`).join('\n')}`);
    return;
  }

  const { mainTypes, waveTypes } = parseRolesFromDifficultyLine(difficultyLine, message.guild);

  if (mainTypes.length !== 1) {
    errors.push('Exactly 1 valid difficulty role is required.');
  }

  const mentionedUsers = uniqueUsers([...message.mentions.users.values()].filter((u) => !u.bot));

  if (mentionedUsers.length < 2) {
    errors.push('At least 2 unique mentioned members are required.');
  }

  const difficultyType = mainTypes[0] || null;
  let waveType = null;

  if (difficultyType && SIEGE_TYPES.includes(difficultyType)) {
    if (waveTypes.length !== 1) {
      errors.push('Siege submissions require exactly 1 waves role.');
    } else {
      waveType = waveTypes[0];
    }
  } else if (waveTypes.length > 0) {
    errors.push('Waves role can only be used with Siege or SiegeHard.');
  }

  if (errors.length) {
    await message.reply(`Error: record not saved.\n${errors.map((e) => `- ${e}`).join('\n')}`);
    return;
  }

  const pointsEach = await resolvePoints(message.guild.id, difficultyType, waveType);

  if (pointsEach === null) {
    await message.reply('Error: record not saved.\n- Could not determine point value for that submission.');
    return;
  }

  const categoryInfo = determineCategoryAndSubtype(difficultyType, waveType);
  if (!categoryInfo) {
    await message.reply('Error: record not saved.\n- Could not determine category for that submission.');
    return;
  }

  for (const user of mentionedUsers) {
    await addPointsToUser(
      message.guild.id,
      user,
      categoryInfo.category,
      categoryInfo.subtype,
      pointsEach
    );
  }

  const insertResult = await run(
    `INSERT INTO mission_logs (guild_id, channel_id, message_id, author_id, difficulty_type, wave_type, points_each, member_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.guild.id,
      message.channel.id,
      message.id,
      message.author.id,
      difficultyType,
      waveType,
      pointsEach,
      mentionedUsers.length,
    ]
  );

  for (const user of mentionedUsers) {
    await run(
      `INSERT INTO mission_log_members (mission_log_id, user_id, username)
       VALUES (?, ?, ?)`,
      [insertResult.lastID, user.id, user.username]
    );
  }

  if (difficultyType === 'Siege' || difficultyType === 'SiegeHard') {
    await message.reply(
      `Mission recorded.\nMode: ${difficultyType}\nWaves: ${waveType}\nPoints awarded: ${pointsEach} each.\nMembers recorded: ${mentionedUsers.length}.`
    );
  } else {
    await message.reply(
      `Mission recorded.\nDifficulty: ${difficultyType}\nPoints awarded: ${pointsEach} each.\nMembers recorded: ${mentionedUsers.length}.`
    );
  }
}

async function handleAdminCommand(message) {
  const member = await message.guild.members.fetch(message.author.id);
  const command = message.content.trim().split(/\s+/)[0].toLowerCase();

  if (command === '!leaderboard') {
    await showLeaderboardFromMessage(message);
    return true;
  }

  if (command === '!scoreboard') {
    const targetUser = message.mentions.users.first() || message.author;
    await showScoreboardFromMessage(message, targetUser);
    return true;
  }

  if (!isAdmin(member)) {
    await message.reply('You do not have permission to use admin commands.');
    return true;
  }

  const parts = message.content.trim().split(/\s+/);

  if (command === '!addpoints') {
    const targetUser = message.mentions.users.first();
    const amount = Number(parts[2]);

    if (!targetUser || Number.isNaN(amount)) {
      await message.reply('Usage: !addpoints @user 5');
      return true;
    }

    await ensureUser(message.guild.id, targetUser);
    await run(
      `UPDATE users SET total_points = total_points + ? WHERE guild_id = ? AND user_id = ?`,
      [amount, message.guild.id, targetUser.id]
    );

    await message.reply(`Added ${amount} points to <@${targetUser.id}>.`);
    return true;
  }

  if (command === '!removepoints') {
    const targetUser = message.mentions.users.first();
    const amount = Number(parts[2]);

    if (!targetUser || Number.isNaN(amount)) {
      await message.reply('Usage: !removepoints @user 5');
      return true;
    }

    await removePointsFromUser(message.guild.id, targetUser, amount);
    await message.reply(`Removed ${amount} points from <@${targetUser.id}>.`);
    return true;
  }

  if (command === '!setpoints') {
    if (parts.length < 3) {
      await message.reply(
        'Usage:\n!setpoints Absolute 3\n!setpoints SiegeHard waves15-19 10'
      );
      return true;
    }

    if (parts.length === 3) {
      const keyName = parts[1];
      const value = Number(parts[2]);

      if (Number.isNaN(value)) {
        await message.reply('Invalid points value.');
        return true;
      }

      await run(
        `INSERT INTO point_overrides (guild_id, key_name, points_value)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id, key_name)
         DO UPDATE SET points_value = excluded.points_value`,
        [message.guild.id, keyName, value]
      );

      await message.reply(`Set ${keyName} to ${value} points.`);
      return true;
    }

    if (parts.length === 4) {
      const keyName = `${parts[1]}:${parts[2]}`;
      const value = Number(parts[3]);

      if (Number.isNaN(value)) {
        await message.reply('Invalid points value.');
        return true;
      }

      await run(
        `INSERT INTO point_overrides (guild_id, key_name, points_value)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id, key_name)
         DO UPDATE SET points_value = excluded.points_value`,
        [message.guild.id, keyName, value]
      );

      await message.reply(`Set ${parts[1]} ${parts[2]} to ${value} points.`);
      return true;
    }

    await message.reply('Usage:\n!setpoints Absolute 3\n!setpoints SiegeHard waves15-19 10');
    return true;
  }
    if (command === '!addpointsid') {
    const userId = parts[1];
    const amount = Number(parts[2]);

    if (!userId || Number.isNaN(amount)) {
      await message.reply('Usage: !addpointsid USER_ID 5');
      return true;
    }

    const fakeUser = { id: userId, username: userId };
    await ensureUser(message.guild.id, fakeUser);
    await run(
      `UPDATE users SET total_points = total_points + ? WHERE guild_id = ? AND user_id = ?`,
      [amount, message.guild.id, userId]
    );

    await message.reply(`Added ${amount} points to user ID ${userId}.`);
    return true;
  }

  if (command === '!removepointsid') {
    const userId = parts[1];
    const amount = Number(parts[2]);

    if (!userId || Number.isNaN(amount)) {
      await message.reply('Usage: !removepointsid USER_ID 5');
      return true;
    }

    await run(
      `UPDATE users SET total_points = total_points - ? WHERE guild_id = ? AND user_id = ?`,
      [amount, message.guild.id, userId]
    );

    await message.reply(`Removed ${amount} points from user ID ${userId}.`);
    return true;
  }

  return false;
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const content = message.content.trim();

       if (
      content.startsWith('!leaderboard') ||
      content.startsWith('!scoreboard') ||
      content.startsWith('!addpoints') ||
      content.startsWith('!removepoints') ||
      content.startsWith('!addpointsid') ||
      content.startsWith('!removepointsid') ||
      content.startsWith('!setpoints')
    ) {
      await handleAdminCommand(message);
      return;
    }

    if (LOG_CHANNEL_ID && message.channel.id !== LOG_CHANNEL_ID) return;

    const hasDifficulty = /^\s*Difficulty\s*:/im.test(content);
    const hasMembers = /^\s*Members\s*:/im.test(content);

    if (!hasDifficulty && !hasMembers) return;

    await processMissionSubmission(message);
  } catch (error) {
    console.error(error);
    try {
      await message.reply('Something went wrong while processing that message.');
    } catch {}
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    if (interaction.commandName === 'leaderboard') {
      await showLeaderboardFromInteraction(interaction);
      return;
    }

    if (interaction.commandName === 'scoreboard') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      await showScoreboardFromInteraction(interaction, targetUser);
    }
    client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    if (interaction.commandName === 'leaderboard') {
      await showLeaderboardFromInteraction(interaction);
      return;
    }

    if (interaction.commandName === 'points') {
      let reply = '**Current Point Values**\n\n';

      reply += '**Standard**\n';
      for (const key of ['Average', 'Substantial', 'Ruthless', 'Lethal', 'Absolute']) {
        reply += `- ${key}: ${POINTS[key]} points\n`;
      }

      reply += '\n**Stratagem**\n';
      for (const key of ['StratagemNormal', 'StratagemHard']) {
        reply += `- ${key}: ${POINTS[key]} points\n`;
      }

      reply += '\n**Campaign**\n';
      for (const key of ['Campaign', 'CampaignHard']) {
        reply += `- ${key}: ${POINTS[key]} points\n`;
      }

      reply += '\n**Trial**\n';
      for (const key of ['TrialNormal', 'TrialLethal', 'TrialAbsolute']) {
        reply += `- ${key}: ${POINTS[key]} points\n`;
      }

      reply += '\n**PvP**\n';
      for (const key of ['WPvP']) {
        reply += `- ${key}: ${POINTS[key]} points\n`;
      }

      reply += '\n**Siege Normal**\n';
      for (const wave in SIEGE_POINTS.Siege) {
        reply += `- ${wave}: ${SIEGE_POINTS.Siege[wave]} points\n`;
      }

      reply += '\n**Siege Hard**\n';
      for (const wave in SIEGE_POINTS.SiegeHard) {
        reply += `- ${wave}: ${SIEGE_POINTS.SiegeHard[wave]} points\n`;
      }

      await interaction.reply({ content: reply, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'scoreboard') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      await showScoreboardFromInteraction(interaction, targetUser);
      return;
    }

  } catch (error) {
    console.error(error);
    try {
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: 'Something went wrong while processing that command.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'Something went wrong while processing that command.', ephemeral: true });
        }
      }
    } catch {}
  }
});

(async () => {
  try {
    await initDb();
    await registerSlashCommands();
    await client.login(TOKEN);
  } catch (error) {
    console.error('Startup error:', error);
  }
})();