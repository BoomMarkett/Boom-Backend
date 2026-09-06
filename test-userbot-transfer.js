/**
 * test-userbot-transfer.js
 *
 * Ручная проверка ОДНОГО перевода через юзербота — запускать перед тем, как
 * включать этот механизм для реальных пользователей. Требует, чтобы
 * TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_USERBOT_SESSION уже были
 * заданы (см. generate-userbot-session.js).
 *
 * Запуск:
 *   node test-userbot-transfer.js <slug_подарка> <username_получателя_без_@>
 *
 * slug подарка — это то, что после t.me/nft/ в ссылке на конкретный
 * подарок (например, для https://t.me/nft/PlushPepe-100 slug = "PlushPepe-100").
 * Посмотреть slug можно, открыв подарок в самом Telegram → "Поделиться" →
 * скопировать ссылку.
 */

const { transferGiftViaUserbot, isUserbotConfigured } = require('./userbot');

async function main() {
    const [, , slug, username] = process.argv;

    if (!slug || !username) {
        console.error('Использование: node test-userbot-transfer.js <slug_подарка> <username_получателя_без_@>');
        process.exit(1);
    }

    if (!isUserbotConfigured()) {
        console.error('⛔ Юзербот не настроен — проверь TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_USERBOT_SESSION.');
        process.exit(1);
    }

    console.log(`Пробую перевести подарок "${slug}" пользователю @${username}...`);

    try {
        const result = await transferGiftViaUserbot(slug, username);
        console.log('\n✅ Перевод прошёл успешно! Ответ Telegram:');
        console.log(result);
    } catch (e) {
        console.error('\n❌ Перевод не удался:');
        console.error(e.message);
        console.error('\nЕсли ошибка про "неизвестный метод/класс" — значит, в установленной версии');
        console.error('библиотеки telegram (GramJS) немного другое название API-метода. Открой');
        console.error('node_modules/telegram/tl/api.d.ts и поищи там "TransferStarGift" —');
        console.error('пришли мне точное название, поправлю вызов в userbot.js.');
    }

    process.exit(0);
}

main();
