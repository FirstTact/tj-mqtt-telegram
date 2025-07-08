const TelegramBot = require('node-telegram-bot-api');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Загрузка конфига
const config = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'newShema.json'), 'utf8')
);

// Инициализация бота
const token = config.botKey;
const bot = new TelegramBot(token, { polling: true });

// Хранение текущего состояния пользователей
const userState = {};

// MQTT клиент
const client = mqtt.connect('mqtt://' + config.ip, {
    port: 1883,
});

// Хранилище последних значений по топикам
const mqttValues = {};

// === [1] Подписка на топики из warning и keyboards ===
let isInitialConnection = true;

// Подписка на топики
function subscribeToTopics() {
    const topics = new Set();

    // warning
    config.warning.forEach(w => {
        if (w.topic) topics.add(w.topic);
    });

    // keyboards
    config.keyboards.forEach(kb => {
        kb.buttons.forEach(btn => {
            if (btn.strings) {
                btn.strings.forEach(str => {
                    if (str.topic) topics.add(str.topic);
                });
            }
        });
    });
    // inline_buttons
    config.inline_buttons.forEach(btn => {
        btn.topics.forEach(topicData => {
            topics.add(topicData.topic);
        });
    });

    const subscriptionOptions = {};
    Array.from(topics).forEach(topic => {
        subscriptionOptions[topic] = { qos: 0 };
    });

    client.subscribe(subscriptionOptions, (err) => {
        if (err) {
            console.error("Ошибка подписки:", err);
        } else {
            console.log(`Подписано на ${topics.size} уникальных топиков`);
            setTimeout(() => {
                isInitialConnection = false;
                console.log("Режим игнорирования завершён");
            }, 2000);
        }
    });
}
// === [2] Обработка входящих MQTT сообщений ===
const latestValues = {}; // Хранилище последних значений по топикам

function updateAndLogValue(topic, payload) {
    const value = payload.toString().trim();
    console.log(`[MQTT] Получено сообщение: ${topic} = ${value}`);

    if (latestValues[topic] !== value) {
        latestValues[topic] = value;
        return { value, changed: true };
    }

    return { value, changed: false };
}

client.on('message', (topic, message) => {
    const { value, changed } = updateAndLogValue(topic, message);

    // Ищем совпадение в warning
    const alert = config.warning.find(w => w.topic === topic);
    if (!alert || !alert.message) return;

    let msgText = null;

    // ====== [1] Поддержка массива сообщений с toStart ======
    if (Array.isArray(alert.message)) {
        const matched = alert.message.find(m => m.value == value); // eslint-disable-line eqeqeq
        if (matched) {
            // Проверяем флаг toStart
            if (isInitialConnection && matched.toStart === false) {
                console.log(`Сообщение для ${topic} проигнорировано из-за toStart: false`);
                return;
            }

            // Проверяем block
            if (matched.block && Array.isArray(matched.block)) {
                const shouldBlock = matched.block.some(blockRule => {
                    const blockedValue = latestValues[blockRule.topic];
                    const expectedValue = blockRule.value.toString();

                    if (blockedValue === undefined) {
                        console.warn(`[BLOCK] Топик "${blockRule.topic}" ещё не имеет значения. Пропуск.`);
                        return false;
                    }

                    if (blockedValue === expectedValue) {
                        console.log(`[BLOCK] Уведомление заблокировано: ${blockRule.topic} = ${expectedValue}`);
                        return true;
                    }

                    return false;
                });

                if (shouldBlock) {
                    console.log(`[BLOCK] Сообщение для "${topic}" отменено`);
                    return;
                }
            }

            msgText = matched.text;
        }
    }

    // ====== [2] Поддержка on/off сообщений ======
    else if (typeof alert.message === 'object' && alert.message.off_value && alert.message.on_value) {
        if (value === "1") {
            msgText = alert.message.on_value.replace('${value}', value);
        } else if (value === "0") {
            msgText = alert.message.off_value.replace('${value}', value);
        }

        // Проверка block на уровне alert.message
        if (alert.message.block && Array.isArray(alert.message.block)) {
            const shouldBlock = alert.message.block.some(blockRule => {
                const blockedValue = latestValues[blockRule.topic];
                const expectedValue = blockRule.value.toString();

                if (blockedValue === undefined) {
                    console.warn(`[BLOCK] Топик "${blockRule.topic}" ещё не имеет значения. Пропуск.`);
                    return false;
                }

                if (blockedValue === expectedValue) {
                    console.log(`[BLOCK] Уведомление заблокировано: ${blockRule.topic} = ${expectedValue}`);
                    return true;
                }

                return false;
            });

            if (shouldBlock) {
                console.log(`[BLOCK] Сообщение для "${topic}" отменено через block`);
                return;
            }
        }
    }

    // ====== [3] Поддержка trigger_values ======
    else if (typeof alert.message === 'object' && Array.isArray(alert.message.trigger_values)) {
        const numericValue = parseFloat(value);
        if (isNaN(numericValue)) {
            console.warn(`Значение "${value}" не является числом для топика "${topic}". Пропуск.`);
            return;
        }

        for (const rule of alert.message.trigger_values) {
            const threshold = parseFloat(rule.value);
            if (rule.action === "<=" && numericValue <= threshold) {
                msgText = rule.text.replace('${value}', numericValue.toFixed(1));
                break;
            } else if (rule.action === ">" && numericValue > threshold) {
                msgText = rule.text.replace('${value}', numericValue.toFixed(1));
                break;
            }
        }

        // Проверка block на уровне trigger_values
        if (msgText && alert.block && Array.isArray(alert.block)) {
            const shouldBlock = alert.block.some(blockRule => {
                const blockedValue = latestValues[blockRule.topic];
                const expectedValue = blockRule.value.toString();

                if (blockedValue === undefined) {
                    console.warn(`[BLOCK] Топик "${blockRule.topic}" ещё не имеет значения. Пропуск.`);
                    return false;
                }

                if (blockedValue === expectedValue) {
                    console.log(`[BLOCK] Уведомление заблокировано: ${blockRule.topic} = ${expectedValue}`);
                    return true;
                }

                return false;
            });

            if (shouldBlock) {
                console.log(`[BLOCK] Сообщение для "${topic}" отменено через block`);
                return;
            }
        }
    }

    // ====== [4] Отправка сообщения ======
    if (msgText) {
    config.clients.forEach(chatId => {
        // Создаем инлайн-клавиатуру, если есть inline_button_id
        let keyboard = {};
        if (alert.inline_button_id && Array.isArray(alert.inline_button_id)) {
            keyboard = generateInlineKeyboard(alert.inline_button_id);
        }

        // Отправляем сообщение с возможной клавиатурой
        bot.sendMessage(chatId, msgText, { parse_mode: "Markdown", ...keyboard } || {}).catch(err => {
            console.error(`Не удалось отправить сообщение пользователю ${chatId}:`, err.toString());
        });
    });
}
});

// === [4] Генерация обычной клавиатуры ===
function getKeyboard(listId) {
    const keyboardList = config.keyboards.find(k => k.list_id === listId);
    if (!keyboardList) return null;

    const rows = {};
    keyboardList.buttons.forEach(button => {
        if (!rows[button.row]) rows[button.row] = [];
        rows[button.row].push(button.name);
    });

    return {
        reply_markup: {
            keyboard: Object.values(rows),
            resize_keyboard: true
        }
    };
}

// === [5] Отправка информации о выбранном разделе ===
function showSection(chatId, sectionName) {
    const allButtons = config.keyboards.flatMap(k => k.buttons);
    const section = allButtons.find(btn => btn.name === sectionName);
    if (!section || !section.strings) {
        bot.sendMessage(chatId, "Информация не найдена.");
        return;
    }

    let message = section.heading + "\n";

    section.strings.forEach(str => {
        if (str.text) {
            // Простой текст без динамических данных
            message += `*${str.text}*\n`;

        } else if (Array.isArray(str.message)) {
            // Формат: массив сообщений по значению топика
            const topicValue = latestValues[str.topic] || "N/A";
            const matched = str.message.find(m => m.value == topicValue); // eslint-disable-line eqeqeq
            if (matched) {
                message += `${matched.text.replace('${value}', topicValue)}\n`;
            } else {
                message += `ℹ️ Неизвестное состояние для ${str.topic}: ${topicValue}\n`;
            }

        } else if (str.on_value && str.off_value) {
            // Формат: on/off (1/0)
            const topicValue = latestValues[str.topic] || "N/A";
            const state = topicValue === "1" ? str.on_value : str.off_value;
            message += `${state.replace('${value}', topicValue)}\n`;

        } else if (str.message && typeof str.message === 'string') {
            // Обычный текст с заменой значения
            const topicValue = latestValues[str.topic] || "N/A";
            message += `${str.message.replace('${value}', topicValue)}\n`;

        } else if (str.values) {
            // Диапазонные значения: normal_values и trigger_value
            const val = parseFloat(latestValues[str.topic]);
            if (!isNaN(val)) {
                let matched = false;

                for (let rule of str.values) {
                    // Сначала проверяем normal_values (диапазон)
                    if (rule.normal_values && rule.normal_values.min_value !== undefined && rule.normal_values.max_value !== undefined) {
                        const min = rule.normal_values.min_value;
                        const max = rule.normal_values.max_value;
                        if (val >= min && val <= max) {
                            message += `${rule.normal_values.text.replace('${value}', val.toFixed(2))}\n`;
                            matched = true;
                            break;
                        }
                    }

                    // Затем проверяем trigger_value
                    if (rule.trigger_value !== undefined) {
                        const triggerVal = rule.trigger_value;
                        if (rule.action === "<=" && val <= triggerVal) {
                            message += `${rule.text.replace('${value}', val.toFixed(2))}\n`;
                            matched = true;
                            break;
                        } else if (rule.action === ">" && val > triggerVal) {
                            message += `${rule.text.replace('${value}', val.toFixed(2))}\n`;
                            matched = true;
                            break;
                        }
                    }
                }

                if (!matched) {
                    message += `ℹ️ Значение вне диапазона: ${val.toFixed(2)}\n`;
                }
            } else {
                message += `ℹ️ Нет данных для ${str.topic}\n`;
            }

        } else if (str.low_warning || str.high_warning || str.low_alarm || str.high_alarm) {
            // Для бассейна: pH, хлор, Redox
            const value = latestValues[str.topic] || "N/A";
            if (value === "N/A") {
                message += `ℹ️ Нет данных для ${str.topic}\n`;
            } else {
                message += `${str.text.replace('${value}', value.toFixed(2))}\n`;

                // Проверяем триггерные топики
                if (str.low_warning && latestValues[str.low_warning.trigger_topic] === "1") {
                    message += `${str.low_warning.text.replace('${value}', value.toFixed(2))}\n`;
                }
                if (str.low_alarm && latestValues[str.low_alarm.trigger_topic] === "1") {
                    message += `${str.low_alarm.text.replace('${value}', value.toFixed(2))}\n`;
                }
                if (str.high_warning && latestValues[str.high_warning.trigger_topic] === "1") {
                    message += `${str.high_warning.text.replace('${value}', value.toFixed(2))}\n`;
                }
                if (str.high_alarm && latestValues[str.high_alarm.trigger_topic] === "1") {
                    message += `${str.high_alarm.text.replace('${value}', value.toFixed(2))}\n`;
                }
            }
        }
    });

        // Генерация инлайн-клавиатуры
    let keyboard = {};
    if (section.inline_button_id && Array.isArray(section.inline_button_id)) {
        keyboard = generateInlineKeyboard(section.inline_button_id);
    }

    // Отправка сообщения с возможной клавиатурой
    bot.sendMessage(chatId, message, { parse_mode: "Markdown", ...keyboard }).catch(err => {
        console.error(`Не удалось отправить сообщение пользователю ${chatId}:`, err.toString());
    });
}
// === [6] Обработчики событий Telegram ===

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    // Проверяем, есть ли такой клиент в списке разрешённых
    if (!config.clients.includes(chatId)) {
        console.warn(`[ACCESS DENIED] Пользователь ${chatId} не в списке разрешённых`);
        bot.sendMessage(chatId, "❌ У вас нет доступа к этому боту.");
        return;
    }

    // Если всё ок — продолжаем работу
    userState[chatId] = { currentList: 1 };
    sendMenu(chatId, 1);
});
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

        console.log(`[LOG] Получено сообщение от пользователя ${chatId}: "${text}"`);
    // Ищем кнопку по имени
    const allButtons = config.keyboards.flatMap(kb => kb.buttons);
    const foundButton = allButtons.find(btn => btn.name === text);

    if (!foundButton) {
        bot.sendMessage(chatId, "Неизвестная команда.");
        return;
    }

    // Если есть change_list — переключаемся на нужный лист
    if (foundButton.change_list !== undefined) {
        const targetListId = foundButton.change_list;
        const targetList = config.keyboards.find(kb => kb.list_id === targetListId);

        if (targetList) {
            sendMenu(chatId, targetListId);
        } else {
            bot.sendMessage(chatId, "Ошибка: указанная страница не найдена.");
        }

    } else if (foundButton.heading) {
        // Отображаем информацию о разделе
        showSection(chatId, text);
    }
});
function sendMenu(chatId, listId) {
    const keyboard = getKeyboard(listId);
    bot.sendMessage(chatId, "Выберите раздел:", keyboard);
}

function generateInlineKeyboard(inlineButtonIds) {
    const inlineButtons = config.inline_buttons.filter(btn => inlineButtonIds.includes(btn.id));
    if (!inlineButtons.length) return null;

    // Группируем кнопки по строкам
    const rows = {};
    inlineButtons.forEach(button => {
        if (!rows[button.row]) rows[button.row] = [];
        rows[button.row].push({
            text: button.text,
            callback_data: `inline_btn:${button.id}`
        });
    });

    // Сортируем строки и кнопки внутри строк
    const sortedRows = Object.keys(rows)
        .sort((a, b) => a - b) // Сортировка по row
        .map(rowKey => rows[rowKey].sort((a, b) => a.order - b.order)); // Сортировка по order

    return {
        reply_markup: {
            inline_keyboard: sortedRows
        }
    };
}

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('inline_btn:')) {
        const buttonId = parseInt(data.split(':')[1]);
        const button = config.inline_buttons.find(btn => btn.id === buttonId);

        if (!button) {
            bot.answerCallbackQuery(query.id, { text: "Ошибка: кнопка не найдена." });
            return;
        }

        // Отправляем значения в MQTT-топики
        button.topics.forEach(topicData => {
            client.publish(topicData.topic, topicData.value.toString(), { qos: 0 }, (err) => {
                if (err) {
                    console.error(`Ошибка публикации в топик ${topicData.topic}:`, err);
                } else {
                    console.log(`Успешно отправлено значение ${topicData.value} в топик ${topicData.topic}`);
                }
            });
        });

        // Отправляем уведомление пользователю
        bot.answerCallbackQuery(query.id, { text: button.message });
    }
});

// === [7] Подключение к MQTT ===
client.on('connect', () => {
    console.log("MQTT подключен");
    subscribeToTopics();
    
    setTimeout(() => {
        isInitialConnection = false;
        console.log("Режим игнорирования завершён. Теперь бот будет реагировать на все изменения.");
    }, 2000);
});