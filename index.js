// 文件: public/extensions/third-party/day6/index.js

import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';


(function () {
    // --- 插件基础信息 ---
    const extensionName = "day6";
    const pluginFolderName = "day6"; // <<<--- 注意：这里的文件名与插件名不匹配，如果你的文件夹确实叫 day6，这里应该也是 day6
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`;
    const extensionSettings = extension_settings[extensionName] || {};
    const defaultSettings = {};

    // --- 插件状态变量 ---
    let day1Worker;
    // Prompt Token 追踪
    let lastCalculatedPromptTokens = 0;
    let lastUsedApi = '';
    let pendingTokenConsumptionLog = false;
    // 时长追踪
    let lastVisibleTimestamp = null;
    let currentEntityId = null;
    let currentEntityName = null;
    let entityStartTime = null;

    const GLOBAL_STATS_ID = '_GLOBAL_STATS_';
    const LOG_PREFIX_MAIN = `[Day1 DBG Main ${new Date().toISOString()}]`; // <<< 添加日志前缀

    // --- IndexedDB 相关 (保持不变) ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;

    function openDBMain() {
        return new Promise((resolve, reject) => {
            if (dbInstance) { resolve(dbInstance); return; }
            console.log(`${LOG_PREFIX_MAIN} Opening IndexedDB...`); // <<< 日志
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => { console.error(`${LOG_PREFIX_MAIN} IndexedDB open error:`, event.target.error); reject('IndexedDB error: ' + event.target.error); };
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                console.log(`${LOG_PREFIX_MAIN} IndexedDB connection opened.`); // <<< 日志
                dbInstance.onerror = (event) => console.error(`${LOG_PREFIX_MAIN} Database error:`, event.target.error);
                dbInstance.onclose = () => { console.log(`${LOG_PREFIX_MAIN} Database connection closed.`); dbInstance = null; }; // <<< 日志 (修改)
                dbInstance.onversionchange = () => { console.log(`${LOG_PREFIX_MAIN} Database version change detected, closing connection.`); if (dbInstance) { dbInstance.close(); dbInstance = null; } }; // <<< 日志
                resolve(dbInstance);
            };
            request.onupgradeneeded = (event) => {
                console.log(`${LOG_PREFIX_MAIN} IndexedDB upgrade needed.`); // <<< 日志
                const db = event.target.result;
                const transaction = event.target.transaction;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    try {
                        db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                        console.log(`${LOG_PREFIX_MAIN} Object store "${STORE_NAME}" created.`); // <<< 日志
                    } catch (e) {
                         console.error(`${LOG_PREFIX_MAIN} Error creating object store "${STORE_NAME}"`, e); // <<< 日志
                         if (transaction) transaction.abort();
                         reject(`Error creating object store: ${e}`);
                         return;
                    }
                }
                console.log(`${LOG_PREFIX_MAIN} IndexedDB upgrade finished.`); // <<< 日志
            };
        });
    }

    function getAllStats() {
        return new Promise(async (resolve, reject) => {
            try {
                const db = await openDBMain();
                const transaction = db.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.getAll();
                request.onerror = (event) => { console.error(`${LOG_PREFIX_MAIN} Error reading all data:`, event.target.error); reject('Error reading all data: ' + event.target.error); }; // <<< 日志
                request.onsuccess = (event) => { console.log(`${LOG_PREFIX_MAIN} Successfully read all stats.`); resolve(event.target.result || []); }; // <<< 日志
            } catch (error) {
                console.error(`${LOG_PREFIX_MAIN} Error during getAllStats:`, error); // <<< 日志
                reject(error);
            }
        });
    }

    // --- Worker 通信 ---
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) { console.error(`${LOG_PREFIX_MAIN} Worker not initialized! Cannot send message.`); return; }
        try {
             console.log(`${LOG_PREFIX_MAIN} Sending command to worker:`, { command, payload }); // <<< 日志
             day1Worker.postMessage({ command, payload });
        } catch (error) {
             console.error(`${LOG_PREFIX_MAIN} Error posting message to worker:`, error, { command, payload }); // <<< 日志
        }
    }

    // --- 时长处理函数 ---
    function recordVisibleDuration() {
        console.log(`${LOG_PREFIX_MAIN} recordVisibleDuration called. lastVisibleTimestamp:`, lastVisibleTimestamp); // <<< 日志
        if (lastVisibleTimestamp) {
            const now = Date.now();
            const durationMs = now - lastVisibleTimestamp;
            console.log(`${LOG_PREFIX_MAIN} Calculated Visible Duration: ${durationMs}ms (Now: ${now}, LastVisible: ${lastVisibleTimestamp})`); // <<< 日志
            if (durationMs > 0) {
                sendMessageToWorker('recordDailyDuration', {
                    durationMs: durationMs,
                    timestamp: now, // <<< 使用计算时的 now
                });
            } else {
                 console.log(`${LOG_PREFIX_MAIN} Visible duration <= 0, not sending to worker.`); // <<< 日志
            }
            lastVisibleTimestamp = null; // <<< 重置时间戳
            console.log(`${LOG_PREFIX_MAIN} Reset lastVisibleTimestamp to null.`); // <<< 日志
        } else {
             console.log(`${LOG_PREFIX_MAIN} lastVisibleTimestamp is null, skipping visible duration recording.`); // <<< 日志
        }
    }

    /** 记录当前活动实体的交互时长片段到 Worker (包含时间戳) */
    function recordEntityDuration() {
        console.log(`${LOG_PREFIX_MAIN} recordEntityDuration called. currentEntityId:`, currentEntityId, 'entityStartTime:', entityStartTime); // <<< 日志
        if (entityStartTime && currentEntityId) {
            const now = Date.now();
            const durationMs = now - entityStartTime;
            console.log(`${LOG_PREFIX_MAIN} Calculated Entity Duration: ${durationMs}ms (Now: ${now}, StartTime: ${entityStartTime}) for Entity: ${currentEntityId}`); // <<< 日志
            if (durationMs > 0) {
                sendMessageToWorker('recordEntityDuration', {
                    entityId: currentEntityId,
                    entityName: currentEntityName,
                    durationMs: durationMs,
                    timestamp: now, // <<< 使用计算时的 now
                });
            } else {
                 console.log(`${LOG_PREFIX_MAIN} Entity duration <= 0, not sending to worker.`); // <<< 日志
            }
            entityStartTime = null; // <<< 重置时间戳
            console.log(`${LOG_PREFIX_MAIN} Reset entityStartTime to null for Entity: ${currentEntityId}`); // <<< 日志
        } else {
            console.log(`${LOG_PREFIX_MAIN} entityStartTime or currentEntityId is null/invalid, skipping entity duration recording.`); // <<< 日志
        }
    }

    function handleVisibilityChange() {
        console.log(`${LOG_PREFIX_MAIN} handleVisibilityChange triggered. State:`, document.visibilityState); // <<< 日志
        if (document.visibilityState === 'visible') {
            lastVisibleTimestamp = Date.now();
            console.log(`${LOG_PREFIX_MAIN} Visibility -> visible. Set lastVisibleTimestamp:`, lastVisibleTimestamp); // <<< 日志
            if (currentEntityId) {
                entityStartTime = Date.now();
                console.log(`${LOG_PREFIX_MAIN} Current entity active (${currentEntityId}). Set entityStartTime:`, entityStartTime); // <<< 日志
            } else {
                 console.log(`${LOG_PREFIX_MAIN} No current entity active, entityStartTime remains null.`); // <<< 日志
            }
        } else {
            console.log(`${LOG_PREFIX_MAIN} Visibility -> hidden/other. Recording durations.`); // <<< 日志
            recordVisibleDuration();
            recordEntityDuration();
        }
    }

    // --- UI 更新 (需要修改以显示新时长数据 - 已在上一轮修复) ---
    function formatDuration(ms) {
        if (typeof ms !== 'number' || ms <= 0) return '0s';
        let seconds = Math.floor(ms / 1000);
        let minutes = Math.floor(seconds / 60);
        let hours = Math.floor(minutes / 60);
        seconds %= 60; minutes %= 60;
        let result = '';
        if (hours > 0) result += `${hours}h `;
        if (minutes > 0) result += `${minutes}m `;
        if (seconds >= 0) result += `${seconds}s`;
        return result.trim();
    }

    async function updateStatsTable() {
        console.log(`${LOG_PREFIX_MAIN} updateStatsTable called.`); // <<< 日志
        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) { console.log(`${LOG_PREFIX_MAIN} Table body not found, exiting updateStatsTable.`); return; } // <<< 日志
        tableBody.empty().append('<tr><td colspan="8"><i>正在加载统计数据...</i></td></tr>');

        try {
            const allStats = await getAllStats();
            console.log(`${LOG_PREFIX_MAIN} Fetched stats data:`, JSON.stringify(allStats)); // <<< 日志 (Stringify避免对象展开问题)
            const todayString = new Date().toISOString().split('T')[0];
            tableBody.empty();

            if (allStats.length === 0) {
                 console.log(`${LOG_PREFIX_MAIN} No stats data found.`); // <<< 日志
                 tableBody.append('<tr><td colspan="8"><i>暂无任何统计数据。</i></td></tr>');
                return;
            }

            const globalStatEntry = allStats.find(s => s.entityId === GLOBAL_STATS_ID);
            const dailyGlobalData = globalStatEntry?.dailyData?.[todayString];
            const todayTotalDurationMs = dailyGlobalData?.totalVisibleDurationMs || 0; // <<< 读取全局时长
            const todayTotalDurationStr = formatDuration(todayTotalDurationMs);
            console.log(`${LOG_PREFIX_MAIN} Today's Global Visible Duration: ${todayTotalDurationMs}ms (${todayTotalDurationStr})`); // <<< 日志

            let hasTodayData = false;
            const entityStatsList = allStats
                .filter(s => s.entityId !== GLOBAL_STATS_ID)
                .sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            entityStatsList.forEach(entityStats => {
                const dailyData = entityStats.dailyData ? entityStats.dailyData[todayString] : null;
                console.log(`${LOG_PREFIX_MAIN} Processing entity: ${entityStats.entityId}, Today's dailyData:`, dailyData); // <<< 日志

                const userMessages = dailyData?.userMessages || 0;
                const userTokens = dailyData?.userTokens || 0;
                const aiMessages = dailyData?.aiMessages || 0;
                const aiTokens = dailyData?.aiTokens || 0;
                const cumulativeTokens = dailyData?.cumulativeTokens || 0;
                const totalAiDurationMs = dailyData?.totalAiResponseDuration || 0;
                const dailyEntityDurationMs = dailyData?.dailyInteractionDurationMs || 0; // <<< 读取当日实体时长
                const totalInteractionDurationMs = entityStats.totalInteractionDurationMs || 0; // <<< 读取总实体时长

                console.log(`${LOG_PREFIX_MAIN} Entity ${entityStats.entityId} - Daily Duration: ${dailyEntityDurationMs}ms, Total Duration: ${totalInteractionDurationMs}ms`); // <<< 日志

                let avgAiTimeStr = 'N/A';
                if (aiMessages > 0 && totalAiDurationMs > 0) {
                    avgAiTimeStr = `${(totalAiDurationMs / aiMessages / 1000).toFixed(2)}s`;
                }

                const totalInteractionDurationStr = formatDuration(totalInteractionDurationMs);
                const dailyEntityDurationStr = formatDuration(dailyEntityDurationMs);

                hasTodayData = hasTodayData || !!dailyData;

                const row = `
                    <tr>
                        <td>${entityStats.entityName || entityStats.entityId}</td>
                        <td>${userMessages} (${userTokens} tk)</td>
                        <td>${aiMessages} (${aiTokens} tk)</td>
                        <td>${cumulativeTokens} tk</td>
                        <td>${avgAiTimeStr}</td>
                        <td>${dailyEntityDurationStr}</td>        <%-- 角色/群组今日时长 --%>
                        <td>${totalInteractionDurationStr}</td>   <%-- 角色/群组总时长 --%>
                        <td>${todayTotalDurationStr}</td>         <%-- 今日总在线时长 --%>
                    </tr>
                `;
                tableBody.append(row);
            });

            if (!hasTodayData && entityStatsList.length === 0) {
                 console.log(`${LOG_PREFIX_MAIN} No entity data for today (${todayString}).`); // <<< 日志
                 tableBody.append(`<tr><td colspan="8"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`);
            }
             console.log(`${LOG_PREFIX_MAIN} updateStatsTable finished successfully.`); // <<< 日志

        } catch (error) {
            console.error(`${LOG_PREFIX_MAIN} Error fetching or updating stats table:`, error); // <<< 日志
            tableBody.empty().append('<tr><td colspan="8"><i style="color: red;">加载统计数据失败，请检查控制台。</i></td></tr>');
        }
    }


    // --- 事件处理 (handleMessage, onMessageSent 保持不变) ---
    async function handleMessage(message, isUser) {
        if (!message || !currentEntityId) {
             console.log(`${LOG_PREFIX_MAIN} handleMessage skipped: No message or currentEntityId.`); // <<< 日志
            return;
        }
         console.log(`${LOG_PREFIX_MAIN} handleMessage called for entity: ${currentEntityId}, isUser: ${isUser}`); // <<< 日志
        let tokenCount = 0;
        try {
            tokenCount = (typeof message?.extra?.token_count === 'number' && message.extra.token_count > 0)
                ? message.extra.token_count
                : (message.mes ? await getTokenCountAsync(message.mes || '', 0) : 0);
             console.log(`${LOG_PREFIX_MAIN} Calculated token count: ${tokenCount}`); // <<< 日志
        } catch (err) { tokenCount = Math.round((message.mes || '').length / 3.5); console.warn(`${LOG_PREFIX_MAIN} Token count fallback used.`); } // <<< 日志
        let aiResponseDuration = null;
        if (!isUser && message.gen_finished && message.gen_started) {
            try {
                const end = new Date(message.gen_finished).getTime();
                const start = new Date(message.gen_started).getTime();
                if (!isNaN(end) && !isNaN(start) && end >= start) aiResponseDuration = end - start;
                 console.log(`${LOG_PREFIX_MAIN} Calculated AI response duration: ${aiResponseDuration}ms`); // <<< 日志
            } catch (e) { console.warn(`${LOG_PREFIX_MAIN} Failed to calculate AI response duration.`, e); } // <<< 日志
        }
        sendMessageToWorker('processMessage', {
            entityId: currentEntityId, entityName: currentEntityName, isUser, tokenCount,
            timestamp: message.send_date || Date.now(), aiResponseDuration,
        });
    }
    function onMessageSent(messageId) {
         console.log(`${LOG_PREFIX_MAIN} onMessageSent triggered for messageId: ${messageId}`); // <<< 日志
        const context = getContext();
        if (context?.chat?.[messageId]) handleMessage(context.chat[messageId], true);
        else console.log(`${LOG_PREFIX_MAIN} Message ${messageId} not found in context.`); // <<< 日志
    }
    function onChatChanged(chatId) {
         console.log(`${LOG_PREFIX_MAIN} onChatChanged triggered. ChatId: ${chatId}. Previous Entity: ${currentEntityId}`); // <<< 日志
        const context = getContext();
        let newEntityId = null, newEntityName = null;
        if (context) {
            if (context.groupId != null) {
                newEntityId = String(context.groupId);
                newEntityName = context.groups?.find(g => String(g.id) === newEntityId)?.name || newEntityId;
                 console.log(`${LOG_PREFIX_MAIN} Switched to Group: ${newEntityName} (${newEntityId})`); // <<< 日志
            } else if (context.characterId != null && context.characters?.[context.characterId]) {
                newEntityId = context.characters[context.characterId].avatar;
                newEntityName = context.characters[context.characterId].name;
                 console.log(`${LOG_PREFIX_MAIN} Switched to Character: ${newEntityName} (${newEntityId})`); // <<< 日志
            } else {
                 console.log(`${LOG_PREFIX_MAIN} Switched to no specific entity (null).`); // <<< 日志
            }
        } else {
             console.log(`${LOG_PREFIX_MAIN} Context is null.`); // <<< 日志
        }

        // <<< 记录切换前的时长 >>>
        if (document.visibilityState === 'visible') {
            console.log(`${LOG_PREFIX_MAIN} Chat changed while visible. Recording previous entity duration...`); // <<< 日志
            recordEntityDuration();
        } else {
             console.log(`${LOG_PREFIX_MAIN} Chat changed while NOT visible. Entity duration should have been recorded by visibility change.`); // <<< 日志
        }

        if (newEntityId !== currentEntityId) {
            console.log(`${LOG_PREFIX_MAIN} Entity ID changed from ${currentEntityId} to ${newEntityId}.`); // <<< 日志
            currentEntityId = newEntityId;
            currentEntityName = newEntityName;
            // <<< 重置新实体的开始时间 >>>
            if (document.visibilityState === 'visible' && currentEntityId) {
                entityStartTime = Date.now();
                console.log(`${LOG_PREFIX_MAIN} Set new entityStartTime for ${currentEntityId}:`, entityStartTime); // <<< 日志
            } else {
                entityStartTime = null;
                 console.log(`${LOG_PREFIX_MAIN} Visibility not visible or no new entity, entityStartTime set to null.`); // <<< 日志
            }
            pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0; lastUsedApi = '';
            updateStatsTable(); // <<< 更新表格以反映新选择的实体（尽管数据可能尚未完全更新）
        } else if (newEntityId === null && currentEntityId !== null) {
             console.log(`${LOG_PREFIX_MAIN} Entity changed from ${currentEntityId} to null.`); // <<< 日志
             currentEntityId = null; currentEntityName = null; entityStartTime = null;
        } else {
             console.log(`${LOG_PREFIX_MAIN} Entity ID did not change (${currentEntityId}).`); // <<< 日志
        }
    }


    // --- 插件初始化 ---
    jQuery(async () => {
        console.log(`${LOG_PREFIX_MAIN} Initializing extension...`); // <<< 日志
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });

        try {
             console.log(`${LOG_PREFIX_MAIN} Initial DB open attempt...`); // <<< 日志
            await openDBMain();
             console.log(`${LOG_PREFIX_MAIN} Initial DB open successful.`); // <<< 日志
        } catch (error) { console.error(`${LOG_PREFIX_MAIN} DB init failed:`, error); } // <<< 日志

        try {
             console.log(`${LOG_PREFIX_MAIN} Rendering settings UI...`); // <<< 日志
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            const targetContainer = $('#extensions_settings') || $('#extension_settings') || $('body');
            if (targetContainer.length) {
                targetContainer.append(settingsHtml);
                $('#day1-refresh-button').on('click', () => { console.log(`${LOG_PREFIX_MAIN} Refresh button clicked.`); updateStatsTable(); }); // <<< 日志
                 console.log(`${LOG_PREFIX_MAIN} Settings UI appended. Scheduling initial table update.`); // <<< 日志
                setTimeout(updateStatsTable, 500);
            } else {
                 console.warn(`${LOG_PREFIX_MAIN} Target container for settings UI not found.`); // <<< 日志
            }
        } catch (error) { console.error(`${LOG_PREFIX_MAIN} Error loading settings UI:`, error); } // <<< 日志

        try {
             console.log(`${LOG_PREFIX_MAIN} Initializing Web Worker...`); // <<< 日志
            const workerPath = `${extensionFolderPath}/worker.js`;
            day1Worker = new Worker(workerPath);
            day1Worker.onerror = (error) => { console.error(`${LOG_PREFIX_MAIN} Worker error:`, error.message, error); }; // <<< 日志
            console.log(`${LOG_PREFIX_MAIN} Web Worker initialized.`); // <<< 日志
        } catch (error) { console.error(`${LOG_PREFIX_MAIN} Failed to initialize Worker:`, error); day1Worker = null; } // <<< 日志

        // --- 注册核心事件监听器 ---
         console.log(`${LOG_PREFIX_MAIN} Registering event listeners...`); // <<< 日志
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.GENERATE_AFTER_DATA, async (generateData) => {
             console.log(`${LOG_PREFIX_MAIN} GENERATE_AFTER_DATA event received.`); // <<< 日志
            const context = getContext();
            const currentApi = generateData.type || context.mainApi || mainApi;
            if (generateData.dryRun || !currentEntityId) { console.log(`${LOG_PREFIX_MAIN} GENERATE_AFTER_DATA skipped (dryRun or no entityId).`); return; } // <<< 日志
            try {
                let promptTokens = 0;
                if (currentApi === 'openai' || generateData.is_openai) {
                    if (Array.isArray(generateData.prompt)) promptTokens = (await Promise.all(generateData.prompt.map(m => getTokenCountAsync(m.content || '', 0)))).reduce((s, c) => s + c, 0);
                } else if (typeof generateData.prompt === 'string') {
                    promptTokens = await getTokenCountAsync(generateData.prompt, power_user?.token_padding || 0);
                }
                lastCalculatedPromptTokens = promptTokens; lastUsedApi = currentApi; pendingTokenConsumptionLog = true;
                 console.log(`${LOG_PREFIX_MAIN} Calculated prompt tokens: ${promptTokens}. Pending log set to true.`); // <<< 日志
            } catch (error) { pendingTokenConsumptionLog = false; console.error(`${LOG_PREFIX_MAIN} Error calculating prompt tokens:`, error); } // <<< 日志
        });
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
             console.log(`${LOG_PREFIX_MAIN} MESSAGE_RECEIVED event received. MessageId: ${messageId}, Type: ${type}`); // <<< 日志
            const context = getContext();
            if (context?.chat?.[messageId] && !context.chat[messageId].is_user && !context.chat[messageId].is_system) handleMessage(context.chat[messageId], false);
            if (pendingTokenConsumptionLog && currentEntityId) {
                 console.log(`${LOG_PREFIX_MAIN} Pending prompt token log found. Sending to worker.`); // <<< 日志
                sendMessageToWorker('recordPromptTokens', { entityId: currentEntityId, entityName: currentEntityName, timestamp: Date.now(), promptTokenCount: lastCalculatedPromptTokens });
                pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0;
            } else if (pendingTokenConsumptionLog) {
                 console.log(`${LOG_PREFIX_MAIN} Pending prompt token log found, but no currentEntityId. Resetting.`); // <<< 日志
                 pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0;
            }
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
             console.log(`${LOG_PREFIX_MAIN} GENERATION_STOPPED event received.`); // <<< 日志
            if (pendingTokenConsumptionLog) {
                 console.log(`${LOG_PREFIX_MAIN} Resetting pending prompt token log due to generation stop.`); // <<< 日志
                pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0;
            }
        });

        // --- 添加 visibilitychange 监听器 ---
         console.log(`${LOG_PREFIX_MAIN} Adding visibilitychange listener.`); // <<< 日志
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // --- 初始化时处理当前状态 ---
         console.log(`${LOG_PREFIX_MAIN} Initializing state based on current context...`); // <<< 日志
        const initialContext = getContext(); // <<< 获取初始上下文
        onChatChanged(initialContext?.chatId); // <<< 使用初始上下文调用 onChatChanged
        if (document.visibilityState === 'visible') {
            console.log(`${LOG_PREFIX_MAIN} Document initially visible. Calling handleVisibilityChange.`); // <<< 日志
            handleVisibilityChange(); // <<< 如果初始可见，也调用一次
        } else {
             console.log(`${LOG_PREFIX_MAIN} Document initially hidden.`); // <<< 日志
        }


        console.log(`${LOG_PREFIX_MAIN} Initialization complete.`); // <<< 日志
    });

})();
