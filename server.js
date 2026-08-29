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
    getAllFilters,
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

// Небольшой помощник: строка "1,2,3" -> массив ["1","2","3"], пусто/undefined -> undefined.
function parseCsvParam(value) {
    if (!value) return undefined;
    const parts = String(value).split(',').map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
}

function parseCsvIntParam(value) {
    const parts = parseCsvParam(value);
    return parts ? parts.map(p => parseInt(p, 10)).filter(n => !Number.isNaN(n)) : undefined;
}

// === Доступные модели/фоны/символы по ВСЕМ коллекциям (или по выбранным NFT) —
// GET /api/filters?collectionIds=1,2,3 (необязательный параметр — сужает список) ===
app.get('/api/filters', (req, res) => {
    const collectionIds = parseCsvIntParam(req.query.collectionIds);
    res.json({ ok: true, filters: getAllFilters(collectionIds) });
});

// === Доступные модели/фоны/символы для конкретной коллекции ===
app.get('/api/collections/:id/filters', (req, res) => {
    const collectionId = parseInt(req.params.id, 10);
    if (!collectionId) {
        return res.status(400).json({ ok: false, error: 'Некорректный id коллекции' });
    }
    res.json({ ok: true, filters: getFiltersForCollection(collectionId) });
});

// === Список активных листингов с фильтрами/сортировкой (поддерживает мультивыбор через запятую) ===
// GET /api/listings?collectionId=1,2&model=Apex,Sigma&backdrop=Satin%20Gold&symbol=Coin&search=Evil&sort=price_asc
app.get('/api/listings', (req, res) => {
    const { collectionId, model, backdrop, symbol, search, sort } = req.query;

    const listings = findListings({
        collectionId: parseCsvIntParam(collectionId),
        modelName: parseCsvParam(model),
        backdropName: parseCsvParam(backdrop),
        symbolName: parseCsvParam(symbol),
        search: search || undefined,
        sort: sort || undefined,
    });

    res.json({ ok: true, listings });
});

// === Выставить лот на продажу ===
app.post('/api/listings', requireAuth, (req, res) => {
    const { collectionId, modelId, backdropId, symbolId, giftNumber, nftAddress, price } = req.body;

    const parsedPrice = parseFloat(price);
    if (!collectionId || !modelId || !backdropId || !symbolId || !giftNumber || !parsedPrice || parsedPrice <= 0) {
        return res.status(400).json({ ok: false, error: 'Заполнены не все обязательные поля' });
    }

    const listing = createListing({
        owner_tg_id: req.tgId,
        collection_id: collectionId,
        model_id: modelId,
        backdrop_id: backdropId,
        symbol_id: symbolId,
        gift_number: giftNumber,
        nft_address: nftAddress || null,
        price: parsedPrice,
    });

    res.json({ ok: true, listing });
});

// === Купить лот (только не собственный, только пока статус active) ===
app.post('/api/listings/:id/buy', requireAuth, (req, res) => {
    const listing = getListingById(parseInt(req.params.id, 10));

    if (!listing) {
        return res.status(404).json({ ok: false, error: 'Листинг не найден' });
    }
    if (listing.status !== 'active') {
        return res.status(400).json({ ok: false, error: 'Этот лот уже продан или снят с продажи' });
    }
    if (listing.owner_tg_id === req.tgId) {
        return res.status(400).json({ ok: false, error: 'Нельзя купить собственный лот' });
    }

    let buyer;
    try {
        // Списываем у покупателя — adjustBalance сама бросит ошибку, если средств не хватает.
        buyer = adjustBalance(req.tgId, -listing.price);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    // Зачисляем продавцу и помечаем лот проданным. Если что-то из этого упадёт —
    // деньги у покупателя уже списаны; для демо-версии это допустимый риск,
    // в проде это место стоит обернуть в транзакцию с откатом.
    adjustBalance(listing.owner_tg_id, listing.price);
    const updatedListing = setListingStatus(listing.id, 'sold');

    res.json({ ok: true, balance: buyer.balance, listing: updatedListing });
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
    res.send('BoomMarket Backend работает v2');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
