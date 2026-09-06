/**
 * userbot.js
 *
 * Перевод NFT-подарков через ОБЫЧНЫЙ Telegram-аккаунт (не через Bot API),
 * с помощью библиотеки GramJS (протокол MTProto — тот же, что использует
 * официальное приложение Telegram). Нужен потому, что метод бота
 * transferGift сейчас требует право "Передача и улучшение подарков",
 * которое Telegram временно не выдаёт (см. обсуждение в чате) — а вот
 * обычный человек в приложении дарить подарки может всегда, и юзербот
 * действует ровно так же, только автоматически.
 *
 * ⚠️ ВАЖНО ПРО БЕЗОПАСНОСТЬ:
 * TELEGRAM_USERBOT_SESSION — это ПОЛНЫЙ доступ к личному Telegram-аккаунту
 * (тому самому, куда падают подарки). Он ничем не отличается по
 * чувствительности от TON_WITHDRAW_MNEMONIC — если он утечёт, кто-то
 * получит доступ ко всем подаркам и сможет писать от имени аккаунта.
 * Никогда не логировать, не коммитить в git, хранить только в Variables
 * на Railway.
 *
 * ⚠️ ВАЖНО ПРО ПРАВИЛА TELEGRAM:
 * Это автоматизация личного аккаунта сторонним кодом — Telegram официально
 * это не запрещает, но и не даёт таких же гарантий, как Bot API. Слишком
 * частые/резкие действия могут вызвать временные ограничения (FloodWait)
 * или, в теории, ручную проверку аккаунта антиспам-системой. Поэтому здесь
 * есть искусственная пауза перед каждым переводом и обработка FloodWaitError.
 *
 * Разовая настройка (см. generate-userbot-session.js рядом):
 *   1. node generate-userbot-session.js  — один раз, интерактивно, локально
 *      или через Railway Console (Shell) — введёшь номер телефона, код из
 *      Telegram, и (если включена) облачную. Скрипт напечатает длинную
 *      строку — это и есть session.
 *   2. Вставить эту строку в переменную TELEGRAM_USERBOT_SESSION на Railway.
 *   3. Также нужны TELEGRAM_API_ID и TELEGRAM_API_HASH — получить один раз
 *      на https://my.telegram.org/apps (это НЕ то же самое, что BOT_TOKEN).
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELEGRAM_USERBOT_SESSION = process.env.TELEGRAM_USERBOT_SESSION || '';

function isUserbotConfigured() {
    return Boolean(TELEGRAM_API_ID && TELEGRAM_API_HASH && TELEGRAM_USERBOT_SESSION);
}

// Один клиент на весь процесс — поднимается лениво при первом обращении,
// дальше переиспользуется (пересоздавать соединение на каждый перевод и
// дорого, и подозрительно с точки зрения антиспама Telegram).
let clientPromise = null;
function getClient() {
    if (!isUserbotConfigured()) {
        throw new Error('Юзербот не настроен: нужны TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_USERBOT_SESSION');
    }
    if (!clientPromise) {
        clientPromise = (async () => {
            const client = new TelegramClient(
                new StringSession(TELEGRAM_USERBOT_SESSION),
                TELEGRAM_API_ID,
                TELEGRAM_API_HASH,
                { connectionRetries: 5 }
            );
            await client.connect();
            return client;
        })();
    }
    return clientPromise;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Переводит подарок с уникальным идентификатором (slug из ссылки
 * t.me/nft/<slug>) на аккаунт получателя. recipientUsername — username
 * получателя БЕЗ "@" (обязателен: без username надёжно адресовать
 * человека по протоколу нельзя — см. комментарий у вызова в server.js).
 *
 * Бросает исключение с понятным текстом при любой ошибке — вызывающий
 * код (server.js) сам решает, что ответить пользователю/показать в логах.
 */
async function transferGiftViaUserbot(giftSlug, recipientUsername) {
    if (!giftSlug) throw new Error('Не найден slug подарка — перевод через юзербота невозможен');
    if (!recipientUsername) throw new Error('У получателя не задан username в Telegram — юзербот не может адресовать перевод');

    const client = await getClient();

    // Небольшая случайная пауза перед действием — не даёт всем переводам идти
    // "пулемётом" один за другим, что выглядело бы подозрительно для Telegram.
    await sleep(800 + Math.floor(Math.random() * 700));

    let recipientEntity;
    try {
        recipientEntity = await client.getEntity(recipientUsername);
    } catch (e) {
        throw new Error(`Не удалось найти пользователя @${recipientUsername} в Telegram: ${e.message}`);
    }

    try {
        // InputSavedStarGiftSlug — ссылается на конкретный уникальный подарок
        // на ТЕКУЩЕМ (self) аккаунте по его публичному slug. TransferStarGift —
        // тот же метод, которым официальный клиент Telegram дарит подарок
        // другому пользователю из своего профиля.
        const result = await client.invoke(
            new Api.payments.TransferStarGift({
                stargift: new Api.InputSavedStarGiftSlug({ slug: giftSlug }),
                toId: recipientEntity,
            })
        );
        return result;
    } catch (e) {
        // FloodWaitError — Telegram просит подождать N секунд, прежде чем
        // пробовать снова. Пробрасываем как есть с понятным текстом, чтобы
        // server.js мог вернуть внятную ошибку и НЕ списывать/не отмечать
        // подарок выведенным.
        if (e.seconds) {
            throw new Error(`Telegram просит подождать ${e.seconds} сек. перед следующим переводом (антифлуд), попробуйте позже`);
        }
        throw new Error(`Ошибка перевода подарка через юзербота: ${e.message}`);
    }
}

module.exports = {
    isUserbotConfigured,
    transferGiftViaUserbot,
};
