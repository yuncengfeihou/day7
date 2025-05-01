// 文件: public/extensions/third-party/day7/index.js

import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';


(function () {
    // --- 插件基础信息 ---
    const extensionName = "day7";
    const pluginFolderName = "day7"; // <<<--- 注意：这里的文件名与插件名需匹配你的文件夹名
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

    // --- IndexedDB 相关 ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;

    function openDBMain() {
        return new Promise((resolve, reject) => {
            if (dbInstance) { resolve(dbInstance); return; }
            console.log(`${LOG_PREFIX_MAIN} Opening IndexedDB...`);
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => { console.error(`${LOG_PREFIX_MAIN} IndexedDB open error:`, event.target.error); reject('IndexedDB error: ' + event.target.error); };
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                console.log(`${LOG_PREFIX_MAIN} IndexedDB connection opened.`);
                dbInstance.onerror = (event) => console.error(`${LOG_PREFIX_MAIN} Database error:`, event.target.error);
                dbInstance.onclose = () => { console.log(`${LOG_PREFIX_MAIN} Database connection closed.`); dbInstance = null; };
                dbInstance.onversionchange = () => { console.log(`${LOG_PREFIX_MAIN} Database version change detected, closing connection.`); if (dbInstance) { dbInstance.close(); dbInstance = null; } };
                resolve(dbInstance);
            };
            request.onupgradeneeded = (event) => {
                console.log(`${LOG_PREFIX_MAIN} IndexedDB upgrade needed.`);
                const db = event.target.result;
                const transaction = event.target.transaction;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    try {
                        db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                        console.log(`${LOG_PREFIX_MAIN} Object store "${STORE_NAME}" created.`);
                    } catch (e) {
                         console.error(`${LOG_PREFIX_MAIN} Error creating object store "${STORE_NAME}"`, e);
                         if (transaction) transaction.abort();
                         reject(`Error creating object store: ${e}`);
                         return;
                    }
                }
                console.log(`${LOG_PREFIX_MAIN} IndexedDB upgrade finished.`);
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
                request.onerror = (event) => { console.error(`${LOG_PREFIX_MAIN} Error reading all data:`, event.target.error); reject('Error reading all data: ' + event.target.error); };
                request.onsuccess = (event) => { console.log(`${LOG_PREFIX_MAIN} Successfully read all stats.`); resolve(event.target.result || []); };
            } catch (error) {
                console.error(`${LOG_PREFIX_MAIN} Error during getAllStats:`, error);
                reject(error);
            }
        });
    }

    // --- Worker 通信 ---
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) { console.error(`${LOG_PREFIX_MAIN} Worker not initialized! Cannot send message.`); return; }
        try {
             console.log(`${LOG_PREFIX_MAIN} Sending command to worker:`, { command, payload });
             day1Worker.postMessage({ command, payload });
        } catch (error) {
             console.error(`${LOG_PREFIX_MAIN} Error posting message to worker:`, error, { command, payload });
        }
    }

    // --- 时长处理函数 ---
    function recordVisibleDuration() {
        console.log(`${LOG_PREFIX_MAIN} recordVisibleDuration called. lastVisibleTimestamp:`, lastVisibleTimestamp);
        if (lastVisibleTimestamp) {
            const now = Date.now();
            const durationMs = now - lastVisibleTimestamp;
            console.log(`${LOG_PREFIX_MAIN} Calculated Visible Duration: ${durationMs}ms (Now: ${now}, LastVisible: ${lastVisibleTimestamp})`);
            if (durationMs > 0) {
                sendMessageToWorker('recordDailyDuration', {
                    durationMs: durationMs,
                    timestamp: now,
                });
            } else {
                 console.log(`${LOG_PREFIX_MAIN} Visible duration <= 0, not sending to worker.`);
            }
            lastVisibleTimestamp = null; // 重置时间戳
            console.log(`${LOG_PREFIX_MAIN} Reset lastVisibleTimestamp to null.`);
        } else {
             console.log(`${LOG_PREFIX_MAIN} lastVisibleTimestamp is null, skipping visible duration recording.`);
        }
    }

    function recordEntityDuration() {
        console.log(`${LOG_PREFIX_MAIN} recordEntityDuration called. currentEntityId:`, currentEntityId, 'entityStartTime:', entityStartTime);
        if (entityStartTime && currentEntityId) {
            const now = Date.now();
            const durationMs = now - entityStartTime;
            console.log(`${LOG_PREFIX_MAIN} Calculated Entity Duration: ${durationMs}ms (Now: ${now}, StartTime: ${entityStartTime}) for Entity: ${currentEntityId}`);
            if (durationMs > 0) {
                sendMessageToWorker('recordEntityDuration', {
                    entityId: currentEntityId,
                    entityName: currentEntityName,
                    durationMs: durationMs,
                    timestamp: now,
                });
            } else {
                 console.log(`${LOG_PREFIX_MAIN} Entity duration <= 0, not sending to worker.`);
            }
            entityStartTime = null; // 重置时间戳
            console.log(`${LOG_PREFIX_MAIN} Reset entityStartTime to null for Entity: ${currentEntityId}`);
        } else {
            console.log(`${LOG_PREFIX_MAIN} entityStartTime or currentEntityId is null/invalid, skipping entity duration recording.`);
        }
    }

    function handleVisibilityChange() {
        console.log(`${LOG_PREFIX_MAIN} handleVisibilityChange triggered. State:`, document.visibilityState);
        if (document.visibilityState === 'visible') {
            lastVisibleTimestamp = Date.now();
            console.log(`${LOG_PREFIX_MAIN} Visibility -> visible. Set lastVisibleTimestamp:`, lastVisibleTimestamp);
            if (currentEntityId) {
                entityStartTime = Date.now();
                console.log(`${LOG_PREFIX_MAIN} Current entity active (${currentEntityId}). Set entityStartTime:`, entityStartTime);
            } else {
                 console.log(`${LOG_PREFIX_MAIN} No current entity active, entityStartTime remains null.`);
            }
        } else {
            console.log(`${LOG_PREFIX_MAIN} Visibility -> hidden/other. Recording durations.`);
            recordVisibleDuration();
            recordEntityDuration();
        }
    }

    // --- UI 更新 ---
    function formatDuration(ms) {
        // 优化：确保 0ms 和小于 1s 的情况返回 '0s'
        if (typeof ms !== 'number' || ms <= 0) return '0s';
        let seconds = Math.floor(ms / 1000);
        let minutes = Math.floor(seconds / 60);
        let hours = Math.floor(minutes / 60);
        seconds %= 60; minutes %= 60;
        let result = '';
        if (hours > 0) result += `${hours}h `;
        if (minutes > 0) result += `${minutes}m `;
        // 即使 hours 和 minutes 都是 0，也要显示秒数
        if (seconds >= 0) result += `${seconds}s`;
        // 如果计算结果为空字符串（例如 ms 非常小但大于 0），确保返回 '0s'
        return result.trim() || '0s';
    }

    async function updateStatsTable() {
        console.log(`${LOG_PREFIX_MAIN} updateStatsTable called.`);
        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) { console.log(`${LOG_PREFIX_MAIN} Table body not found, exiting updateStatsTable.`); return; }
        tableBody.empty().append('<tr><td colspan="8"><i>正在加载统计数据...</i></td></tr>');

        try {
            const allStats = await getAllStats();
            console.log(`${LOG_PREFIX_MAIN} Fetched stats data:`, JSON.stringify(allStats));
            const todayString = new Date().toISOString().split('T')[0];
            tableBody.empty();

            if (allStats.length === 0) {
                 console.log(`${LOG_PREFIX_MAIN} No stats data found.`);
                 tableBody.append('<tr><td colspan="8"><i>暂无任何统计数据。</i></td></tr>');
                return;
            }

            const globalStatEntry = allStats.find(s => s.entityId === GLOBAL_STATS_ID);
            const dailyGlobalData = globalStatEntry?.dailyData?.[todayString];
            const todayTotalDurationMs = dailyGlobalData?.totalVisibleDurationMs || 0;
            const todayTotalDurationStr = formatDuration(todayTotalDurationMs);
            console.log(`${LOG_PREFIX_MAIN} Today's Global Visible Duration: ${todayTotalDurationMs}ms (${todayTotalDurationStr})`);

            let hasTodayData = false;
            const entityStatsList = allStats
                .filter(s => s.entityId !== GLOBAL_STATS_ID)
                .sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            entityStatsList.forEach(entityStats => {
                const dailyData = entityStats.dailyData ? entityStats.dailyData[todayString] : null;
                console.log(`${LOG_PREFIX_MAIN} Processing entity: ${entityStats.entityId}, Today's dailyData:`, dailyData);

                const userMessages = dailyData?.userMessages || 0;
                const userTokens = dailyData?.userTokens || 0;
                const aiMessages = dailyData?.aiMessages || 0;
                const aiTokens = dailyData?.aiTokens || 0;
                const cumulativeTokens = dailyData?.cumulativeTokens || 0;
                // *** 修改：获取当日 AI 响应总时长 ***
                const todayTotalAiDurationMs = dailyData?.totalAiResponseDuration || 0;
                const dailyEntityDurationMs = dailyData?.dailyInteractionDurationMs || 0;
                const totalInteractionDurationMs = entityStats.totalInteractionDurationMs || 0;

                 console.log(`${LOG_PREFIX_MAIN} Entity ${entityStats.entityId} - Daily Duration: ${dailyEntityDurationMs}ms, Total Duration: ${totalInteractionDurationMs}ms, Today AI Duration: ${todayTotalAiDurationMs}ms`);

                // *** 修改：直接格式化当日 AI 总时长，不再计算平均值 ***
                const todayTotalAiDurationStr = formatDuration(todayTotalAiDurationMs);

                const totalInteractionDurationStr = formatDuration(totalInteractionDurationMs);
                const dailyEntityDurationStr = formatDuration(dailyEntityDurationMs);

                hasTodayData = hasTodayData || !!dailyData;

                // *** 修改：更新表格行模板 ***
                const row = `
                    <tr>
                        <td>${entityStats.entityName || entityStats.entityId}</td>
                        <td>${userMessages} (${userTokens} tk)</td>
                        <td>${aiMessages} (${aiTokens} tk)</td>
                        <td>${cumulativeTokens} tk</td>
                        <td>${todayTotalAiDurationStr}</td> <%-- 显示今日 AI 响应总耗时 --%>
                        <td>${dailyEntityDurationStr}</td>
                        <td>${totalInteractionDurationStr}</td>
                        <td>${todayTotalDurationStr}</td>
                    </tr>
                `;
                tableBody.append(row);
            });

            if (!hasTodayData && entityStatsList.length === 0) {
                 console.log(`${LOG_PREFIX_MAIN} No entity data for today (${todayString}).`);
                 tableBody.append(`<tr><td colspan="8"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`);
            }
             console.log(`${LOG_PREFIX_MAIN} updateStatsTable finished successfully.`);

        } catch (error) {
            console.error(`${LOG_PREFIX_MAIN} Error fetching or updating stats table:`, error);
            tableBody.empty().append('<tr><td colspan="8"><i style="color: red;">加载统计数据失败，请检查控制台。</i></td></tr>');
        }
    }


    // --- 事件处理 ---
    async function handleMessage(message, isUser) {
        if (!message || !currentEntityId) {
             console.log(`${LOG_PREFIX_MAIN} handleMessage skipped: No message or currentEntityId.`);
            return;
        }
         console.log(`${LOG_PREFIX_MAIN} handleMessage called for entity: ${currentEntityId}, isUser: ${isUser}`);
        let tokenCount = 0;
        try {
            tokenCount = (typeof message?.extra?.token_count === 'number' && message.extra.token_count > 0)
                ? message.extra.token_count
                : (message.mes ? await getTokenCountAsync(message.mes || '', 0) : 0);
             console.log(`${LOG_PREFIX_MAIN} Calculated token count: ${tokenCount}`);
        } catch (err) { tokenCount = Math.round((message.mes || '').length / 3.5); console.warn(`${LOG_PREFIX_MAIN} Token count fallback used.`); }
        let aiResponseDuration = null;
        if (!isUser && message.gen_finished && message.gen_started) {
            try {
                const end = new Date(message.gen_finished).getTime();
                const start = new Date(message.gen_started).getTime();
                if (!isNaN(end) && !isNaN(start) && end >= start) aiResponseDuration = end - start;
                 console.log(`${LOG_PREFIX_MAIN} Calculated AI response duration: ${aiResponseDuration}ms`);
            } catch (e) { console.warn(`${LOG_PREFIX_MAIN} Failed to calculate AI response duration.`, e); }
        }
        sendMessageToWorker('processMessage', {
            entityId: currentEntityId, entityName: currentEntityName, isUser, tokenCount,
            timestamp: message.send_date || Date.now(), aiResponseDuration,
        });
    }
    function onMessageSent(messageId) {
         console.log(`${LOG_PREFIX_MAIN} onMessageSent triggered for messageId: ${messageId}`);
        const context = getContext();
        if (context?.chat?.[messageId]) handleMessage(context.chat[messageId], true);
        else console.log(`${LOG_PREFIX_MAIN} Message ${messageId} not found in context.`);
    }
    function onChatChanged(chatId) {
         console.log(`${LOG_PREFIX_MAIN} onChatChanged triggered. ChatId: ${chatId}. Previous Entity: ${currentEntityId}`);
        const context = getContext();
        let newEntityId = null, newEntityName = null;
        if (context) {
            if (context.groupId != null) {
                newEntityId = String(context.groupId);
                newEntityName = context.groups?.find(g => String(g.id) === newEntityId)?.name || newEntityId;
                 console.log(`${LOG_PREFIX_MAIN} Switched to Group: ${newEntityName} (${newEntityId})`);
            } else if (context.characterId != null && context.characters?.[context.characterId]) {
                newEntityId = context.characters[context.characterId].avatar;
                newEntityName = context.characters[context.characterId].name;
                 console.log(`${LOG_PREFIX_MAIN} Switched to Character: ${newEntityName} (${newEntityId})`);
            } else {
                 console.log(`${LOG_PREFIX_MAIN} Switched to no specific entity (null).`);
            }
        } else {
             console.log(`${LOG_PREFIX_MAIN} Context is null.`);
        }

        // 记录切换前的时长
        if (document.visibilityState === 'visible') {
            console.log(`${LOG_PREFIX_MAIN} Chat changed while visible. Recording previous entity duration...`);
            recordEntityDuration();
        } else {
             console.log(`${LOG_PREFIX_MAIN} Chat changed while NOT visible. Entity duration should have been recorded by visibility change.`);
        }

        if (newEntityId !== currentEntityId) {
            console.log(`${LOG_PREFIX_MAIN} Entity ID changed from ${currentEntityId} to ${newEntityId}.`);
            currentEntityId = newEntityId;
            currentEntityName = newEntityName;
            // 重置新实体的开始时间
            if (document.visibilityState === 'visible' && currentEntityId) {
                entityStartTime = Date.now();
                console.log(`${LOG_PREFIX_MAIN} Set new entityStartTime for ${currentEntityId}:`, entityStartTime);
            } else {
                entityStartTime = null;
                 console.log(`${LOG_PREFIX_MAIN} Visibility not visible or no new entity, entityStartTime set to null.`);
            }
            pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0; lastUsedApi = '';
            updateStatsTable(); // 更新表格
        } else if (newEntityId === null && currentEntityId !== null) {
             console.log(`${LOG_PREFIX_MAIN} Entity changed from ${currentEntityId} to null.`);
             currentEntityId = null; currentEntityName = null; entityStartTime = null;
             updateStatsTable(); // 更新表格 (显示全局或无数据状态)
        } else {
             console.log(`${LOG_PREFIX_MAIN} Entity ID did not change (${currentEntityId}).`);
        }
    }


    // --- 插件初始化 ---
    jQuery(async () => {
        console.log(`${LOG_PREFIX_MAIN} Initializing extension...`);
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });

        try {
             console.log(`${LOG_PREFIX_MAIN} Initial DB open attempt...`);
            await openDBMain();
             console.log(`${LOG_PREFIX_MAIN} Initial DB open successful.`);
        } catch (error) { console.error(`${LOG_PREFIX_MAIN} DB init failed:`, error); }

        try {
             console.log(`${LOG_PREFIX_MAIN} Rendering settings UI...`);
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            const targetContainer = $('#extensions_settings') || $('#extension_settings') || $('body');
            if (targetContainer.length) {
                targetContainer.append(settingsHtml);

                // --- 修改后的刷新按钮点击事件 ---
                $('#day1-refresh-button').on('click', () => {
                    console.log(`${LOG_PREFIX_MAIN} Refresh button clicked.`);

                    // 1. 检查页面是否可见，如果可见，则记录当前累积的时长
                    if (document.visibilityState === 'visible') {
                        console.log(`${LOG_PREFIX_MAIN} Refresh clicked while visible. Recording current durations before update...`);

                        // 记录并发送当前的总在线时长片段
                        recordVisibleDuration();
                        // 重置时间戳以继续追踪
                        lastVisibleTimestamp = Date.now();
                        console.log(`${LOG_PREFIX_MAIN} Reset lastVisibleTimestamp after manual record:`, lastVisibleTimestamp);

                        // 记录并发送当前的实体交互时长片段 (如果当前有实体)
                        recordEntityDuration();
                        // 如果当前有实体，重置时间戳以继续追踪
                        if (currentEntityId) {
                            entityStartTime = Date.now();
                            console.log(`${LOG_PREFIX_MAIN} Reset entityStartTime after manual record for ${currentEntityId}:`, entityStartTime);
                        } else {
                            entityStartTime = null;
                            console.log(`${LOG_PREFIX_MAIN} No active entity, entityStartTime remains null after manual record.`);
                        }
                    } else {
                        console.log(`${LOG_PREFIX_MAIN} Refresh clicked while not visible. Durations should have been recorded by visibilitychange.`);
                    }

                    // 2. （可选延迟后）更新表格显示
                    setTimeout(() => {
                        console.log(`${LOG_PREFIX_MAIN} Updating stats table display after refresh click.`);
                        updateStatsTable();
                    }, 50); // 短暂延迟，给 worker 一点时间（非必需，但可能有助于看到最新数据）
                });
                // --- 修改结束 ---

                 console.log(`${LOG_PREFIX_MAIN} Settings UI appended. Scheduling initial table update.`);
                setTimeout(updateStatsTable, 500); // 初始加载延迟
            } else {
                 console.warn(`${LOG_PREFIX_MAIN} Target container for settings UI not found.`);
            }
        } catch (error) { console.error(`${LOG_PREFIX_MAIN} Error loading settings UI:`, error); }

        try {
             console.log(`${LOG_PREFIX_MAIN} Initializing Web Worker...`);
            const workerPath = `${extensionFolderPath}/worker.js`;
            day1Worker = new Worker(workerPath);
            day1Worker.onerror = (error) => { console.error(`${LOG_PREFIX_MAIN} Worker error:`, error.message, error); };
            console.log(`${LOG_PREFIX_MAIN} Web Worker initialized.`);
        } catch (error) { console.error(`${LOG_PREFIX_MAIN} Failed to initialize Worker:`, error); day1Worker = null; }

        // --- 注册核心事件监听器 ---
         console.log(`${LOG_PREFIX_MAIN} Registering event listeners...`);
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.GENERATE_AFTER_DATA, async (generateData) => {
             console.log(`${LOG_PREFIX_MAIN} GENERATE_AFTER_DATA event received.`);
            const context = getContext();
            const currentApi = generateData.type || context.mainApi || mainApi; // 确保获取 API 类型
            if (generateData.dryRun || !currentEntityId) { console.log(`${LOG_PREFIX_MAIN} GENERATE_AFTER_DATA skipped (dryRun or no entityId).`); return; }
            try {
                let promptTokens = 0;
                const power_user = extension_settings?.power_user ?? {}; // 安全访问 power_user
                if (currentApi === 'openai' || generateData.is_openai) {
                     if (Array.isArray(generateData.prompt)) {
                        promptTokens = (await Promise.all(generateData.prompt.map(m => getTokenCountAsync(m.content || '', 0)))).reduce((s, c) => s + c, 0);
                     } else if (typeof generateData.prompt === 'string') { // Fallback for potential string prompt in OpenAI case
                        promptTokens = await getTokenCountAsync(generateData.prompt, power_user?.token_padding || 0);
                     }
                } else if (typeof generateData.prompt === 'string') {
                    promptTokens = await getTokenCountAsync(generateData.prompt, power_user?.token_padding || 0);
                }
                lastCalculatedPromptTokens = promptTokens; lastUsedApi = currentApi; pendingTokenConsumptionLog = true;
                 console.log(`${LOG_PREFIX_MAIN} Calculated prompt tokens: ${promptTokens}. Pending log set to true.`);
            } catch (error) { pendingTokenConsumptionLog = false; console.error(`${LOG_PREFIX_MAIN} Error calculating prompt tokens:`, error); }
        });
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
             console.log(`${LOG_PREFIX_MAIN} MESSAGE_RECEIVED event received. MessageId: ${messageId}, Type: ${type}`);
            const context = getContext();
            // 处理 AI 消息
            if (context?.chat?.[messageId] && !context.chat[messageId].is_user && !context.chat[messageId].is_system) handleMessage(context.chat[messageId], false);
            // 处理待处理的 Prompt Token 记录
            if (pendingTokenConsumptionLog && currentEntityId) {
                 console.log(`${LOG_PREFIX_MAIN} Pending prompt token log found. Sending to worker.`);
                sendMessageToWorker('recordPromptTokens', { entityId: currentEntityId, entityName: currentEntityName, timestamp: Date.now(), promptTokenCount: lastCalculatedPromptTokens });
                pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0;
            } else if (pendingTokenConsumptionLog) {
                 console.log(`${LOG_PREFIX_MAIN} Pending prompt token log found, but no currentEntityId. Resetting.`);
                 pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0;
            }
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
             console.log(`${LOG_PREFIX_MAIN} GENERATION_STOPPED event received.`);
            if (pendingTokenConsumptionLog) {
                 console.log(`${LOG_PREFIX_MAIN} Resetting pending prompt token log due to generation stop.`);
                pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0;
            }
        });

        // --- 添加 visibilitychange 监听器 ---
         console.log(`${LOG_PREFIX_MAIN} Adding visibilitychange listener.`);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // --- 初始化时处理当前状态 ---
         console.log(`${LOG_PREFIX_MAIN} Initializing state based on current context...`);
        const initialContext = getContext();
        onChatChanged(initialContext?.chatId); // 使用初始上下文调用 onChatChanged (会处理 currentEntityId 和 entityStartTime)
        if (document.visibilityState === 'visible') {
            console.log(`${LOG_PREFIX_MAIN} Document initially visible. Setting initial timestamps.`);
            // 如果初始可见，设置初始时间戳
            lastVisibleTimestamp = Date.now();
            if (currentEntityId) { // 确保 currentEntityId 已被 onChatChanged 设置
                entityStartTime = Date.now();
            }
             console.log(`${LOG_PREFIX_MAIN} Initial lastVisibleTimestamp: ${lastVisibleTimestamp}, initial entityStartTime: ${entityStartTime}`);
        } else {
             console.log(`${LOG_PREFIX_MAIN} Document initially hidden.`);
             // 如果初始不可见，确保时间戳为 null
             lastVisibleTimestamp = null;
             entityStartTime = null;
        }

        console.log(`${LOG_PREFIX_MAIN} Initialization complete.`);
    });

})();
