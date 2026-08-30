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
    getListingWithDetails,
    createListing,
    setListingStatus,
    createTransaction,
    listTransactionsForUser,
    createOrder,
    getOrderById,
    getOrderWithDetails,
    setOrderStatus,
    listActiveOrdersForUser,
    listOrderHistoryForUser,
    findMatchingOrder,
    findMatchingOrdersForListing,
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

// Проверяет, что сумма — число в заданном диапазоне с не более чем одним
// знаком после запятой (0.2, 1.4, 10.7, 10 — можно; 1.76, 9.87 — нельзя).
function isValidAmount(amount, min = 0.1, max = 100000) {
    if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) return false;
    if (amount < min || amount > max) return false;
    const tenths = Math.round(amount * 10);
    return Math.abs(tenths - amount * 10) < 1e-6;
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

    if (!isValidAmount(amount)) {
        return res.status(400).json({ ok: false, error: 'Сумма должна быть от 0.1 до 100000, максимум с одним знаком после запятой' });
    }

    const user = adjustBalance(req.tgId, amount);
    createTransaction({ tg_id: req.tgId, type: 'deposit', amount });
    res.json({ ok: true, balance: user.balance });
});

// === Вывод средств ===
app.post('/api/withdraw', requireAuth, (req, res) => {
    const amount = parseFloat(req.body.amount);

    if (!isValidAmount(amount, 0.5, 100000)) {
        return res.status(400).json({ ok: false, error: 'Сумма должна быть от 0.5 до 100000, максимум с одним знаком после запятой' });
    }

    try {
        const user = adjustBalance(req.tgId, -amount);
        createTransaction({ tg_id: req.tgId, type: 'withdraw', amount: -amount });
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

// Комиссия маркетплейса — удерживается с продавца при продаже (из выручки),
// покупатель платит ровно ту цену, что указана в лоте, без наценки.
const MARKETPLACE_FEE_PERCENT = 1.5;

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

    // Проверяем, нет ли активного ордера, который ждёт именно такой подарок —
    // если есть, сделка исполняется мгновенно, минуя обычный флоу "выставил → кто-то купил".
    const matchedOrder = findMatchingOrder(listing);
    if (matchedOrder && matchedOrder.buyer_tg_id !== req.tgId) {
        // Деньги покупателя уже зарезервированы на его балансе при создании ордера —
        // здесь просто зачисляем продавцу выручку за вычетом комиссии.
        const sellerPayout = listing.price * (1 - MARKETPLACE_FEE_PERCENT / 100);
        adjustBalance(req.tgId, sellerPayout);

        // Если цена лота оказалась ниже максимума, который был готов заплатить
        // покупатель, возвращаем ему разницу.
        const refund = matchedOrder.max_price - listing.price;
        if (refund > 1e-9) {
            adjustBalance(matchedOrder.buyer_tg_id, refund);
        }

        const soldListing = setListingStatus(listing.id, 'sold');
        setOrderStatus(matchedOrder.id, 'filled', listing.id);

        const details = getListingWithDetails(listing.id);
        const giftSnapshot = {
            listing_id: listing.id,
            collection_name: details.collection_name,
            collection_image: details.collection_image,
            model_name: details.model_name,
            model_image: details.model_image,
            backdrop_name: details.backdrop_name,
            backdrop_color: details.backdrop_color,
            symbol_name: details.symbol_name,
            symbol_icon: details.symbol_icon,
            gift_number: details.gift_number,
        };
        createTransaction({ tg_id: matchedOrder.buyer_tg_id, type: 'buy', amount: -listing.price, ...giftSnapshot });
        createTransaction({ tg_id: req.tgId, type: 'sell', amount: sellerPayout, ...giftSnapshot });

        return res.json({ ok: true, listing: soldListing, matchedOrder: true });
    }

    res.json({ ok: true, listing });
});

// === Создать ордер на покупку (сумма сразу резервируется на балансе) ===
app.post('/api/orders', requireAuth, (req, res) => {
    const { collectionId, modelId, backdropId, symbolId, maxPrice } = req.body;
    const parsedPrice = parseFloat(maxPrice);

    if (!collectionId) {
        return res.status(400).json({ ok: false, error: 'Выберите коллекцию' });
    }
    if (!isValidAmount(parsedPrice, 0.1, 100000)) {
        return res.status(400).json({ ok: false, error: 'Цена должна быть от 0.1 до 100000, максимум с одним знаком после запятой' });
    }

    let buyer;
    try {
        buyer = adjustBalance(req.tgId, -parsedPrice);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    const order = createOrder({
        buyer_tg_id: req.tgId,
        collection_id: collectionId,
        model_id: modelId || null,
        backdrop_id: backdropId || null,
        symbol_id: symbolId || null,
        max_price: parsedPrice,
    });

    res.json({ ok: true, order: getOrderWithDetails(order.id), balance: buyer.balance });
});

// === Активные ордера текущего пользователя ===
app.get('/api/orders', requireAuth, (req, res) => {
    res.json({ ok: true, orders: listActiveOrdersForUser(req.tgId) });
});

// === История ордеров текущего пользователя (исполненные/отменённые) ===
app.get('/api/orders/history', requireAuth, (req, res) => {
    res.json({ ok: true, orders: listOrderHistoryForUser(req.tgId) });
});

// === Отменить ордер (только владелец, только пока активен) — возвращает резерв на баланс ===
app.delete('/api/orders/:id', requireAuth, (req, res) => {
    const order = getOrderById(parseInt(req.params.id, 10));

    if (!order) {
        return res.status(404).json({ ok: false, error: 'Ордер не найден' });
    }
    if (order.buyer_tg_id !== req.tgId) {
        return res.status(403).json({ ok: false, error: 'Это не ваш ордер' });
    }
    if (order.status !== 'active') {
        return res.status(400).json({ ok: false, error: 'Ордер уже неактивен' });
    }

    const user = adjustBalance(req.tgId, order.max_price);
    setOrderStatus(order.id, 'cancelled');

    res.json({ ok: true, order: getOrderWithDetails(order.id), balance: user.balance });
});

// === Купить лот (только не собственный, только пока статус active) ===
app.post('/api/listings/:id/buy', requireAuth, (req, res) => {
    const listing = getListingWithDetails(parseInt(req.params.id, 10));

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
        // Списываем у покупателя полную цену — adjustBalance сама бросит ошибку,
        // если средств не хватает.
        buyer = adjustBalance(req.tgId, -listing.price);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    // Продавцу зачисляем цену за вычетом комиссии маркетплейса.
    const sellerPayout = listing.price * (1 - MARKETPLACE_FEE_PERCENT / 100);
    adjustBalance(listing.owner_tg_id, sellerPayout);
    const updatedListing = setListingStatus(listing.id, 'sold');

    // Записываем обе стороны сделки в историю — снимок данных подарка берём
    // из listing (не из updatedListing, там только сырые поля без JOIN).
    const giftSnapshot = {
        listing_id: listing.id,
        collection_name: listing.collection_name,
        collection_image: listing.collection_image,
        model_name: listing.model_name,
        model_image: listing.model_image,
        backdrop_name: listing.backdrop_name,
        backdrop_color: listing.backdrop_color,
        symbol_name: listing.symbol_name,
        symbol_icon: listing.symbol_icon,
        gift_number: listing.gift_number,
    };
    createTransaction({ tg_id: req.tgId, type: 'buy', amount: -listing.price, ...giftSnapshot });
    createTransaction({ tg_id: listing.owner_tg_id, type: 'sell', amount: sellerPayout, ...giftSnapshot });

    res.json({ ok: true, balance: buyer.balance, listing: updatedListing });
});

// === История операций пользователя (пополнения, выводы, покупки, продажи) ===
app.get('/api/history', requireAuth, (req, res) => {
    const history = listTransactionsForUser(req.tgId);
    res.json({ ok: true, history });
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

// === Предложения (активные ордера на покупку), подходящие под конкретный лот —
// видит только владелец, чтобы решить, продать ли дешевле рыночной цены ===
app.get('/api/listings/:id/offers', requireAuth, (req, res) => {
    const listing = getListingById(parseInt(req.params.id, 10));

    if (!listing) {
        return res.status(404).json({ ok: false, error: 'Листинг не найден' });
    }
    if (listing.owner_tg_id !== req.tgId) {
        return res.status(403).json({ ok: false, error: 'Это не ваш листинг' });
    }

    const offers = findMatchingOrdersForListing(listing);
    res.json({ ok: true, offers });
});

// === Продать лот конкретному ордеру-предложению (владелец сам выбирает,
// принять ли предложение — в том числе ниже своей цены) ===
app.post('/api/listings/:id/accept-offer', requireAuth, (req, res) => {
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

    const orderId = parseInt(req.body.orderId, 10);
    const order = getOrderById(orderId);

    if (!order || order.status !== 'active') {
        return res.status(400).json({ ok: false, error: 'Это предложение больше недоступно' });
    }
    // Перепроверяем совпадение трейтов на сервере — не доверяем orderId с фронта вслепую.
    if (order.collection_id !== listing.collection_id) {
        return res.status(400).json({ ok: false, error: 'Предложение не подходит под этот лот' });
    }
    if (order.model_id && order.model_id !== listing.model_id) {
        return res.status(400).json({ ok: false, error: 'Предложение не подходит под этот лот' });
    }
    if (order.backdrop_id && order.backdrop_id !== listing.backdrop_id) {
        return res.status(400).json({ ok: false, error: 'Предложение не подходит под этот лот' });
    }
    if (order.symbol_id && order.symbol_id !== listing.symbol_id) {
        return res.status(400).json({ ok: false, error: 'Предложение не подходит под этот лот' });
    }

    // Деньги покупателя уже зарезервированы на его балансе при создании ордера —
    // сделка проходит ровно по цене предложения (order.max_price), продавец
    // получает её за вычетом комиссии.
    const sellerPayout = order.max_price * (1 - MARKETPLACE_FEE_PERCENT / 100);
    const seller = adjustBalance(req.tgId, sellerPayout);

    const soldListing = setListingStatus(listing.id, 'sold');
    setOrderStatus(order.id, 'filled', listing.id);

    const details = getListingWithDetails(listing.id);
    const giftSnapshot = {
        listing_id: listing.id,
        collection_name: details.collection_name,
        collection_image: details.collection_image,
        model_name: details.model_name,
        model_image: details.model_image,
        backdrop_name: details.backdrop_name,
        backdrop_color: details.backdrop_color,
        symbol_name: details.symbol_name,
        symbol_icon: details.symbol_icon,
        gift_number: details.gift_number,
    };
    createTransaction({ tg_id: order.buyer_tg_id, type: 'buy', amount: -order.max_price, ...giftSnapshot });
    createTransaction({ tg_id: req.tgId, type: 'sell', amount: sellerPayout, ...giftSnapshot });

    res.json({ ok: true, listing: soldListing, balance: seller.balance });
});

app.get('/', (req, res) => {
    res.send('BoomMarket Backend работает v2');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
