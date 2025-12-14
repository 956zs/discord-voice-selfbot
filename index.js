const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
require('dotenv').config();

const client = new Client({ checkUpdate: false });

const config = {
    Token: process.env.DISCORD_TOKEN,
    Guild: process.env.GUILD_ID,
    Channel: process.env.CHANNEL_ID
};

// 狀態追蹤：當本人在使用時，機器人暫停
let isPaused = false;

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`Target: Guild ${config.Guild} | Channel ${config.Channel}`);
    console.log(`Commands: &povv | !vc pause | !vc status`);

    await joinVC();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    // 只處理自己的語音狀態變更
    if (oldState.member.id !== client.user.id) return;

    const oldVoice = oldState.channelId;
    const newVoice = newState.channelId;

    if (oldVoice === newVoice) return;

    // 如果被踢出或斷開
    if (!newVoice) {
        // 檢查本人是否已經在目標頻道中
        const guild = client.guilds.cache.get(config.Guild);
        const targetChannel = guild?.channels.cache.get(config.Channel);
        const userInChannel = targetChannel?.members?.has(client.user.id);

        if (userInChannel) {
            // 本人已經在頻道中（手動加入），機器人暫停
            isPaused = true;
            console.log(`[PAUSED] User is in channel. Use &povv to resume.`);
        } else if (!isPaused) {
            // 非暫停狀態下被斷開，嘗試重新加入
            console.log(`[RECONNECT] Disconnected, rejoining...`);
            await joinVC();
        }
    } else if (newVoice !== config.Channel && !isPaused) {
        // 被移動到其他頻道，回到目標頻道
        console.log(`[RECONNECT] Moved to another channel, returning...`);
        await joinVC();
    }
});

// 訊息指令系統
client.on('messageCreate', async (message) => {
    // 只處理自己發送的訊息
    if (message.author.id !== client.user.id) return;

    const content = message.content.toLowerCase().trim();

    if (content === '&povv') {
        isPaused = false;
        console.log(`[RESUME] Joining channel...`);
        await message.delete().catch(() => { });
        await joinVC();
    } else if (content === '!vc pause') {
        isPaused = true;
        leaveVC();
        console.log(`[PAUSED] Bot left the channel.`);
        await message.delete().catch(() => { });
    } else if (content === '!vc status') {
        const status = isPaused ? 'PAUSED' : 'RUNNING';
        console.log(`[STATUS] ${status}`);
        await message.delete().catch(() => { });
    }
});

client.login(config.Token);

async function joinVC() {
    if (isPaused) {
        console.log(`[PAUSED] Skipping join.`);
        return;
    }

    try {
        const guild = client.guilds.cache.get(config.Guild);
        if (!guild) {
            console.error(`[ERROR] Guild not found: ${config.Guild}`);
            return;
        }

        const voiceChannel = guild.channels.cache.get(config.Channel);
        if (!voiceChannel) {
            console.error(`[ERROR] Channel not found: ${config.Channel}`);
            return;
        }

        joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true
        });

        console.log(`[JOINED] ${voiceChannel.name}`);
    } catch (error) {
        console.error(`[ERROR] Join failed:`, error.message);
    }
}

function leaveVC() {
    try {
        const connection = getVoiceConnection(config.Guild);
        if (connection) {
            connection.destroy();
            console.log(`[LEFT] Voice channel`);
        }
    } catch (error) {
        console.error(`[ERROR] Leave failed:`, error.message);
    }
}
