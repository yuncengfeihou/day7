// 文件: public/extensions/third-party/day7/worker.js

const DB_NAME = 'SillyTavernDay1Stats';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1;
let db;

const GLOBAL_STATS_ID = '_GLOBAL_STATS_';
const LOG_PREFIX_WORKER = `[Day1 DBG Worker ${new Date().toISOString()}]`; // <<< 添加日志前缀

// --- IndexedDB 辅助函数 ---
function openDB() {
    return new Promise((resolve, reject) => {
        if (db) { resolve(db); return; }
        console.log(`${LOG_PREFIX_WORKER} Opening DB...`);
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => { console.error(`${LOG_PREFIX_WORKER} DB open error:`, event.target.error); reject('IndexedDB error: ' + event.target.error); };
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log(`${LOG_PREFIX_WORKER} DB connection opened.`);
            db.onerror = (event) => console.error(`${LOG_PREFIX_WORKER} Database error:`, event.target.error);
            db.onclose = () => { console.log(`${LOG_PREFIX_WORKER} Database connection closed.`); db = null; };
            db.onversionchange = () => { console.log(`${LOG_PREFIX_WORKER} Database version change detected, closing connection.`); if (db) db.close(); db = null; };
            resolve(db);
        };
        request.onupgradeneeded = (event) => { console.log(`${LOG_PREFIX_WORKER} DB upgrade needed.`); /* Upgrade logic in main thread */ };
    });
}
function readData(entityId) {
    return new Promise(async (resolve, reject) => {
        console.log(`${LOG_PREFIX_WORKER} Reading data for entityId:`, entityId);
        try {
            const currentDb = await openDB();
            if (!currentDb) { reject("DB not open"); return; } // 检查 DB 是否成功打开
            const transaction = currentDb.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(entityId);
            request.onerror = (event) => { console.error(`${LOG_PREFIX_WORKER} Error reading data for ${entityId}:`, event.target.error); reject('Error reading data: ' + event.target.error); };
            request.onsuccess = (event) => { console.log(`${LOG_PREFIX_WORKER} Read data success for ${entityId}. Result:`, event.target.result); resolve(event.target.result); };
        } catch (error) {
            console.error(`${LOG_PREFIX_WORKER} Error during readData transaction setup for ${entityId}:`, error);
            reject(error);
        }
    });
}
function writeData(data) {
    return new Promise(async (resolve, reject) => {
        console.log(`${LOG_PREFIX_WORKER} Writing data for entityId: ${data?.entityId}`, data);
        try {
            const currentDb = await openDB();
             if (!currentDb) { reject("DB not open"); return; } // 检查 DB 是否成功打开
            const transaction = currentDb.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data);
            request.onerror = (event) => { console.error(`${LOG_PREFIX_WORKER} Error writing data for ${data?.entityId}:`, event.target.error); reject('Error writing data: ' + event.target.error); };
            request.onsuccess = (event) => { console.log(`${LOG_PREFIX_WORKER} Write data success for ${data?.entityId}.`); resolve(event.target.result); };
        } catch (error) {
            console.error(`${LOG_PREFIX_WORKER} Error during writeData transaction setup for ${data?.entityId}:`, error);
            reject(error);
        }
    });
}

// --- 确保 stats 对象包含所有累计字段 ---
function ensureCumulativeFields(stats, entityId, entityName) {
     if (!stats) {
         // 如果 stats 不存在，创建一个新的完整结构
         return {
             entityId,
             entityName: entityName || entityId,
             dailyData: {},
             totalInteractionDurationMs: 0,
             totalUserMessages: 0,
             totalUserTokens: 0,
             totalAiMessages: 0,
             totalAiTokens: 0,
             totalAiResponseDurationAcrossDays: 0
         };
     }
     // 确保现有 stats 对象包含所有字段，以兼容旧数据
     stats.entityId = stats.entityId || entityId; // 确保 entityId 存在
     if (entityName && stats.entityName !== entityName) {
         console.log(`${LOG_PREFIX_WORKER} Updating entity name for ${entityId} from ${stats.entityName} to ${entityName}.`);
         stats.entityName = entityName;
     } else if (!stats.entityName) {
         stats.entityName = entityName || entityId; // 确保名称存在
     }
     stats.dailyData = stats.dailyData || {};
     stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
     stats.totalUserMessages = stats.totalUserMessages || 0;
     stats.totalUserTokens = stats.totalUserTokens || 0;
     stats.totalAiMessages = stats.totalAiMessages || 0;
     stats.totalAiTokens = stats.totalAiTokens || 0;
     stats.totalAiResponseDurationAcrossDays = stats.totalAiResponseDurationAcrossDays || 0;
     return stats;
}


// --- getOrCreateDailyStat (用于获取或创建当天的统计对象) ---
function getOrCreateDailyStat(stats, dateString, entityId) {
    // 这个函数现在假设 stats 对象已经被 ensureCumulativeFields 处理过，包含 dailyData
    const isGlobal = entityId === GLOBAL_STATS_ID;
    let createdNew = false;

    if (!stats.dailyData[dateString]) {
        createdNew = true;
        // 创建基础结构
        stats.dailyData[dateString] = {};
        if (isGlobal) {
            stats.dailyData[dateString].totalVisibleDurationMs = 0;
        } else {
            // 初始化非全局统计的当日字段
            Object.assign(stats.dailyData[dateString], {
                userMessages: 0, aiMessages: 0, userTokens: 0, aiTokens: 0,
                cumulativeTokens: 0, lastUserMessageTimestamp: null, lastAiMessageTimestamp: null,
                totalAiResponseDuration: 0, dailyInteractionDurationMs: 0,
            });
        }
         console.log(`${LOG_PREFIX_WORKER} Created new daily entry for ${entityId} on ${dateString}`);
    }

    // 确保所有当日字段存在 (即使是从旧数据加载的)
    if (isGlobal) {
        stats.dailyData[dateString].totalVisibleDurationMs = stats.dailyData[dateString].totalVisibleDurationMs || 0;
    } else {
        stats.dailyData[dateString].userMessages = stats.dailyData[dateString].userMessages || 0;
        stats.dailyData[dateString].aiMessages = stats.dailyData[dateString].aiMessages || 0;
        stats.dailyData[dateString].userTokens = stats.dailyData[dateString].userTokens || 0;
        stats.dailyData[dateString].aiTokens = stats.dailyData[dateString].aiTokens || 0;
        stats.dailyData[dateString].cumulativeTokens = stats.dailyData[dateString].cumulativeTokens || 0;
        stats.dailyData[dateString].lastUserMessageTimestamp = stats.dailyData[dateString].lastUserMessageTimestamp || null;
        stats.dailyData[dateString].lastAiMessageTimestamp = stats.dailyData[dateString].lastAiMessageTimestamp || null;
        stats.dailyData[dateString].totalAiResponseDuration = stats.dailyData[dateString].totalAiResponseDuration || 0;
        stats.dailyData[dateString].dailyInteractionDurationMs = stats.dailyData[dateString].dailyInteractionDurationMs || 0;
    }

     if (!createdNew) console.log(`${LOG_PREFIX_WORKER} Using existing daily entry for ${entityId} on ${dateString}`);

    return stats.dailyData[dateString];
}


// --- Web Worker 消息处理 ---
self.onmessage = async (event) => {
    if (!event.data?.command) {
        console.log(`${LOG_PREFIX_WORKER} Received message without command:`, event.data);
        return;
    }
    const { command, payload } = event.data;
    console.log(`${LOG_PREFIX_WORKER} Received command: ${command}, Payload:`, payload);

    // --- 修改：处理 'processMessage' 命令 ---
    if (command === 'processMessage') {
        if (!payload?.entityId || !payload.timestamp) { console.warn(`${LOG_PREFIX_WORKER} processMessage missing entityId or timestamp.`); return; }
        const { entityId, entityName, isUser, tokenCount, timestamp, aiResponseDuration } = payload;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            stats = ensureCumulativeFields(stats, entityId, entityName); // 获取或创建并确保字段完整

            // 获取或创建当日统计对象
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);

            // 更新当日统计 和 根级别的累计统计
            if (isUser === true) {
                // 更新当日
                dailyStat.userMessages += 1;
                dailyStat.userTokens += Number(tokenCount) || 0;
                dailyStat.lastUserMessageTimestamp = timestamp;
                // 更新累计
                stats.totalUserMessages += 1;
                stats.totalUserTokens += Number(tokenCount) || 0;
                console.log(`${LOG_PREFIX_WORKER} Updated User Stats for ${entityId}. Daily: ${dailyStat.userMessages} msgs, ${dailyStat.userTokens} tk. Total: ${stats.totalUserMessages} msgs, ${stats.totalUserTokens} tk.`);

            } else if (isUser === false) {
                // 更新当日
                dailyStat.aiMessages += 1;
                dailyStat.aiTokens += Number(tokenCount) || 0;
                dailyStat.lastAiMessageTimestamp = timestamp;
                // 更新累计
                stats.totalAiMessages += 1;
                stats.totalAiTokens += Number(tokenCount) || 0;

                // 处理 AI 响应时长 (当日和累计)
                if (typeof aiResponseDuration === 'number' && aiResponseDuration >= 0) {
                    dailyStat.totalAiResponseDuration += aiResponseDuration;
                    // 更新累计 AI 响应时长
                    stats.totalAiResponseDurationAcrossDays += aiResponseDuration;
                     console.log(`${LOG_PREFIX_WORKER} Updated AI Stats for ${entityId}. Daily: ${dailyStat.aiMessages} msgs, ${dailyStat.aiTokens} tk, ${dailyStat.totalAiResponseDuration}ms duration. Total: ${stats.totalAiMessages} msgs, ${stats.totalAiTokens} tk, ${stats.totalAiResponseDurationAcrossDays}ms duration.`);
                } else {
                     console.log(`${LOG_PREFIX_WORKER} Updated AI Stats for ${entityId}. Daily: ${dailyStat.aiMessages} msgs, ${dailyStat.aiTokens} tk. Total: ${stats.totalAiMessages} msgs, ${stats.totalAiTokens} tk. (No valid duration)`);
                }
            }

             console.log(`${LOG_PREFIX_WORKER} Processed message for ${entityId}. Updated stats (before write):`, JSON.parse(JSON.stringify(stats)));
            await writeData(stats);
        } catch (error) { console.error(`${LOG_PREFIX_WORKER} Error in processMessage for ${entityId}:`, error); }
    }
    // --- 处理 'recordPromptTokens' ---
    else if (command === 'recordPromptTokens') {
        if (!payload?.entityId || !payload.timestamp || typeof payload.promptTokenCount !== 'number') { console.warn(`${LOG_PREFIX_WORKER} recordPromptTokens missing data.`); return; }
        const { entityId, entityName, timestamp, promptTokenCount } = payload;
         try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            stats = ensureCumulativeFields(stats, entityId, entityName); // 确保基础结构存在

            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId); // 获取当日统计
            dailyStat.cumulativeTokens += Number(promptTokenCount) || 0; // 只更新当日累计 Prompt

             console.log(`${LOG_PREFIX_WORKER} Recorded prompt tokens for ${entityId}. Updated cumulativeTokens: ${dailyStat.cumulativeTokens}. Stats (before write):`, JSON.parse(JSON.stringify(stats)));
            await writeData(stats);
        } catch (error) { console.error(`${LOG_PREFIX_WORKER} Error in recordPromptTokens for ${entityId}:`, error); }
    }
    // --- 处理 'recordDailyDuration' (全局在线时长) ---
    else if (command === 'recordDailyDuration') {
        if (typeof payload?.durationMs !== 'number' || !payload.timestamp) { console.warn(`${LOG_PREFIX_WORKER} recordDailyDuration missing data.`); return; }
        const { durationMs, timestamp } = payload;
        const entityId = GLOBAL_STATS_ID;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            // 对于全局，不需要累计消息等，但需要 dailyData 和 totalVisibleDurationMs
            if (!stats) {
                 console.log(`${LOG_PREFIX_WORKER} No existing global stats found, creating new.`);
                 stats = { entityId, entityName: 'Global Stats', dailyData: {} };
            }
            stats.dailyData = stats.dailyData || {}; // 确保 dailyData 存在

            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId); // 获取当日统计
            dailyStat.totalVisibleDurationMs += durationMs; // 只更新当日在线时长

            console.log(`${LOG_PREFIX_WORKER} Recorded daily duration. Added ${durationMs}ms. New totalVisibleDurationMs: ${dailyStat.totalVisibleDurationMs}. Stats (before write):`, JSON.parse(JSON.stringify(stats)));
            await writeData(stats);
        } catch (error) { console.error(`${LOG_PREFIX_WORKER} Error in recordDailyDuration:`, error); }
    }
    // --- 处理 'recordEntityDuration' (实体交互时长) ---
    else if (command === 'recordEntityDuration') {
        if (!payload?.entityId || typeof payload.durationMs !== 'number' || !payload.timestamp) {
            console.warn(`${LOG_PREFIX_WORKER} Received recordEntityDuration with missing data. Payload:`, payload);
            return;
        }
        const { entityId, entityName, durationMs, timestamp } = payload;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            stats = ensureCumulativeFields(stats, entityId, entityName); // 确保基础结构存在

            // 更新总交互时长
            const oldTotalDuration = stats.totalInteractionDurationMs;
            stats.totalInteractionDurationMs += durationMs;
            console.log(`${LOG_PREFIX_WORKER} Updated totalInteractionDurationMs for ${entityId}. Added ${durationMs}ms. Old: ${oldTotalDuration}, New: ${stats.totalInteractionDurationMs}`);

            // 更新当日交互时长
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            const oldDailyDuration = dailyStat.dailyInteractionDurationMs;
            dailyStat.dailyInteractionDurationMs += durationMs;
            console.log(`${LOG_PREFIX_WORKER} Updated dailyInteractionDurationMs for ${entityId} on ${dateString}. Added ${durationMs}ms. Old: ${oldDailyDuration}, New: ${dailyStat.dailyInteractionDurationMs}`);

             console.log(`${LOG_PREFIX_WORKER} Recorded entity duration for ${entityId}. Stats (before write):`, JSON.parse(JSON.stringify(stats)));
            await writeData(stats);
        } catch (error) {
            console.error(`${LOG_PREFIX_WORKER} Error in recordEntityDuration for ${entityId}:`, error);
        }
    }
     else {
         console.warn(`${LOG_PREFIX_WORKER} Received unknown command: ${command}`);
    }
};

// --- Worker 初始化 ---
console.log(`${LOG_PREFIX_WORKER} Script loaded.`);
// 尝试在启动时打开一次 DB，以便更快地响应第一个请求
openDB().then(() => { console.log(`${LOG_PREFIX_WORKER} Initial DB check successful.`); })
        .catch(e => { console.error(`${LOG_PREFIX_WORKER} Initial DB check failed.`, e); });
