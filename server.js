const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '';

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

app.post('/api/auth', (req, res) => {
    const { initData } = req.body;

    if (!initData) {
        return res.status(400).json({ ok: false, error: 'Нет initData' });
    }

    const isValid = checkTelegramAuth(initData);

    if (!isValid) {
        return res.status(401).json({ ok: false, error: 'Неверная подпись' });
    }

    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user') || '{}');

    console.log('Успешный вход:', user.id, user.username);

    res.json({
        ok: true,
        user: {
            id: user.id,
            first_name: user.first_name,
            last_name: user.last_name,
            username: user.username,
            photo_url: user.photo_url
        }
    });
});

app.get('/', (req, res) => {
    res.send('BoomMarket Backend работает');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});