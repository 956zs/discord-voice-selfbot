const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
require('dotenv').config();

const client = new Client({ checkUpdate: false });

const config = {
    Token: process.env.DISCORD_TOKEN,
    Guild: process.env.GUILD_ID,
    Channel: process.env.CHANNEL_ID,
    WebhookUrl: process.env.WEBHOOK_URL || null,  // 可選的 webhook URL
    WebhookMention: process.env.WEBHOOK_MENTION || null  // 可選的提及內容，如 <@123456789> 或 <@&987654321>
};

// 狀態追蹤
let isPaused = false;
// 追蹤當前連線，避免重複創建和事件監聽器累積
let currentConnection = null;
let isJoining = false;

// 重試相關狀態
let retryTimerId = null;
const RETRY_INTERVAL = 5 * 60 * 1000; // 5 分鐘
let isInRetryMode = false;
let lastWebhookNotifyTime = 0;
const WEBHOOK_COOLDOWN = 30 * 60 * 1000; // 30 分鐘內不重複發送相同通知

// ============ 日誌工具 ============
function getTimestamp() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function log(...args) {
    console.log(`[${getTimestamp()}]`, ...args);
}

function logError(...args) {
    console.error(`[${getTimestamp()}]`, ...args);
}

// ============ Webhook 通知 ============
async function sendWebhookNotification(type, message) {
    if (!config.WebhookUrl) return;

    // 防止短時間內重複發送相同類型通知
    const now = Date.now();
    if (type === 'user_limit' && now - lastWebhookNotifyTime < WEBHOOK_COOLDOWN) {
        log(`[WEBHOOK] Skipping notification (cooldown)`);
        return;
    }

    try {
        // 建立提及內容
        const mentionContent = config.WebhookMention ? config.WebhookMention : '';

        const payload = {
            content: mentionContent,  // 提及內容放在 content 中才會真正通知
            embeds: [{
                title: getWebhookTitle(type),
                description: message,
                color: getWebhookColor(type),
                timestamp: new Date().toISOString(),
                footer: {
                    text: 'Discord VC Selfbot'
                }
            }]
        };

        const response = await fetch(config.WebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            log(`[WEBHOOK] Notification sent: ${type}`);
            if (type === 'user_limit') {
                lastWebhookNotifyTime = now;
            }
        } else {
            logError(`[WEBHOOK] Failed to send: ${response.status}`);
        }
    } catch (error) {
        logError(`[WEBHOOK] Error:`, error.message);
    }
}

function getWebhookTitle(type) {
    switch (type) {
        case 'user_limit': return '⚠️ 頻道人數已滿';
        case 'retry_success': return '✅ 重新加入成功';
        case 'error': return '❌ 發生錯誤';
        default: return '📢 通知';
    }
}

function getWebhookColor(type) {
    switch (type) {
        case 'user_limit': return 0xFFA500; // 橙色
        case 'retry_success': return 0x00FF00; // 綠色
        case 'error': return 0xFF0000; // 紅色
        default: return 0x0099FF; // 藍色
    }
}

// ============ 重試機制 ============
function startRetryMode(reason) {
    if (isInRetryMode) return;

    isInRetryMode = true;
    log(`[RETRY] Entering retry mode: ${reason}`);
    log(`[RETRY] Will retry every 5 minutes...`);

    // 發送 webhook 通知
    sendWebhookNotification('user_limit',
        `無法加入語音頻道：${reason}\n將每 5 分鐘嘗試重新加入。`
    );

    // 設置定時重試
    scheduleRetry();
}

function scheduleRetry() {
    // 清除舊的定時器
    clearRetryTimer();

    if (!isInRetryMode || isPaused) return;

    retryTimerId = setTimeout(async () => {
        retryTimerId = null;

        if (!isInRetryMode || isPaused) return;

        log(`[RETRY] Attempting to rejoin...`);
        const success = await attemptJoinVC();

        if (success) {
            exitRetryMode(true);
        } else {
            // 再次排程
            scheduleRetry();
        }
    }, RETRY_INTERVAL);

    log(`[RETRY] Next attempt in 5 minutes...`);
}

function exitRetryMode(success = false) {
    if (!isInRetryMode) return;

    clearRetryTimer();
    isInRetryMode = false;

    if (success) {
        log(`[RETRY] Successfully rejoined! Exiting retry mode.`);
        sendWebhookNotification('retry_success', '已成功重新加入語音頻道！');
    } else {
        log(`[RETRY] Exiting retry mode.`);
    }
}

function clearRetryTimer() {
    if (retryTimerId) {
        clearTimeout(retryTimerId);
        retryTimerId = null;
    }
}

// 嘗試加入，返回是否成功
async function attemptJoinVC() {
    if (isPaused) return false;
    if (isJoining) return false;

    try {
        isJoining = true;

        // 強制重新獲取 guild 和 channel 資訊
        const guild = await client.guilds.fetch(config.Guild).catch(() => null);
        if (!guild) {
            logError(`[ERROR] Guild not found`);
            return false;
        }

        // 強制重新獲取頻道資訊
        const voiceChannel = await guild.channels.fetch(config.Channel).catch(() => null);
        if (!voiceChannel) {
            logError(`[ERROR] Channel not found`);
            return false;
        }

        // 檢查人數限制
        if (voiceChannel.userLimit > 0) {
            const currentMembers = voiceChannel.members?.size || 0;
            if (currentMembers >= voiceChannel.userLimit) {
                log(`[LIMIT] Channel is full (${currentMembers}/${voiceChannel.userLimit})`);
                return false;
            }
        }

        // 如果已有連線，先清理
        if (currentConnection) {
            destroyConnection(currentConnection);
        }

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true
        });

        currentConnection = connection;
        setupConnectionListeners(connection);

        // 等待連線就緒或失敗
        const result = await new Promise((resolve) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
            }, 10000);

            connection.once(VoiceConnectionStatus.Ready, () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(true);
                }
            });

            connection.once(VoiceConnectionStatus.Disconnected, () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(false);
                }
            });
        });

        if (result) {
            log(`[JOINED] ${voiceChannel.name}`);
            return true;
        } else {
            log(`[FAILED] Could not join channel`);
            destroyConnection(connection);
            return false;
        }
    } catch (error) {
        logError(`[ERROR] Join attempt failed:`, error.message);
        return false;
    } finally {
        isJoining = false;
    }
}

// ============ 主要事件處理 ============
client.on('ready', async () => {
    log(`Logged in as ${client.user.tag}!`);
    log(`Target: Guild ${config.Guild} | Channel ${config.Channel}`);
    log(`Webhook: ${config.WebhookUrl ? 'Configured' : 'Not configured'}`);
    log(`Commands: &povv | ^-1 | ^-s`);

    // 啟動時檢查：如果本人已經在頻道，自動進入暫搬模式
    const guild = client.guilds.cache.get(config.Guild);
    const targetChannel = guild?.channels.cache.get(config.Channel);

    if (targetChannel?.members?.has(client.user.id)) {
        isPaused = true;
        log(`[STARTUP] User already in channel. Bot paused.`);
    } else {
        await joinVC();
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.member.id !== client.user.id) return;

    // 只處理目標伺服器的語音狀態變化，忽略其他伺服器的語音活動
    if (oldState.guild.id !== config.Guild && newState.guild.id !== config.Guild) {
        return;
    }

    const oldChannel = oldState.channelId;
    const newChannel = newState.channelId;

    if (oldChannel === newChannel) return;

    // 情況 1: 用戶完全離開語音 → 機器人接管
    if (!newChannel) {
        log(`[AUTO] User left voice. Resuming bot immediately...`);
        isPaused = false;
        exitRetryMode(); // 退出重試模式
        joinVC();
        return;
    }

    // 情況 2: 用戶移動到其他頻道 → 機器人暫停
    if (newChannel !== config.Channel) {
        if (!isPaused) {
            log(`[AUTO] User moved to another channel. Pausing bot.`);
            isPaused = true;
            exitRetryMode(); // 退出重試模式
            leaveVC();
        }
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.id !== client.user.id) return;
    const content = message.content.toLowerCase().trim();

    if (content === '&povv') {
        isPaused = false;
        exitRetryMode(); // 退出重試模式
        log(`[CMD] &povv received. Force joining...`);
        await message.delete().catch(() => { });
        await joinVC();
    } else if (content === '^-1') {
        isPaused = true;
        exitRetryMode(); // 退出重試模式
        leaveVC();
        log(`[CMD] ^-1 received. Pausing...`);
        await message.delete().catch(() => { });
    } else if (content === '^-s') {
        const retryStatus = isInRetryMode ? ' | RETRY MODE' : '';
        const status = isPaused ? 'PAUSED (User Active)' : 'RUNNING';
        log(`[STATUS] ${status}${retryStatus}`);
        await message.delete().catch(() => { });
    }
});

client.login(config.Token);

// ============ 連線事件監聽 ============
function setupConnectionListeners(connection) {
    // 監聽斷線事件
    connection.once(VoiceConnectionStatus.Disconnected, async () => {
        // 如果連線已經不是當前連線，忽略
        if (connection !== currentConnection) {
            log(`[DEBUG] Ignoring disconnect for old connection`);
            return;
        }

        log(`[EVENT] Disconnected detected, waiting for state change...`);

        try {
            let timeoutId = null;

            // 等待 1.2 秒讓 API 狀態同步
            await Promise.race([
                new Promise((resolve) => connection.once(VoiceConnectionStatus.Signalling, () => {
                    log(`[EVENT] State changed to Signalling`);
                    clearTimeout(timeoutId);
                    resolve();
                })),
                new Promise((resolve) => connection.once(VoiceConnectionStatus.Connecting, () => {
                    log(`[EVENT] State changed to Connecting`);
                    clearTimeout(timeoutId);
                    resolve();
                })),
                new Promise((resolve) => {
                    timeoutId = setTimeout(() => {
                        log(`[EVENT] Timeout reached (1.2s)`);
                        resolve();
                    }, 1200);
                }),
            ]);

            // 如果仍然是 Disconnected，檢查是否是用戶佔用了頻道
            if (connection.state.status === VoiceConnectionStatus.Disconnected) {
                log(`[DEBUG] Still disconnected after wait`);

                // 重新抓取頻道成員狀態
                const freshGuild = await client.guilds.fetch(config.Guild).catch(() => null);
                const freshChannel = freshGuild?.channels.cache.get(config.Channel);

                if (freshChannel?.members?.has(client.user.id)) {
                    // 用戶還在頻道裡，但連線斷了 => 被本人擠掉
                    log(`[AUTO] Detected user in channel (Squeeze). Pausing bot.`);
                    isPaused = true;
                    destroyConnection(connection);
                } else {
                    // 用戶不在頻道裡，是真的斷線 => 嘗試重連
                    if (!isPaused && connection === currentConnection) {
                        log(`[AUTO] Connection lost. Reconnecting...`);
                        destroyConnection(connection);
                        setTimeout(() => joinVC(), 500);
                    }
                }
            } else {
                // 狀態已經變更（正在重連中），重新註冊監聽器
                log(`[DEBUG] Connection recovering, re-registering listeners`);
                setupConnectionListeners(connection);
            }
        } catch (error) {
            logError('[ERROR] Disconnect handler:', error);
        }
    });

    // 監聽 Ready 狀態 - 確保連線穩定後重新註冊斷線監聽器
    connection.once(VoiceConnectionStatus.Ready, () => {
        if (connection === currentConnection) {
            log(`[EVENT] Connection is Ready`);
            // 如果之前在重試模式，現在成功了
            if (isInRetryMode) {
                exitRetryMode(true);
            }
            // Ready 後重新註冊斷線監聯器，以便下次斷線時能捕捉到
            setupConnectionListeners(connection);
        }
    });

    // 監聽 Destroyed 狀態
    connection.once(VoiceConnectionStatus.Destroyed, () => {
        log(`[EVENT] Connection Destroyed`);
        if (connection === currentConnection) {
            currentConnection = null;
        }
    });
}

// ============ 連線管理 ============
function destroyConnection(connection) {
    if (connection) {
        try {
            connection.removeAllListeners();
            connection.destroy();
        } catch (e) {
            // 忽略銷毀錯誤
        }
        if (connection === currentConnection) {
            currentConnection = null;
        }
    }
}

async function joinVC() {
    if (isPaused) {
        log(`[SKIP] Bot is paused.`);
        return;
    }

    // 防止同時多次加入
    if (isJoining) {
        log(`[SKIP] Already joining...`);
        return;
    }

    try {
        isJoining = true;

        const guild = client.guilds.cache.get(config.Guild);
        if (!guild) {
            isJoining = false;
            return logError(`[ERROR] Guild not found`);
        }

        // 強制重新獲取頻道資訊
        const voiceChannel = await guild.channels.fetch(config.Channel).catch(() => null);
        if (!voiceChannel) {
            isJoining = false;
            return logError(`[ERROR] Channel not found`);
        }

        // 檢查人數限制
        if (voiceChannel.userLimit > 0) {
            const currentMembers = voiceChannel.members?.size || 0;
            if (currentMembers >= voiceChannel.userLimit) {
                log(`[LIMIT] Channel is full (${currentMembers}/${voiceChannel.userLimit})`);
                isJoining = false;
                startRetryMode(`頻道已滿 (${currentMembers}/${voiceChannel.userLimit})`);
                return;
            }
        }

        // 如果已有連線，先清理
        if (currentConnection) {
            destroyConnection(currentConnection);
        }

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true
        });

        currentConnection = connection;
        setupConnectionListeners(connection);

        log(`[JOINED] ${voiceChannel.name}`);

        // 成功加入後退出重試模式
        if (isInRetryMode) {
            exitRetryMode(true);
        }
    } catch (error) {
        logError(`[ERROR] Join failed:`, error.message);
        // 如果是人數限制錯誤，進入重試模式
        if (error.message?.includes('limit') || error.message?.includes('full')) {
            startRetryMode(error.message);
        }
    } finally {
        isJoining = false;
    }
}

function leaveVC() {
    clearRetryTimer(); // 清除重試定時器

    try {
        if (currentConnection) {
            destroyConnection(currentConnection);
            log(`[LEFT] Voice channel`);
        } else {
            // 備用：使用 getVoiceConnection 檢查
            const connection = getVoiceConnection(config.Guild);
            if (connection) {
                destroyConnection(connection);
                log(`[LEFT] Voice channel`);
            }
        }
    } catch (error) {
        logError(`[ERROR] Leave failed:`, error.message);
    }
}

// ============ 清理處理 ============
process.on('SIGINT', () => {
    log('\n[SHUTDOWN] Cleaning up...');
    clearRetryTimer();
    leaveVC();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('\n[SHUTDOWN] Cleaning up...');
    clearRetryTimer();
    leaveVC();
    client.destroy();
    process.exit(0);
});
