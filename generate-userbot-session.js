/**
 * generate-userbot-session.js
 *
 * Запускается ОДИН РАЗ вручную и интерактивно (руками вводишь номер
 * телефона, код из Telegram и, если включена, облачный пароль), чтобы
 * один раз войти в личный Telegram-аккаунт (тот, что принимает подарки —
 * "хранилище") и получить session-строку. Дальше эта строка вставляется в
 * переменную TELEGRAM_USERBOT_SESSION на Railway, и userbot.js
 * переиспользует её без повторного входа.
 *
 * Как запустить:
 *   1. Локально на своём компьютере (проще всего):
 *      - убедись, что стоит Node.js
 *      - в папке проекта: npm install
 *      - node generate-userbot-session.js
 *   2. Или через Railway → сервис → Console (Shell) — так же: node generate-userbot-session.js
 *
 * Перед запуском нужно один раз получить TELEGRAM_API_ID и
 * TELEGRAM_API_HASH на https://my.telegram.org/apps (раздел "API development
 * tools", создать любое приложение — можно назвать как угодно). Это НЕ
 * то же самое, что BOT_TOKEN.
 *
 * ⚠️ Полученная в конце строка — это полный доступ к аккаунту. Не показывай
 * её никому, не публикуй в чатах/скриншотах, сразу вставь в Variables на
 * Railway как TELEGRAM_USERBOT_SESSION и удали из истории терминала, если
 * запускал локально (Ctrl+L / clear).
 */

const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const apiHash = process.env.TELEGRAM_API_HASH || '';

if (!apiId || !apiHash) {
    console.error('⛔ Задай TELEGRAM_API_ID и TELEGRAM_API_HASH перед запуском (переменные окружения или прямо в этой сессии терминала).');
    console.error('   Получить: https://my.telegram.org/apps');
    process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
    return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function main() {
    console.log('=== Вход в личный Telegram-аккаунт (для юзербота) ===');
    console.log('Вводи данные ТОГО аккаунта, куда пользователи присылают подарки.\n');

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

    await client.start({
        phoneNumber: async () => await ask('Номер телефона (с кодом страны, напр. +380...): '),
        password: async () => await ask('Облачный пароль (если не включён — просто нажми Enter): '),
        phoneCode: async () => await ask('Код из Telegram (пришёл в само приложение/SMS): '),
        onError: (err) => console.error('Ошибка входа:', err.message),
    });

    console.log('\n✅ Вход выполнен успешно!\n');
    console.log('Скопируй ВСЮ строку ниже и вставь как значение переменной TELEGRAM_USERBOT_SESSION на Railway:\n');
    console.log(client.session.save());
    console.log('\n⚠️ Никому не показывай эту строку — это полный доступ к аккаунту.');

    await client.disconnect();
    rl.close();
    process.exit(0);
}

main().catch(e => {
    console.error('Не удалось войти:', e);
    process.exit(1);
});
