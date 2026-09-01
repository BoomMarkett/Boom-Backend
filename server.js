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
    transferListingToBuyer,
    returnListingToOwnerStorage,
    relistOwnedItem,
    listOwnedItemsForUser,
    createTransaction,
    listTransactionsForUser,
    createOrder,
    getOrderById,
    getOrderWithDetails,
    setOrderStatus,
    listActiveOrdersForUser,
    listOrderHistoryForUser,
    findMatchingOrder,
    listOffersForUser,
    searchUsersByUsername,
    listOwnedItemsForTgId,
    createTrade,
    getTradeWithItems,
    listIncomingTradesForUser,
    listMyTradesForUser,
    acceptTrade,
    declineTrade,
    cancelTrade,
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

        // Товар переходит покупателю и оседает в его "Хранилище" — а не просто
        // помечается "sold" с прежним владельцем.
        const details = getListingWithDetails(listing.id);
        const soldListing = transferListingToBuyer(listing.id, matchedOrder.buyer_tg_id);
        setOrderStatus(matchedOrder.id, 'filled', listing.id);

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

// === Добавить NFT сразу в личное "Хранилище" (без выставления на маркет,
// цена не требуется — товар просто становится собственностью пользователя) ===
app.post('/api/inventory/add', requireAuth, (req, res) => {
    const { collectionId, modelId, backdropId, symbolId, giftNumber, nftAddress } = req.body;

    if (!collectionId || !modelId || !backdropId || !symbolId || !giftNumber) {
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
        price: 0,
        status: 'owned',
    });

    res.json({ ok: true, listing });
});

// =====================================================================
// ИГРА "СЛОТЫ"
// =====================================================================

// Символы барабана и их "вес" — насколько часто они выпадают на одном
// барабане (не шанс всей комбинации!). Редкие символы дают больший
// множитель, поэтому и выпадают реже.
const SLOTS_SYMBOLS = [
    { id: 'cherry', weight: 38, multiplier: 3 },
    { id: 'lemon', weight: 38, multiplier: 3 },
    { id: 'seven', weight: 17, multiplier: 5 },
    { id: 'diamond', weight: 7, multiplier: 7 },
];
const SLOTS_TOTAL_WEIGHT = SLOTS_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
const SLOTS_MIN_BET = 0.3;
const SLOTS_MAX_BET = 1000;

function spinReel() {
    let roll = Math.random() * SLOTS_TOTAL_WEIGHT;
    for (const symbol of SLOTS_SYMBOLS) {
        if (roll < symbol.weight) return symbol.id;
        roll -= symbol.weight;
    }
    return SLOTS_SYMBOLS[SLOTS_SYMBOLS.length - 1].id;
}

// === Крутануть слоты: ставка списывается сразу, выигрыш (если есть)
// начисляется в этом же ответе — считаем всё на сервере, чтобы клиент
// не мог подделать результат или множитель ===
app.post('/api/games/slots/spin', requireAuth, (req, res) => {
    const bet = parseFloat(req.body.bet);

    if (!isValidAmount(bet, SLOTS_MIN_BET, SLOTS_MAX_BET)) {
        return res.status(400).json({
            ok: false,
            error: `Ставка должна быть от ${SLOTS_MIN_BET} до ${SLOTS_MAX_BET} TON, максимум с одним знаком после запятой`,
        });
    }

    const reels = [spinReel(), spinReel(), spinReel()];
    const isWin = reels[0] === reels[1] && reels[1] === reels[2];
    const winSymbol = SLOTS_SYMBOLS.find(s => s.id === reels[0]);
    const multiplier = isWin ? winSymbol.multiplier : 0;
    const winAmount = isWin ? Math.round(bet * multiplier * 100) / 100 : 0;

    // Одна операция с балансом: -ставка, +выигрыш (0, если проигрыш) —
    // без промежуточного шага, чтобы не оставлять пользователя "в минусе"
    // между списанием и начислением, если запросы пойдут параллельно.
    const netDelta = Math.round((winAmount - bet) * 100) / 100;

    let user;
    try {
        user = adjustBalance(req.tgId, netDelta);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    createTransaction({ tg_id: req.tgId, type: 'game_slots', amount: netDelta });

    res.json({
        ok: true,
        reels,
        win: isWin,
        multiplier: isWin ? multiplier : null,
        betAmount: bet,
        winAmount,
        balance: user.balance,
    });
});

// =====================================================================
// ИГРА "РУЛЕТКА"
// =====================================================================

// Секторы колеса и их "вес" (доля от общего круга). Чем выше множитель —
// тем меньше его территория на колесе, поэтому и выпадает он реже.
// Сектор 'miss' — проигрыш (x0): без него при множителях от x1.5 и выше
// банк был бы гарантированно в минусе на длинной дистанции, поэтому он
// занимает больше половины колеса.
const ROULETTE_SEGMENTS = [
    { id: 'miss', multiplier: 0, weight: 500 },
    { id: 'x15', multiplier: 1.5, weight: 380 },
    { id: 'x2', multiplier: 2, weight: 90 },
    { id: 'x3', multiplier: 3, weight: 25 },
    { id: 'x5', multiplier: 5, weight: 4 },
    { id: 'x10', multiplier: 10, weight: 1 },
];
const ROULETTE_TOTAL_WEIGHT = ROULETTE_SEGMENTS.reduce((sum, s) => sum + s.weight, 0);
const ROULETTE_MIN_BET = 0.3;
const ROULETTE_MAX_BET = 1000;

function spinRoulette() {
    let roll = Math.random() * ROULETTE_TOTAL_WEIGHT;
    for (const segment of ROULETTE_SEGMENTS) {
        if (roll < segment.weight) return segment;
        roll -= segment.weight;
    }
    return ROULETTE_SEGMENTS[ROULETTE_SEGMENTS.length - 1];
}

// === Крутануть рулетку: аналогично слотам — весь расчёт на сервере,
// клиент только проигрывает анимацию по присланному результату ===
app.post('/api/games/roulette/spin', requireAuth, (req, res) => {
    const bet = parseFloat(req.body.bet);

    if (!isValidAmount(bet, ROULETTE_MIN_BET, ROULETTE_MAX_BET)) {
        return res.status(400).json({
            ok: false,
            error: `Ставка должна быть от ${ROULETTE_MIN_BET} до ${ROULETTE_MAX_BET} TON, максимум с одним знаком после запятой`,
        });
    }

    const segment = spinRoulette();
    const isWin = segment.multiplier > 0;
    const winAmount = isWin ? Math.round(bet * segment.multiplier * 100) / 100 : 0;

    // Одна операция с балансом: -ставка, +выигрыш (0, если проигрыш).
    const netDelta = Math.round((winAmount - bet) * 100) / 100;

    let user;
    try {
        user = adjustBalance(req.tgId, netDelta);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    createTransaction({ tg_id: req.tgId, type: 'game_roulette', amount: netDelta });

    res.json({
        ok: true,
        result: segment.id,
        win: isWin,
        multiplier: isWin ? segment.multiplier : null,
        betAmount: bet,
        winAmount,
        balance: user.balance,
    });
});

// =====================================================================
// ИГРА "БОМБЕР" (мины) — поле 5x5, игрок сам выбирает количество бомб
// =====================================================================
//
// Правила:
//   - Поле состоит из 25 ячеек (5x5). Перед стартом игрок выбирает
//     количество бомб: 4, 6 или 8 — и делает ставку.
//   - Бомбы расставляются случайно и хранятся ТОЛЬКО на сервере — клиент
//     их не знает, пока не откроет ячейку или не проиграет.
//   - Игрок открывает ячейки по одной. Каждая безопасная ячейка увеличивает
//     множитель выигрыша — чем больше бомб на поле и чем больше ячеек
//     открыто, тем выше множитель (и риск).
//   - В любой момент после первой открытой ячейки можно забрать выигрыш
//     (Cashout) — ставка × текущий множитель зачисляется на баланс.
//   - Если открыта ячейка с бомбой — раунд проигран, ставка сгорает,
//     все бомбы показываются.
//   - Если открыты ВСЕ безопасные ячейки (без единого подрыва) — выигрыш
//     засчитывается автоматически по максимальному множителю.
//
// Множитель считается по честной комбинаторной формуле (гипергеометрическое
// распределение — вероятность вытащить k безопасных ячеек подряд без бомбы
// из колоды 25 ячеек с M бомбами), из неё вычитается комиссия площадки.
const BOMBER_GRID_SIZE = 25; // поле 5x5
const BOMBER_ALLOWED_BOMBS = [4, 6, 8];
const BOMBER_MIN_BET = 0.3;
const BOMBER_MAX_BET = 1000;
const BOMBER_HOUSE_EDGE = 0.05; // 5% комиссии площадки, зашита в множитель

// Активные раунды хранятся в памяти процесса, а не в БД — раунд живёт
// от старта до кэшаута/проигрыша, персистентность между рестартами
// сервера для него не нужна (как и для слотов/рулетки, здесь всё решается
// одним "заходом"). Один активный раунд на пользователя одновременно.
const bomberActiveGames = new Map(); // tgId -> { bet, bombs, bombSet, revealed:Set, startedAt }

function bomberFairMultiplier(bombs, picks) {
    // ∏ (N-i)/(N-bombs-i) для i=0..picks-1 — честный (без учёта комиссии)
    // множитель за то, что все picks открытых ячеек оказались безопасными.
    let mult = 1;
    for (let i = 0; i < picks; i++) {
        mult *= (BOMBER_GRID_SIZE - i) / (BOMBER_GRID_SIZE - bombs - i);
    }
    return mult;
}

function bomberMultiplier(bombs, picks) {
    if (picks <= 0) return 1;
    return bomberFairMultiplier(bombs, picks) * (1 - BOMBER_HOUSE_EDGE);
}

function bomberPublicState(game) {
    const safeCellsTotal = BOMBER_GRID_SIZE - game.bombs;
    const picks = game.revealed.size;
    const currentMultiplier = Math.round(bomberMultiplier(game.bombs, picks) * 100) / 100;
    const nextMultiplier = picks < safeCellsTotal
        ? Math.round(bomberMultiplier(game.bombs, picks + 1) * 100) / 100
        : null;
    return {
        bet: game.bet,
        bombs: game.bombs,
        gridSize: BOMBER_GRID_SIZE,
        revealed: [...game.revealed],
        picks,
        safeCellsTotal,
        currentMultiplier,
        nextMultiplier,
        potentialWin: Math.round(game.bet * currentMultiplier * 100) / 100,
    };
}

// === Начать раунд: списываем ставку сразу (резерв), генерируем бомбы ===
app.post('/api/games/bomber/start', requireAuth, (req, res) => {
    const bet = parseFloat(req.body.bet);
    const bombs = parseInt(req.body.bombs, 10);

    if (!isValidAmount(bet, BOMBER_MIN_BET, BOMBER_MAX_BET)) {
        return res.status(400).json({
            ok: false,
            error: `Ставка должна быть от ${BOMBER_MIN_BET} до ${BOMBER_MAX_BET} TON, максимум с одним знаком после запятой`,
        });
    }
    if (!BOMBER_ALLOWED_BOMBS.includes(bombs)) {
        return res.status(400).json({ ok: false, error: 'Количество бомб должно быть 4, 6 или 8' });
    }
    if (bomberActiveGames.has(req.tgId)) {
        return res.status(400).json({ ok: false, error: 'У вас уже есть активный раунд — завершите его (откройте ячейку или заберите выигрыш)' });
    }

    let user;
    try {
        user = adjustBalance(req.tgId, -bet);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    // Расставляем бомбы случайно по 25 ячейкам (индексы 0..24).
    const positions = Array.from({ length: BOMBER_GRID_SIZE }, (_, i) => i);
    for (let i = positions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    const bombSet = new Set(positions.slice(0, bombs));

    const game = { bet, bombs, bombSet, revealed: new Set(), startedAt: Date.now() };
    bomberActiveGames.set(req.tgId, game);

    res.json({ ok: true, balance: user.balance, game: bomberPublicState(game) });
});

// === Открыть ячейку ===
app.post('/api/games/bomber/reveal', requireAuth, (req, res) => {
    const cell = parseInt(req.body.cell, 10);
    const game = bomberActiveGames.get(req.tgId);

    if (!game) {
        return res.status(400).json({ ok: false, error: 'Нет активного раунда — начните новую игру' });
    }
    if (!Number.isInteger(cell) || cell < 0 || cell >= BOMBER_GRID_SIZE) {
        return res.status(400).json({ ok: false, error: 'Некорректная ячейка' });
    }
    if (game.revealed.has(cell)) {
        return res.status(400).json({ ok: false, error: 'Эта ячейка уже открыта' });
    }

    if (game.bombSet.has(cell)) {
        // Подрыв — раунд проигран, ставка не возвращается (она уже списана при старте).
        bomberActiveGames.delete(req.tgId);
        createTransaction({ tg_id: req.tgId, type: 'game_bomber', amount: -game.bet });
        return res.json({
            ok: true,
            win: false,
            hitCell: cell,
            bombs: [...game.bombSet],
            betAmount: game.bet,
            winAmount: 0,
        });
    }

    game.revealed.add(cell);
    const safeCellsTotal = BOMBER_GRID_SIZE - game.bombs;

    if (game.revealed.size >= safeCellsTotal) {
        // Открыты все безопасные ячейки — автоматический кэшаут по максимальному множителю.
        const multiplier = Math.round(bomberMultiplier(game.bombs, game.revealed.size) * 100) / 100;
        const winAmount = Math.round(game.bet * multiplier * 100) / 100;
        bomberActiveGames.delete(req.tgId);
        const user = adjustBalance(req.tgId, winAmount);
        createTransaction({ tg_id: req.tgId, type: 'game_bomber', amount: winAmount - game.bet });
        return res.json({
            ok: true,
            win: true,
            cleared: true,
            cell,
            multiplier,
            betAmount: game.bet,
            winAmount,
            balance: user.balance,
            bombs: [...game.bombSet],
        });
    }

    res.json({ ok: true, win: null, cell, game: bomberPublicState(game) });
});

// === Забрать выигрыш досрочно ===
app.post('/api/games/bomber/cashout', requireAuth, (req, res) => {
    const game = bomberActiveGames.get(req.tgId);
    if (!game) {
        return res.status(400).json({ ok: false, error: 'Нет активного раунда' });
    }
    if (game.revealed.size === 0) {
        return res.status(400).json({ ok: false, error: 'Откройте хотя бы одну ячейку перед выводом' });
    }

    const multiplier = Math.round(bomberMultiplier(game.bombs, game.revealed.size) * 100) / 100;
    const winAmount = Math.round(game.bet * multiplier * 100) / 100;
    bomberActiveGames.delete(req.tgId);

    const user = adjustBalance(req.tgId, winAmount);
    createTransaction({ tg_id: req.tgId, type: 'game_bomber', amount: winAmount - game.bet });

    res.json({ ok: true, win: true, multiplier, betAmount: game.bet, winAmount, balance: user.balance });
});

// === Текущее состояние раунда (на случай, если пользователь обновил страницу) ===
app.get('/api/games/bomber/state', requireAuth, (req, res) => {
    const game = bomberActiveGames.get(req.tgId);
    if (!game) {
        return res.json({ ok: true, game: null });
    }
    res.json({ ok: true, game: bomberPublicState(game) });
});

// =====================================================================
// ИГРА "КОСТИ" (Dice) — классический "roll under / roll over"
// =====================================================================
//
// Правила:
//   - Игрок выбирает число-цель (от 2 до 98) и направление броска:
//     "Меньше" (Under) — выигрыш, если результат броска МЕНЬШЕ цели,
//     "Больше" (Over) — выигрыш, если результат броска БОЛЬШЕ цели.
//   - Результат броска — случайное число от 0.00 до 99.99 (сервер).
//   - Чем меньше шанс на выигрыш (уже выбранный диапазон), тем выше
//     множитель — и наоборот. Это регулируется положением цели на шкале.
//   - Шанс на выигрыш и множитель показываются игроку ДО броска — можно
//     свободно двигать ползунок, ничего не списывается, пока не нажата
//     кнопка "Бросить кости".
const DICE_MIN_BET = 0.3;
const DICE_MAX_BET = 1000;
const DICE_MIN_TARGET = 2;
const DICE_MAX_TARGET = 98;
const DICE_HOUSE_EDGE = 0.05; // те же 5%, что и у остальных игр

function diceWinChance(target, direction) {
    // "Under": выигрыш при roll < target -> шанс = target%
    // "Over":  выигрыш при roll > target -> шанс = (100 - target)%
    return direction === 'over' ? (100 - target) : target;
}

function diceMultiplier(target, direction) {
    const chance = diceWinChance(target, direction);
    return (100 / chance) * (1 - DICE_HOUSE_EDGE);
}

// === Бросить кости: всё считается на сервере за один запрос — ставка
// списывается и выигрыш (если есть) начисляется в этом же ответе ===
app.post('/api/games/dice/roll', requireAuth, (req, res) => {
    const bet = parseFloat(req.body.bet);
    const target = parseInt(req.body.target, 10);
    const direction = req.body.direction === 'over' ? 'over' : 'under';

    if (!isValidAmount(bet, DICE_MIN_BET, DICE_MAX_BET)) {
        return res.status(400).json({
            ok: false,
            error: `Ставка должна быть от ${DICE_MIN_BET} до ${DICE_MAX_BET} TON, максимум с одним знаком после запятой`,
        });
    }
    if (!Number.isInteger(target) || target < DICE_MIN_TARGET || target > DICE_MAX_TARGET) {
        return res.status(400).json({ ok: false, error: `Цель должна быть числом от ${DICE_MIN_TARGET} до ${DICE_MAX_TARGET}` });
    }

    // Бросок — случайное число 0.00–99.99 с шагом 0.01.
    const roll = Math.floor(Math.random() * 10000) / 100;
    const isWin = direction === 'over' ? roll > target : roll < target;
    const multiplier = Math.round(diceMultiplier(target, direction) * 100) / 100;
    const winAmount = isWin ? Math.round(bet * multiplier * 100) / 100 : 0;
    const netDelta = Math.round((winAmount - bet) * 100) / 100;

    let user;
    try {
        user = adjustBalance(req.tgId, netDelta);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    createTransaction({ tg_id: req.tgId, type: 'game_dice', amount: netDelta });

    res.json({
        ok: true,
        roll,
        target,
        direction,
        win: isWin,
        multiplier,
        betAmount: bet,
        winAmount,
        balance: user.balance,
    });
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
    const sellerTgId = listing.owner_tg_id;
    adjustBalance(sellerTgId, sellerPayout);
    // Товар переходит покупателю и оседает в его "Хранилище".
    const updatedListing = transferListingToBuyer(listing.id, req.tgId);

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

    // При снятии с продажи товар не исчезает, а возвращается в "Хранилище" владельца.
    const updated = returnListingToOwnerStorage(listing.id);
    res.json({ ok: true, listing: updated });
});

// === Личное "Хранилище": товары пользователя, которые сейчас не выставлены на продажу ===
app.get('/api/inventory', requireAuth, (req, res) => {
    const items = listOwnedItemsForUser(req.tgId);
    res.json({ ok: true, items });
});

// === Выставить товар из "Хранилища" обратно на продажу (та же запись, новая цена) ===
app.post('/api/listings/:id/relist', requireAuth, (req, res) => {
    const listing = getListingById(parseInt(req.params.id, 10));

    if (!listing) {
        return res.status(404).json({ ok: false, error: 'Товар не найден' });
    }
    if (listing.owner_tg_id !== req.tgId) {
        return res.status(403).json({ ok: false, error: 'Это не ваш товар' });
    }
    if (listing.status !== 'owned') {
        return res.status(400).json({ ok: false, error: 'Этот товар нельзя выставить на продажу' });
    }

    const parsedPrice = parseFloat(req.body.price);
    if (!isValidAmount(parsedPrice, 0.01, 1000000)) {
        return res.status(400).json({ ok: false, error: 'Укажите корректную цену' });
    }

    const updated = relistOwnedItem(listing.id, parsedPrice);

    // Как и при обычном выставлении лота — если есть подходящий активный ордер,
    // сделка исполняется мгновенно.
    const matchedOrder = findMatchingOrder(updated);
    if (matchedOrder && matchedOrder.buyer_tg_id !== req.tgId) {
        const sellerPayout = updated.price * (1 - MARKETPLACE_FEE_PERCENT / 100);
        adjustBalance(req.tgId, sellerPayout);

        const refund = matchedOrder.max_price - updated.price;
        if (refund > 1e-9) {
            adjustBalance(matchedOrder.buyer_tg_id, refund);
        }

        const details = getListingWithDetails(updated.id);
        const soldListing = transferListingToBuyer(updated.id, matchedOrder.buyer_tg_id);
        setOrderStatus(matchedOrder.id, 'filled', updated.id);

        const giftSnapshot = {
            listing_id: updated.id,
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
        createTransaction({ tg_id: matchedOrder.buyer_tg_id, type: 'buy', amount: -updated.price, ...giftSnapshot });
        createTransaction({ tg_id: req.tgId, type: 'sell', amount: sellerPayout, ...giftSnapshot });

        return res.json({ ok: true, listing: soldListing, matchedOrder: true });
    }

    res.json({ ok: true, listing: updated });
});

// === Предложения (активные ордера на покупку), подходящие под лоты текущего
// пользователя — сводно по всем его активным лотам, для вкладки "Ордеры → Предложения" ===
app.get('/api/my-offers', requireAuth, (req, res) => {
    const offers = listOffersForUser(req.tgId);
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

    const details = getListingWithDetails(listing.id);
    // Товар переходит покупателю (автору оффера) и оседает в его "Хранилище".
    const soldListing = transferListingToBuyer(listing.id, order.buyer_tg_id);
    setOrderStatus(order.id, 'filled', listing.id);
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

// =====================================================================
// ТРЕЙД (P2P-обмен подарками между пользователями)
// =====================================================================

// === Поиск пользователя по началу username — для выбора получателя обмена ===
app.get('/api/users/search', requireAuth, (req, res) => {
    const q = String(req.query.q || '');
    if (!q.trim()) {
        return res.json({ ok: true, users: [] });
    }
    const users = searchUsersByUsername(q, req.tgId);
    res.json({ ok: true, users });
});

// === Предметы конкретного пользователя (публично видимая часть "Хранилища") —
// нужно, чтобы показать инициатору, что можно попросить у получателя ===
app.get('/api/users/:tgId/inventory', requireAuth, (req, res) => {
    const targetTgId = parseInt(req.params.tgId, 10);
    if (!targetTgId || targetTgId === req.tgId) {
        return res.status(400).json({ ok: false, error: 'Некорректный пользователь' });
    }
    const target = getUserByTgId(targetTgId);
    if (!target) {
        return res.status(404).json({ ok: false, error: 'Пользователь не найден' });
    }
    res.json({ ok: true, items: listOwnedItemsForTgId(targetTgId) });
});

// Комиссия площадки за один трейд — списывается с инициатора при создании
// (см. ниже) и возвращается ему, если трейд не завершится успехом.
const TRADE_FEE_TON = 0.05;

// === Создать предложение обмена ===
app.post('/api/trades', requireAuth, (req, res) => {
    const recipientTgId = parseInt(req.body.recipientTgId, 10);
    const myItemIds = Array.isArray(req.body.myItemIds) ? req.body.myItemIds.map(id => parseInt(id, 10)) : [];
    const theirItemIds = Array.isArray(req.body.theirItemIds) ? req.body.theirItemIds.map(id => parseInt(id, 10)) : [];

    if (!recipientTgId || recipientTgId === req.tgId) {
        return res.status(400).json({ ok: false, error: 'Укажите корректного получателя' });
    }
    if (myItemIds.length === 0 || theirItemIds.length === 0) {
        return res.status(400).json({ ok: false, error: 'Выберите хотя бы один предмет с каждой стороны' });
    }

    // Доплата TON поверх обмена предметами — необязательная. tonPayer говорит,
    // кто именно доплачивает: 'initiator' (я доплачиваю получателю) или
    // 'recipient' (прошу доплату у получателя).
    let tonAmount = 0;
    let tonPayer = null;
    if (req.body.tonAmount !== undefined && req.body.tonAmount !== null && req.body.tonAmount !== '') {
        tonAmount = parseFloat(req.body.tonAmount);
        tonPayer = req.body.tonPayer === 'recipient' ? 'recipient' : 'initiator';
        if (!isValidAmount(tonAmount, 0.1, 100000)) {
            return res.status(400).json({ ok: false, error: 'Доплата должна быть от 0.1 до 100000 TON, максимум с одним знаком после запятой' });
        }
    }

    const recipient = getUserByTgId(recipientTgId);
    if (!recipient) {
        return res.status(404).json({ ok: false, error: 'Получатель не найден' });
    }

    // Перепроверяем владение каждым предметом на сервере — не доверяем id с фронта вслепую.
    for (const id of myItemIds) {
        const listing = getListingById(id);
        if (!listing || listing.owner_tg_id !== req.tgId || listing.status !== 'owned') {
            return res.status(400).json({ ok: false, error: 'Один из ваших предметов недоступен для обмена' });
        }
    }
    for (const id of theirItemIds) {
        const listing = getListingById(id);
        if (!listing || listing.owner_tg_id !== recipientTgId || listing.status !== 'owned') {
            return res.status(400).json({ ok: false, error: 'Один из предметов получателя больше недоступен' });
        }
    }

    // Резервируем у инициатора комиссию сразу — и его собственную доплату,
    // если он тот, кто доплачивает (доплату получателя резервировать нельзя,
    // он ещё не согласился — её спишем только при принятии трейда).
    const initiatorReserve = TRADE_FEE_TON + (tonPayer === 'initiator' ? tonAmount : 0);
    let initiator;
    try {
        initiator = adjustBalance(req.tgId, -initiatorReserve);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе для комиссии' + (tonPayer === 'initiator' ? ' и доплаты' : '') });
    }
    createTransaction({ tg_id: req.tgId, type: 'trade_fee', amount: -TRADE_FEE_TON });

    const trade = createTrade({
        initiator_tg_id: req.tgId,
        recipient_tg_id: recipientTgId,
        initiatorListingIds: myItemIds,
        recipientListingIds: theirItemIds,
        ton_amount: tonAmount,
        ton_payer: tonPayer,
        fee_amount: TRADE_FEE_TON,
    });

    res.json({ ok: true, trade, balance: initiator.balance });
});

// === Входящие предложения обмена (я — получатель, жду решения) ===
app.get('/api/trades/incoming', requireAuth, (req, res) => {
    res.json({ ok: true, trades: listIncomingTradesForUser(req.tgId) });
});

// === Все мои трейды — и исходящие, и входящие, в любом статусе ===
app.get('/api/trades/mine', requireAuth, (req, res) => {
    res.json({ ok: true, trades: listMyTradesForUser(req.tgId) });
});

// === Детали одного трейда ===
app.get('/api/trades/:id', requireAuth, (req, res) => {
    const trade = getTradeWithItems(parseInt(req.params.id, 10));
    if (!trade) {
        return res.status(404).json({ ok: false, error: 'Трейд не найден' });
    }
    if (trade.initiator_tg_id !== req.tgId && trade.recipient_tg_id !== req.tgId) {
        return res.status(403).json({ ok: false, error: 'Это не ваш трейд' });
    }
    res.json({ ok: true, trade });
});

// === Принять трейд (только получатель) ===
app.post('/api/trades/:id/accept', requireAuth, (req, res) => {
    const result = acceptTrade(parseInt(req.params.id, 10), req.tgId);
    if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
    }
    const user = getUserByTgId(req.tgId);
    res.json({ ok: true, trade: result.trade, balance: user.balance });
});

// === Отклонить трейд (только получатель) ===
app.post('/api/trades/:id/decline', requireAuth, (req, res) => {
    const result = declineTrade(parseInt(req.params.id, 10), req.tgId);
    if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
    }
    const user = getUserByTgId(req.tgId);
    res.json({ ok: true, trade: result.trade, balance: user.balance });
});

// === Отменить свой исходящий трейд, пока он ещё не принят (только инициатор) ===
app.delete('/api/trades/:id', requireAuth, (req, res) => {
    const result = cancelTrade(parseInt(req.params.id, 10), req.tgId);
    if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
    }
    const user = getUserByTgId(req.tgId);
    res.json({ ok: true, trade: result.trade, balance: user.balance });
});

app.get('/', (req, res) => {
    res.send('BoomMarket Backend работает v2');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
