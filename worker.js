// 文件: public/extensions/third-party/day6/worker.js

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
        console.log(`${LOG_PREFIX_WORKER} Opening DB...`); // <<< 日志
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => { console.error(`${LOG_PREFIX_WORKER} DB open error:`, event.target.error); reject('IndexedDB error: ' + event.target.error); }; // <<< 日志
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log(`${LOG_PREFIX_WORKER} DB connection opened.`); // <<< 日志
            db.onerror = (event) => console.error(`${LOG_PREFIX_WORKER} Database error:`, event.target.error); // <<< 日志
            db.onclose = () => { console.log(`${LOG_PREFIX_WORKER} Database connection closed.`); db = null; }; // <<< 日志 (修改)
            db.onversionchange = () => { console.log(`${LOG_PREFIX_WORKER} Database version change detected, closing connection.`); if (db) db.close(); db = null; }; // <<< 日志
            resolve(db);
        };
        request.onupgradeneeded = (event) => { console.log(`${LOG_PREFIX_WORKER} DB upgrade needed.`); }; // <<< 日志
    });
}
function readData(entityId) {
    return new Promise(async (resolve, reject) => {
        console.log(`${LOG_PREFIX_WORKER} Reading data for entityId:`, entityId); // <<< 日志
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(entityId);
            request.onerror = (event) => { console.error(`${LOG_PREFIX_WORKER} Error reading data for ${entityId}:`, event.target.error); reject('Error reading data: ' + event.target.error); }; // <<< 日志
            request.onsuccess = (event) => { console.log(`${LOG_PREFIX_WORKER} Read data success for ${entityId}. Result:`, event.target.result); resolve(event.target.result); }; // <<< 日志
        } catch (error) {
            console.error(`${LOG_PREFIX_WORKER} Error during readData transaction setup for ${entityId}:`, error); // <<< 日志
            reject(error);
        }
    });
}
function writeData(data) {
    return new Promise(async (resolve, reject) => {
        console.log(`${LOG_PREFIX_WORKER} Writing data for entityId: ${data?.entityId}`, data); // <<< 日志
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data);
            request.onerror = (event) => { console.error(`${LOG_PREFIX_WORKER} Error writing data for ${data?.entityId}:`, event.target.error); reject('Error writing data: ' + event.target.error); }; // <<< 日志
            request.onsuccess = (event) => { console.log(`${LOG_PREFIX_WORKER} Write data success for ${data?.entityId}.`); resolve(event.target.result); }; // <<< 日志
        } catch (error) {
            console.error(`${LOG_PREFIX_WORKER} Error during writeData transaction setup for ${data?.entityId}:`, error); // <<< 日志
            reject(error);
        }
    });
}

// --- 修改：getOrCreateDailyStat 添加 dailyInteractionDurationMs (用于实体) ---
function getOrCreateDailyStat(stats, dateString, entityId) {
    if (!stats.dailyData) stats.dailyData = {};
    const isGlobal = entityId === GLOBAL_STATS_ID;
    let createdNew = false; // <<< 标记是否新建

    if (!stats.dailyData[dateString]) {
        createdNew = true; // <<< 标记
        stats.dailyData[dateString] = { totalVisibleDurationMs: 0 }; // 全局基础
        if (!isGlobal) {
            Object.assign(stats.dailyData[dateString], {
                userMessages: 0, aiMessages: 0, userTokens: 0, aiTokens: 0,
                cumulativeTokens: 0, lastUserMessageTimestamp: null, lastAiMessageTimestamp: null,
                totalAiResponseDuration: 0, dailyInteractionDurationMs: 0, // *** 新增当日实体时长 ***
            });
        }
         console.log(`${LOG_PREFIX_WORKER} Created new daily entry for ${entityId} on ${dateString}`); // <<< 日志
    }

    // 确保字段存在 (即使是旧数据也补上)
    stats.dailyData[dateString].totalVisibleDurationMs = stats.dailyData[dateString].totalVisibleDurationMs || 0;
    if (!isGlobal) {
        stats.dailyData[dateString].userMessages = stats.dailyData[dateString].userMessages || 0; // <<< 补充 userMessages
        stats.dailyData[dateString].aiMessages = stats.dailyData[dateString].aiMessages || 0;   // <<< 补充 aiMessages
        stats.dailyData[dateString].userTokens = stats.dailyData[dateString].userTokens || 0;
        stats.dailyData[dateString].aiTokens = stats.dailyData[dateString].aiTokens || 0;
        stats.dailyData[dateString].cumulativeTokens = stats.dailyData[dateString].cumulativeTokens || 0;
        stats.dailyData[dateString].lastUserMessageTimestamp = stats.dailyData[dateString].lastUserMessageTimestamp || null;
        stats.dailyData[dateString].lastAiMessageTimestamp = stats.dailyData[dateString].lastAiMessageTimestamp || null;
        stats.dailyData[dateString].totalAiResponseDuration = stats.dailyData[dateString].totalAiResponseDuration || 0;
        stats.dailyData[dateString].dailyInteractionDurationMs = stats.dailyData[dateString].dailyInteractionDurationMs || 0; // *** 确保当日实体时长字段存在 ***
    } else if (!createdNew && stats.dailyData[dateString].totalVisibleDurationMs === undefined){ // <<< 确保全局时长存在
         stats.dailyData[dateString].totalVisibleDurationMs = 0;
    }
     if (!createdNew) console.log(`${LOG_PREFIX_WORKER} Using existing daily entry for ${entityId} on ${dateString}`); // <<< 日志

    return stats.dailyData[dateString];
}


// --- Web Worker 消息处理 ---
self.onmessage = async (event) => {
    if (!event.data?.command) {
        console.log(`${LOG_PREFIX_WORKER} Received message without command:`, event.data); // <<< 日志
        return;
    }
    const { command, payload } = event.data;
    console.log(`${LOG_PREFIX_WORKER} Received command: ${command}, Payload:`, payload); // <<< 日志

    // 处理 'processMessage' 命令 (保持不变)
    if (command === 'processMessage') {
        if (!payload?.entityId || !payload.timestamp) { console.warn(`${LOG_PREFIX_WORKER} processMessage missing entityId or timestamp.`); return; } // <<< 日志
        const { entityId, entityName, isUser, tokenCount, timestamp, aiResponseDuration } = payload;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) {
                console.log(`${LOG_PREFIX_WORKER} No existing stats found for ${entityId}, creating new.`); // <<< 日志
                stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            } else if (entityName && stats.entityName !== entityName) {
                 console.log(`${LOG_PREFIX_WORKER} Updating entity name for ${entityId} from ${stats.entityName} to ${entityName}.`); // <<< 日志
                stats.entityName = entityName;
            }
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            if (isUser === true) {
                dailyStat.userMessages = (dailyStat.userMessages || 0) + 1; dailyStat.userTokens += Number(tokenCount) || 0; dailyStat.lastUserMessageTimestamp = timestamp;
            } else if (isUser === false) {
                dailyStat.aiMessages = (dailyStat.aiMessages || 0) + 1; dailyStat.aiTokens += Number(tokenCount) || 0; dailyStat.lastAiMessageTimestamp = timestamp;
                if (typeof aiResponseDuration === 'number' && aiResponseDuration >= 0) dailyStat.totalAiResponseDuration += aiResponseDuration;
            }
             console.log(`${LOG_PREFIX_WORKER} Processed message for ${entityId}. Updated stats (before write):`, JSON.parse(JSON.stringify(stats))); // <<< 日志 (Deep copy for logging)
            await writeData(stats);
        } catch (error) { console.error(`${LOG_PREFIX_WORKER} Error in processMessage for ${entityId}:`, error); } // <<< 日志
    }
    // 处理 'recordPromptTokens' 命令 (保持不变)
    else if (command === 'recordPromptTokens') {
        if (!payload?.entityId || !payload.timestamp || typeof payload.promptTokenCount !== 'number') { console.warn(`${LOG_PREFIX_WORKER} recordPromptTokens missing data.`); return; } // <<< 日志
        const { entityId, entityName, timestamp, promptTokenCount } = payload;
         try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) {
                console.log(`${LOG_PREFIX_WORKER} No existing stats found for ${entityId} (prompt tokens), creating new.`); // <<< 日志
                stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            } else if (entityName && stats.entityName !== entityName) {
                 console.log(`${LOG_PREFIX_WORKER} Updating entity name for ${entityId} (prompt tokens) from ${stats.entityName} to ${entityName}.`); // <<< 日志
                stats.entityName = entityName;
            }
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.cumulativeTokens += Number(promptTokenCount) || 0;
             console.log(`${LOG_PREFIX_WORKER} Recorded prompt tokens for ${entityId}. Updated cumulativeTokens: ${dailyStat.cumulativeTokens}. Stats (before write):`, JSON.parse(JSON.stringify(stats))); // <<< 日志
            await writeData(stats);
        } catch (error) { console.error(`${LOG_PREFIX_WORKER} Error in recordPromptTokens for ${entityId}:`, error); } // <<< 日志
    }
    // 处理 'recordDailyDuration' 命令 (保持不变)
    else if (command === 'recordDailyDuration') {
        if (typeof payload?.durationMs !== 'number' || !payload.timestamp) { console.warn(`${LOG_PREFIX_WORKER} recordDailyDuration missing data.`); return; } // <<< 日志
        const { durationMs, timestamp } = payload;
        const entityId = GLOBAL_STATS_ID;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) {
                console.log(`${LOG_PREFIX_WORKER} No existing global stats found, creating new.`); // <<< 日志
                stats = { entityId, entityName: 'Global Stats', dailyData: {} };
            }
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.totalVisibleDurationMs += durationMs;
            console.log(`${LOG_PREFIX_WORKER} Recorded daily duration. Added ${durationMs}ms. New totalVisibleDurationMs: ${dailyStat.totalVisibleDurationMs}. Stats (before write):`, JSON.parse(JSON.stringify(stats))); // <<< 日志
            await writeData(stats);
        } catch (error) { console.error(`${LOG_PREFIX_WORKER} Error in recordDailyDuration:`, error); } // <<< 日志
    }
    // --- 修改：处理 'recordEntityDuration' 命令以更新当日实体时长 ---
    else if (command === 'recordEntityDuration') {
        if (!payload?.entityId || typeof payload.durationMs !== 'number' || !payload.timestamp) {
            console.warn(`${LOG_PREFIX_WORKER} Received recordEntityDuration with missing data. Payload:`, payload); // <<< 日志 (修改)
            return;
        }
        const { entityId, entityName, durationMs, timestamp } = payload;

        try {
            let stats = await readData(entityId);
            if (!stats) {
                 console.log(`${LOG_PREFIX_WORKER} No existing stats found for ${entityId} (entity duration), creating new.`); // <<< 日志
                stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            } else if (entityName && stats.entityName !== entityName) {
                 console.log(`${LOG_PREFIX_WORKER} Updating entity name for ${entityId} (entity duration) from ${stats.entityName} to ${entityName}.`); // <<< 日志
                stats.entityName = entityName;
            }
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;

            // 更新总时长
            const oldTotalDuration = stats.totalInteractionDurationMs; // <<< 记录旧值
            stats.totalInteractionDurationMs += durationMs;
             console.log(`${LOG_PREFIX_WORKER} Updated totalInteractionDurationMs for ${entityId}. Added ${durationMs}ms. Old: ${oldTotalDuration}, New: ${stats.totalInteractionDurationMs}`); // <<< 日志

            // *** 更新当日时长 ***
            let date = new Date(timestamp);
            if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            const oldDailyDuration = dailyStat.dailyInteractionDurationMs; // <<< 记录旧值
            dailyStat.dailyInteractionDurationMs += durationMs;
             console.log(`${LOG_PREFIX_WORKER} Updated dailyInteractionDurationMs for ${entityId} on ${dateString}. Added ${durationMs}ms. Old: ${oldDailyDuration}, New: ${dailyStat.dailyInteractionDurationMs}`); // <<< 日志

             console.log(`${LOG_PREFIX_WORKER} Recorded entity duration for ${entityId}. Stats (before write):`, JSON.parse(JSON.stringify(stats))); // <<< 日志
            await writeData(stats);
        } catch (error) {
            console.error(`${LOG_PREFIX_WORKER} Error in recordEntityDuration for ${entityId}:`, error); // <<< 日志
        }
    } else {
         console.warn(`${LOG_PREFIX_WORKER} Received unknown command: ${command}`); // <<< 日志
    }
};

// --- Worker 初始化 ---
console.log(`${LOG_PREFIX_WORKER} Script loaded.`); // <<< 日志
openDB().then(() => { console.log(`${LOG_PREFIX_WORKER} Initial DB check successful.`); }) // <<< 日志
        .catch(e => { console.error(`${LOG_PREFIX_WORKER} Initial DB check failed.`, e); }); // <<< 日志
