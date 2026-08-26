const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const {
    findOrCreateUser,
    getUserByTgId,
    adjustBalance,
    listCollections,
    getFiltersForCollection,
    findListings,
    getListingById,
    createListing,
    setListingStatus,
} = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || '';

if (!BOT_TOKEN) {
    console.warn('⚠️  BOT_TOKEN не задан — авторизация всегда будет отклоняться!');
}

if (!JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET не задан — выдача токенов сессии всегда будет отклоняться!');
}

const TOKEN_LIFETIME = '24h';

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
 * Проверяет JWT-токен, присланный клиентом в заголовке Authorization: Bearer <token>.
 * Токен выдаётся один раз при /api/auth и живёт TOKEN_LIFETIME — дальше фронтенд
 * предъявляет его на каждый защищённый запрос вместо пересылки initData целиком.
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ ok: false, error: 'Токен не предоставлен' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.tgId = payload.tgId;
        next();
    } catch (e) {
        return res.status(401).json({ ok: false, error: 'Токен недействителен или истёк' });
    }
}

// === Авторизация: проверяем подпись Telegram, сохраняем пользователя, выдаём JWT ===
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

    const token = jwt.sign({ tgId: user.tg_id }, JWT_SECRET, { expiresIn: TOKEN_LIFETIME });

    console.log('Успешный вход:', user.tg_id, user.username);

    res.json({
        ok: true,
        token,
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
    const user = getUserByTgId(req.tgId);

    if (!user) {
        return res.status(404).json({ ok: false, error: 'Пользователь не найден' });
    }

    res.json({ ok: true, balance: user.balance });
});

// === Пополнение баланса ===
// ВАЖНО: сейчас это просто прибавляет сумму без проверки реального платежа.
// Заглушка на время, пока не подключён приём настоящих TON-транзакций.
app.post('/api/deposit', requireAuth, (req, res) => {
    const amount = parseFloat(req.body.amount);

    if (!amount || amount < 0.01) {
        return res.status(400).json({ ok: false, error: 'Минимальная сумма для пополнения: 0.01' });
    }

    const user = adjustBalance(req.tgId, amount);
    res.json({ ok: true, balance: user.balance });
});

// === Вывод средств ===
app.post('/api/withdraw', requireAuth, (req, res) => {
    const amount = parseFloat(req.body.amount);

    if (!amount || amount < 0.5) {
        return res.status(400).json({ ok: false, error: 'Минимальная сумма для вывода: 0.5' });
    }

    try {
        const user = adjustBalance(req.tgId, -amount);
        res.json({ ok: true, balance: user.balance });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// === Коллекции (для дропдауна "NFT" в фильтрах) ===
app.get('/api/collections', (req, res) => {
    res.json({ ok: true, collections: listCollections() });
});

// === Доступные модели/фоны/символы для конкретной коллекции ===
app.get('/api/collections/:id/filters', (req, res) => {
    const collectionId = parseInt(req.params.id, 10);
    if (!collectionId) {
        return res.status(400).json({ ok: false, error: 'Некорректный id коллекции' });
    }
    res.json({ ok: true, filters: getFiltersForCollection(collectionId) });
});

// === Список активных листингов с фильтрами/сортировкой ===
// GET /api/listings?collectionId=1&model=Apex%20Predator&backdrop=Satin%20Gold&symbol=Coin&search=Evil&sort=price_asc
app.get('/api/listings', (req, res) => {
    const { collectionId, model, backdrop, symbol, search, sort } = req.query;

    const listings = findListings({
        collectionId: collectionId ? parseInt(collectionId, 10) : undefined,
        modelName: model || undefined,
        backdropName: backdrop || undefined,
        symbolName: symbol || undefined,
        search: search || undefined,
        sort: sort || undefined,
    });

    res.json({ ok: true, listings });
});

// === Выставить лот на продажу ===
app.post('/api/listings', requireAuth, (req, res) => {
    const { collectionId, modelId, backdropId, symbolId, giftNumber, nftAddress, price } = req.body;

    const parsedPrice = parseFloat(price);
    if (!collectionId || !giftNumber || !parsedPrice || parsedPrice <= 0) {
        return res.status(400).json({ ok: false, error: 'Заполнены не все обязательные поля' });
    }

    const listing = createListing({
        owner_tg_id: req.tgId,
        collection_id: collectionId,
        model_id: modelId || null,
        backdrop_id: backdropId || null,
        symbol_id: symbolId || null,
        gift_number: giftNumber,
        nft_address: nftAddress || null,
        price: parsedPrice,
    });

    res.json({ ok: true, listing });
});

// === Снять лот с продажи (только владелец) ===
app.delete('/api/listings/:id', requireAuth, (req, res) => {
    const listing = getListingById(parseInt(req.params.id, 10));

    if (!listing) {
        return res.status(404).json({ ok: false, error: 'Листинг не найден' });
    }
    if (listing.owner_tg_id !== req.tgId) {
        return res.status(403).json({ ok: false, error: 'Это не ваш листинг' });
    }
    if (listing.status !== 'active') {
        return res.status(400).json({ ok: false, error: 'Листинг уже неактивен' });
    }

    const updated = setListingStatus(listing.id, 'cancelled');
    res.json({ ok: true, listing: updated });
});

app.get('/', (req, res) => {
    res.send('BoomMarket Backend работает');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
