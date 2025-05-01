// 文件: public/extensions/third-party/day7/index.js

import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';


(function () {
    // --- 插件基础信息 (不变) ---
    const extensionName = "day7";
    const pluginFolderName = "day7";
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`;
    const extensionSettings = extension_settings[extensionName] || {};
    const defaultSettings = {};

    // --- 插件状态变量 ---
    let day1Worker;
    let lastCalculatedPromptTokens = 0;
    let lastUsedApi = '';
    let pendingTokenConsumptionLog = false;
    let lastVisibleTimestamp = null;
    let currentEntityId = null;
    let currentEntityName = null;
    let entityStartTime = null;
    // *** 新增：存储当前选择查看的日期字符串 ***
    let selectedDateString = new Date().toISOString().split('T')[0];

    const GLOBAL_STATS_ID = '_GLOBAL_STATS_';
    const LOG_PREFIX_MAIN = `[Day1 DBG Main ${new Date().toISOString()}]`;

    // --- IndexedDB 相关 (不变) ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;
    // ... openDBMain, getAllStats (不变) ...
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


    // --- Worker 通信 (不变) ---
    // ... sendMessageToWorker ...
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) { console.error(`${LOG_PREFIX_MAIN} Worker not initialized! Cannot send message.`); return; }
        try {
             console.log(`${LOG_PREFIX_MAIN} Sending command to worker:`, { command, payload });
             day1Worker.postMessage({ command, payload });
        } catch (error) {
             console.error(`${LOG_PREFIX_MAIN} Error posting message to worker:`, error, { command, payload });
        }
    }

    // --- 时长处理函数 (不变) ---
    // ... recordVisibleDuration, recordEntityDuration, handleVisibilityChange ...
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
        if (typeof ms !== 'number' || ms <= 0) return '0s';
        let seconds = Math.floor(ms / 1000);
        let minutes = Math.floor(seconds / 60);
        let hours = Math.floor(minutes / 60);
        seconds %= 60; minutes %= 60;
        let result = '';
        if (hours > 0) result += `${hours}h `;
        if (minutes > 0) result += `${minutes}m `;
        if (seconds >= 0) result += `${seconds}s`;
        return result.trim() || '0s';
    }

    // *** 修改：updateStatsTable 接受日期参数 ***
    async function updateStatsTable(targetDateString) {
        // 如果没有提供日期，则使用当前选择的日期
        targetDateString = targetDateString || selectedDateString;
        console.log(`${LOG_PREFIX_MAIN} updateStatsTable called for date: ${targetDateString}`);

        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) { console.log(`${LOG_PREFIX_MAIN} Table body not found, exiting updateStatsTable.`); return; }
        tableBody.empty().append(`<tr><td colspan="8"><i>正在加载 ${targetDateString} 的统计数据...</i></td></tr>`);

        try {
            const allStats = await getAllStats();
            console.log(`${LOG_PREFIX_MAIN} Fetched all stats data for date ${targetDateString}`);
            tableBody.empty();

            if (allStats.length === 0) {
                 console.log(`${LOG_PREFIX_MAIN} No stats data found at all.`);
                 tableBody.append('<tr><td colspan="8"><i>暂无任何统计数据。</i></td></tr>');
                return;
            }

            // 获取选定日期的全局数据
            const globalStatEntry = allStats.find(s => s.entityId === GLOBAL_STATS_ID);
            const dailyGlobalData = globalStatEntry?.dailyData?.[targetDateString]; // 使用 targetDateString
            const selectedDayTotalDurationMs = dailyGlobalData?.totalVisibleDurationMs || 0;
            const selectedDayTotalDurationStr = formatDuration(selectedDayTotalDurationMs);
            console.log(`${LOG_PREFIX_MAIN} Selected Date (${targetDateString}) Global Visible Duration: ${selectedDayTotalDurationMs}ms (${selectedDayTotalDurationStr})`);

            let hasDataForSelectedDate = false;
            const entityStatsList = allStats
                .filter(s => s.entityId !== GLOBAL_STATS_ID)
                .sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            entityStatsList.forEach(entityStats => {
                // 获取选定日期的实体数据
                const dailyData = entityStats.dailyData ? entityStats.dailyData[targetDateString] : null; // 使用 targetDateString
                console.log(`${LOG_PREFIX_MAIN} Processing entity: ${entityStats.entityId} for date ${targetDateString}, DailyData:`, dailyData);

                // 提取选定日期的数据，如果不存在则为 0 或 null
                const userMessages = dailyData?.userMessages || 0;
                const userTokens = dailyData?.userTokens || 0;
                const aiMessages = dailyData?.aiMessages || 0;
                const aiTokens = dailyData?.aiTokens || 0;
                const cumulativeTokens = dailyData?.cumulativeTokens || 0; // 当日 Prompt Tokens 累计
                const totalAiDurationMs = dailyData?.totalAiResponseDuration || 0; // 当日 AI 总耗时
                const dailyEntityDurationMs = dailyData?.dailyInteractionDurationMs || 0; // 当日实体交互时长

                // 总交互时长是根级别的，与日期无关
                const totalInteractionDurationMs = entityStats.totalInteractionDurationMs || 0;

                console.log(`${LOG_PREFIX_MAIN} Entity ${entityStats.entityId} - Date ${targetDateString}: Daily Duration: ${dailyEntityDurationMs}ms, AI Duration: ${totalAiDurationMs}ms. Total Interaction: ${totalInteractionDurationMs}ms`);

                const totalAiDurationStr = formatDuration(totalAiDurationMs);
                const totalInteractionDurationStr = formatDuration(totalInteractionDurationMs); // 总时长不变
                const dailyEntityDurationStr = formatDuration(dailyEntityDurationMs);

                // 标记是否有任何实体在选定日期有数据
                hasDataForSelectedDate = hasDataForSelectedDate || !!dailyData;

                // 生成表格行 (列标题已在 HTML 中修改)
                const row = `
                    <tr>
                        <td>${entityStats.entityName || entityStats.entityId}</td>
                        <td>${userMessages} (${userTokens} tk)</td>
                        <td>${aiMessages} (${aiTokens} tk)</td>
                        <td>${cumulativeTokens} tk</td>
                        <td>${totalAiDurationStr}</td>
                        <td>${dailyEntityDurationStr}</td>
                        <td>${totalInteractionDurationStr}</td>   <%-- 总交互时长 --%>
                        <td>${selectedDayTotalDurationStr}</td> <%-- 选定日总在线时长 --%>
                    </tr>
                `;
                // 只添加当天有数据的行吗？或者都添加，让没有数据的显示 0？ -> 显示所有实体，没有数据的自然是 0
                tableBody.append(row);
            });

            // 如果没有任何实体在选定日期有数据，显示提示
            if (!hasDataForSelectedDate && entityStatsList.length > 0) {
                 console.log(`${LOG_PREFIX_MAIN} No entity data found for selected date (${targetDateString}).`);
                 // 保留已添加的行（它们会显示0），但可以加个总提示
                 // tableBody.append(`<tr><td colspan="8"><i>选定日期 (${targetDateString}) 没有聊天记录。</i></td></tr>`);
                 // 或者在表头下方加提示？目前让数据行显示0可能更清晰
            } else if (entityStatsList.length === 0) {
                // 如果根本没有实体数据（除了全局）
                tableBody.append(`<tr><td colspan="8"><i>还没有任何角色/群组的统计记录。</i></td></tr>`);
            }

             console.log(`${LOG_PREFIX_MAIN} updateStatsTable for ${targetDateString} finished successfully.`);

        } catch (error) {
            console.error(`${LOG_PREFIX_MAIN} Error fetching or updating stats table for ${targetDateString}:`, error);
            tableBody.empty().append(`<tr><td colspan="8"><i style="color: red;">加载 ${targetDateString} 统计数据失败，请检查控制台。</i></td></tr>`);
        }
    }


    // --- 事件处理 (handleMessage, onMessageSent - 不变) ---
    // ... handleMessage, onMessageSent ...
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
        // 发送给 worker 的数据不变，worker 会根据 timestamp 存到对应日期
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

    // --- 事件处理 (onChatChanged - 不变，只影响实时追踪) ---
    // ... onChatChanged ... (里面的 updateStatsTable() 调用需要修改)
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

        // 记录切换前的时长 (不变)
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
            // 重置新实体的开始时间 (不变)
            if (document.visibilityState === 'visible' && currentEntityId) {
                entityStartTime = Date.now();
                console.log(`${LOG_PREFIX_MAIN} Set new entityStartTime for ${currentEntityId}:`, entityStartTime);
            } else {
                entityStartTime = null;
                 console.log(`${LOG_PREFIX_MAIN} Visibility not visible or no new entity, entityStartTime set to null.`);
            }
            pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0; lastUsedApi = '';
            // *** 修改：调用 updateStatsTable 时传入当前选择的日期 ***
            updateStatsTable(selectedDateString);
        } else if (newEntityId === null && currentEntityId !== null) {
             console.log(`${LOG_PREFIX_MAIN} Entity changed from ${currentEntityId} to null.`);
             currentEntityId = null; currentEntityName = null; entityStartTime = null;
             // *** 修改：调用 updateStatsTable 时传入当前选择的日期 ***
             updateStatsTable(selectedDateString);
        } else {
             console.log(`${LOG_PREFIX_MAIN} Entity ID did not change (${currentEntityId}).`);
             // 实体未变时是否也需要刷新？取决于需求，目前不刷新
             // updateStatsTable(selectedDateString);
        }
    }

    // --- 插件初始化 ---
    jQuery(async () => {
        console.log(`${LOG_PREFIX_MAIN} Initializing extension...`);
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });

        try {
            await openDBMain();
            console.log(`${LOG_PREFIX_MAIN} Initial DB open successful.`);
        } catch (error) { console.error(`${LOG_PREFIX_MAIN} DB init failed:`, error); }

        try {
            console.log(`${LOG_PREFIX_MAIN} Rendering settings UI...`);
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            const targetContainer = $('#extensions_settings') || $('#extension_settings') || $('body');
            if (targetContainer.length) {
                targetContainer.append(settingsHtml);

                // *** 获取新添加的 UI 元素 ***
                const dateSelector = $('#day1-date-selector');
                const gotoTodayButton = $('#day1-goto-today-button');
                const refreshButton = $('#day1-refresh-button'); // 已有按钮

                // *** 初始化日期选择器为当天 ***
                dateSelector.val(selectedDateString);
                console.log(`${LOG_PREFIX_MAIN} Date selector initialized to: ${selectedDateString}`);

                // *** 日期选择器改变事件 ***
                dateSelector.on('change', () => {
                    const newDate = dateSelector.val();
                    if (newDate && newDate !== selectedDateString) {
                        console.log(`${LOG_PREFIX_MAIN} Date selected: ${newDate}`);
                        selectedDateString = newDate;
                        updateStatsTable(selectedDateString); // 使用新日期更新表格
                    } else {
                        console.log(`${LOG_PREFIX_MAIN} Date selector changed but value is invalid or same.`);
                    }
                });

                // *** “跳转到今天”按钮点击事件 ***
                gotoTodayButton.on('click', () => {
                    const todayStr = new Date().toISOString().split('T')[0];
                    console.log(`${LOG_PREFIX_MAIN} Go to Today button clicked.`);
                    if (selectedDateString !== todayStr) {
                        selectedDateString = todayStr;
                        dateSelector.val(selectedDateString); // 更新输入框显示
                        updateStatsTable(selectedDateString); // 更新表格
                    } else {
                         console.log(`${LOG_PREFIX_MAIN} Already on today's date.`);
                    }
                });

                // *** 修改“刷新统计”按钮点击事件 ***
                refreshButton.on('click', () => {
                    console.log(`${LOG_PREFIX_MAIN} Refresh button clicked for date: ${selectedDateString}`);

                    // 1. 记录当前实时时长（如果页面可见），这部分逻辑与日期选择无关，总是记录“现在”
                    if (document.visibilityState === 'visible') {
                        console.log(`${LOG_PREFIX_MAIN} Refresh clicked while visible. Recording current real-time durations before update...`);
                        recordVisibleDuration();
                        lastVisibleTimestamp = Date.now(); // 重置以继续追踪
                        recordEntityDuration();
                        if (currentEntityId) {
                            entityStartTime = Date.now(); // 重置以继续追踪
                        }
                        console.log(`${LOG_PREFIX_MAIN} Reset real-time timestamps after manual record.`);
                    } else {
                        console.log(`${LOG_PREFIX_MAIN} Refresh clicked while not visible. Real-time durations should have been recorded.`);
                    }

                    // 2. （可选延迟后）更新表格，显示的是当前选定日期的数据
                    setTimeout(() => {
                        console.log(`${LOG_PREFIX_MAIN} Updating stats table display for selected date: ${selectedDateString}.`);
                        updateStatsTable(selectedDateString); // 使用当前选定的日期刷新
                    }, 50);
                });

                console.log(`${LOG_PREFIX_MAIN} Settings UI appended and listeners attached.`);
                // *** 初始加载时使用选定日期（即当天） ***
                setTimeout(() => updateStatsTable(selectedDateString), 500);

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

        // --- 注册核心事件监听器 (GENERATE_AFTER_DATA, MESSAGE_RECEIVED, GENERATION_STOPPED - 不变) ---
         console.log(`${LOG_PREFIX_MAIN} Registering core event listeners...`);
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent); // (不变)
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged); // (内部调用 updateStatsTable 已修改)
        eventSource.on(event_types.GENERATE_AFTER_DATA, async (generateData) => {
             console.log(`${LOG_PREFIX_MAIN} GENERATE_AFTER_DATA event received.`);
            const context = getContext();
            const currentApi = generateData.type || context.mainApi || mainApi;
            if (generateData.dryRun || !currentEntityId) { console.log(`${LOG_PREFIX_MAIN} GENERATE_AFTER_DATA skipped (dryRun or no entityId).`); return; }
            try {
                let promptTokens = 0;
                const power_user = extension_settings?.power_user ?? {};
                if (currentApi === 'openai' || generateData.is_openai) {
                     if (Array.isArray(generateData.prompt)) {
                        promptTokens = (await Promise.all(generateData.prompt.map(m => getTokenCountAsync(m.content || '', 0)))).reduce((s, c) => s + c, 0);
                     } else if (typeof generateData.prompt === 'string') {
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
            if (context?.chat?.[messageId] && !context.chat[messageId].is_user && !context.chat[messageId].is_system) handleMessage(context.chat[messageId], false); // (不变)
            if (pendingTokenConsumptionLog && currentEntityId) {
                 console.log(`${LOG_PREFIX_MAIN} Pending prompt token log found. Sending to worker.`);
                sendMessageToWorker('recordPromptTokens', { entityId: currentEntityId, entityName: currentEntityName, timestamp: Date.now(), promptTokenCount: lastCalculatedPromptTokens }); // (不变)
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
                pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0; // (不变)
            }
        });

        // --- 添加 visibilitychange 监听器 (不变) ---
         console.log(`${LOG_PREFIX_MAIN} Adding visibilitychange listener.`);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // --- 初始化时处理当前状态 (不变，但 onChatChanged 内部调用 updateStatsTable 已修改) ---
         console.log(`${LOG_PREFIX_MAIN} Initializing state based on current context...`);
        const initialContext = getContext();
        onChatChanged(initialContext?.chatId); // 会设置 currentEntityId 并调用 updateStatsTable(selectedDateString)
        if (document.visibilityState === 'visible') {
            console.log(`${LOG_PREFIX_MAIN} Document initially visible. Setting initial timestamps.`);
            lastVisibleTimestamp = Date.now();
            if (currentEntityId) { // 确保 currentEntityId 已被 onChatChanged 设置
                entityStartTime = Date.now();
            }
             console.log(`${LOG_PREFIX_MAIN} Initial lastVisibleTimestamp: ${lastVisibleTimestamp}, initial entityStartTime: ${entityStartTime}`);
        } else {
             console.log(`${LOG_PREFIX_MAIN} Document initially hidden.`);
             lastVisibleTimestamp = null;
             entityStartTime = null;
        }

        console.log(`${LOG_PREFIX_MAIN} Initialization complete.`);
    });

})();
