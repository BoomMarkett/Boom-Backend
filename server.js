const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const {
    findOrCreateUser,
    getUserByTgId,
    adjustBalance,
    listCollections,
    getFiltersForCollections,
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

// Парсит "1,2,3" -> [1,2,3] (числа), пропускает пустые/некорректные значения.
function parseIntList(raw) {
    if (!raw) return [];
    return raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
}

// Парсит "A,B,C" -> ['A','B','C'] (строки), обрезает пробелы, убирает пустые.
function parseStringList(raw) {
    if (!raw) return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// === Авторизация ===
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

app.get('/api/balance', requireAuth, (req, res) => {
    const user = getUserByTgId(req.tgId);

    if (!user) {
        return res.status(404).json({ ok: false, error: 'Пользователь не найден' });
    }

    res.json({ ok: true, balance: user.balance });
});

app.post('/api/deposit', requireAuth, (req, res) => {
    const amount = parseFloat(req.body.amount);

    if (!amount || amount < 0.01) {
        return res.status(400).json({ ok: false, error: 'Минимальная сумма для пополнения: 0.01' });
    }

    const user = adjustBalance(req.tgId, amount);
    res.json({ ok: true, balance: user.balance });
});

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

// === Коллекции (для пикера "NFT") ===
app.get('/api/collections', (req, res) => {
    res.json({ ok: true, collections: listCollections() });
});

// === Модели/фоны/символы, сузенные до выбранных коллекций ===
// GET /api/filters?collectionIds=1,3,7  (без параметра — по всем коллекциям)
app.get('/api/filters', (req, res) => {
    const collectionIds = parseIntList(req.query.collectionIds);
    res.json({ ok: true, filters: getFiltersForCollections(collectionIds) });
});

// === Список активных листингов — каждый из фильтров теперь может быть списком через запятую ===
// GET /api/listings?collectionId=1,2&model=Anniversary,Backyard&backdrop=Black&symbol=Coin&search=Evil&sort=price_asc
app.get('/api/listings', (req, res) => {
    const { collectionId, model, backdrop, symbol, search, sort } = req.query;

    const listings = findListings({
        collectionIds: parseIntList(collectionId),
        modelNames: parseStringList(model),
        backdropNames: parseStringList(backdrop),
        symbolNames: parseStringList(symbol),
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
    res.send('BoomMarket Backend работает v3');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
