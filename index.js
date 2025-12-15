const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
require('dotenv').config();

const client = new Client({ checkUpdate: false });

const config = {
    Token: process.env.DISCORD_TOKEN,
    Guild: process.env.GUILD_ID,
    Channel: process.env.CHANNEL_ID
};

// 狀態追蹤
let isPaused = false;

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`Target: Guild ${config.Guild} | Channel ${config.Channel}`);
    console.log(`Commands: &povv | ^-1 | ^-s`);

    // 啟動時檢查：如果本人已經在頻道，自動進入暫搬模式
    const guild = client.guilds.cache.get(config.Guild);
    const targetChannel = guild?.channels.cache.get(config.Channel);

    if (targetChannel?.members?.has(client.user.id)) {
        isPaused = true;
        console.log(`[STARTUP] User already in channel. Bot paused.`);
    } else {
        await joinVC();
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.member.id !== client.user.id) return;

    const oldChannel = oldState.channelId;
    const newChannel = newState.channelId;

    if (oldChannel === newChannel) return;

    // 情況 1: 用戶完全離開語音 → 機器人接管
    if (!newChannel) {
        console.log(`[AUTO] User left voice. Resuming bot immediately...`);
        isPaused = false;
        joinVC();
        return;
    }

    // 情況 2: 用戶移動到其他頻道 → 機器人暫停
    if (newChannel !== config.Channel) {
        if (!isPaused) {
            console.log(`[AUTO] User moved to another channel. Pausing bot.`);
            isPaused = true;
            leaveVC();
        }
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.id !== client.user.id) return;
    const content = message.content.toLowerCase().trim();

    if (content === '&povv') {
        isPaused = false;
        console.log(`[CMD] &povv received. Force joining...`);
        await message.delete().catch(() => { });
        await joinVC();
    } else if (content === '^-1') {
        isPaused = true;
        leaveVC();
        console.log(`[CMD] ^-1 received. Pausing...`);
        await message.delete().catch(() => { });
    } else if (content === '^-s') {
        const status = isPaused ? 'PAUSED (User Active)' : 'RUNNING';
        console.log(`[STATUS] ${status}`);
        await message.delete().catch(() => { });
    }
});

client.login(config.Token);

async function joinVC() {
    if (isPaused) {
        console.log(`[SKIP] Bot is paused.`);
        return;
    }

    try {
        const guild = client.guilds.cache.get(config.Guild);
        if (!guild) return console.error(`[ERROR] Guild not found`);
        const voiceChannel = guild.channels.cache.get(config.Channel);
        if (!voiceChannel) return console.error(`[ERROR] Channel not found`);

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true
        });

        // 監聽連線狀態，判斷是否被"擠掉"
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                // 等待 1.2 秒讓 API 狀態同步，並給用戶加入的時間
                await Promise.race([
                    new Promise((resolve) => connection.once(VoiceConnectionStatus.Signalling, resolve)),
                    new Promise((resolve) => connection.once(VoiceConnectionStatus.Connecting, resolve)),
                    new Promise((resolve) => setTimeout(resolve, 1200)),
                ]);

                // 如果仍然是 Disconnected，檢查是否是用戶佔用了頻道
                if (connection.state.status === VoiceConnectionStatus.Disconnected) {
                    // 重新抓取頻道成員狀態
                    const freshGuild = await client.guilds.fetch(config.Guild).catch(() => null);
                    const freshChannel = freshGuild?.channels.cache.get(config.Channel);

                    if (freshChannel?.members?.has(client.user.id)) {
                        // 用戶還在頻道裡，但連線斷了 => 被本人擠掉
                        console.log(`[AUTO] Detected user in channel (Squeeze). Pausing bot.`);
                        isPaused = true;
                        connection.destroy();
                    } else {
                        // 用戶不在頻道裡，是真的斷線 => 嘗試重連
                        if (!isPaused) {
                            console.log(`[AUTO] Connection lost. Reconnecting...`);
                            connection.rejoin();
                        }
                    }
                }
            } catch (error) {
                console.error(error);
            }
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
