const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const { findOrCreateUser, getUserByTgId, adjustBalance } = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '';

if (!BOT_TOKEN) {
    console.warn('⚠️  BOT_TOKEN не задан — авторизация всегда будет отклоняться!');
}

function checkTelegramAuth(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;

        params.delete('hash');

        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();

        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        return calculatedHash === hash;
    } catch (e) {
        console.error('Ошибка проверки:', e);
        return false;
    }
}

/**
 * Простое middleware для защищённых маршрутов.
 * Пока без JWT — клиент присылает initData в заголовке на каждый запрос,
 * мы её проверяем и достаём tg_id. Это ок для старта, но в будущем
 * стоит заменить на выдачу токена при логине (см. TODO ниже).
 */
function requireAuth(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];

    if (!initData || !checkTelegramAuth(initData)) {
        return res.status(401).json({ ok: false, error: 'Не авторизован' });
    }

    const params = new URLSearchParams(initData);
    const tgUser = JSON.parse(params.get('user') || '{}');

    if (!tgUser.id) {
        return res.status(401).json({ ok: false, error: 'Нет данных пользователя' });
    }

    req.tgUser = tgUser;
    next();
}

// === Авторизация: проверяем подпись и сохраняем/обновляем пользователя в БД ===
app.post('/api/auth', (req, res) => {
    const { initData } = req.body;

    if (!initData) {
        return res.status(400).json({ ok: false, error: 'Нет initData' });
    }

    if (!checkTelegramAuth(initData)) {
        return res.status(401).json({ ok: false, error: 'Неверная подпись' });
    }

    const params = new URLSearchParams(initData);
    const tgUser = JSON.parse(params.get('user') || '{}');

    const user = findOrCreateUser(tgUser);

    console.log('Успешный вход:', user.tg_id, user.username);

    res.json({
        ok: true,
        user: {
            id: user.tg_id,
            first_name: user.first_name,
            last_name: user.last_name,
            username: user.username,
            photo_url: user.photo_url,
            balance: user.balance,
        },
    });
});

// === Получить актуальный баланс ===
app.get('/api/balance', requireAuth, (req, res) => {
    const user = getUserByTgId(req.tgUser.id);

    if (!user) {
        return res.status(404).json({ ok: false, error: 'Пользователь не найден' });
    }

    res.json({ ok: true, balance: user.balance });
});

// === Пополнение баланса ===
// ВАЖНО: сейчас это просто прибавляет сумму без проверки реального платежа.
// Это заглушка на время, пока не подключён приём настоящих TON-транзакций —
// когда дойдём до TON Connect, сюда добавится проверка транзакции в блокчейне.
app.post('/api/deposit', requireAuth, (req, res) => {
    const amount = parseFloat(req.body.amount);

    if (!amount || amount < 0.01) {
        return res.status(400).json({ ok: false, error: 'Минимальная сумма для пополнения: 0.01' });
    }

    const user = adjustBalance(req.tgUser.id, amount);
    res.json({ ok: true, balance: user.balance });
});

// === Вывод средств ===
app.post('/api/withdraw', requireAuth, (req, res) => {
    const amount = parseFloat(req.body.amount);

    if (!amount || amount < 0.5) {
        return res.status(400).json({ ok: false, error: 'Минимальная сумма для вывода: 0.5' });
    }

    try {
        const user = adjustBalance(req.tgUser.id, -amount);
        res.json({ ok: true, balance: user.balance });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.get('/', (req, res) => {
    res.send('BoomMarket Backend работает');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
