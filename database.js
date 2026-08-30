const Database = require('better-sqlite3');
const path = require('path');

// Файл базы данных. По умолчанию (локальная разработка) — рядом с server.js.
// На Railway задаём DB_PATH через переменную окружения, указывая на смонтированный
// постоянный диск (Volume) — иначе при каждом редеплое контейнер пересоздаётся
// с нуля, и вся база (пользователи, баланс, коллекции, листинги) стирается.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'boommarket.db');
const db = new Database(dbPath);
console.log(`База данных: ${dbPath}`);

// Небольшой прирост производительности и надёжности для SQLite
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// === Создание таблиц (выполняется один раз при первом старте) ===
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        photo_url TEXT,
        balance REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Коллекция подарков Telegram (например "Ice Cream", "Jingle Bells").
    -- Заполняется сид-скриптом (scripts/seed-collections.js) реальными данными из TonAPI,
    -- а не руками — см. комментарии в этом скрипте.
    CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ton_address TEXT UNIQUE,       -- адрес коллекции в TON, NULL для ручных/тестовых
        name TEXT NOT NULL,
        image_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Каталог возможных моделей/фонов/символов по каждой коллекции — используется
    -- и для фильтров на фронте, и для проверки, что листинг ссылается на существующий трейт.
    CREATE TABLE IF NOT EXISTS gift_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        image_url TEXT,                 -- картинка примера NFT с этой моделью (для фильтра на фронте)
        rarity_permille REAL,          -- доля от общего числа, напр. 15.0 = 1.5%
        UNIQUE(collection_id, name)
    );

    CREATE TABLE IF NOT EXISTS gift_backdrops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color_hex TEXT,
        image_url TEXT,                 -- картинка примера NFT с этим фоном
        rarity_permille REAL,
        UNIQUE(collection_id, name)
    );

    CREATE TABLE IF NOT EXISTS gift_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        icon_url TEXT,
        rarity_permille REAL,
        UNIQUE(collection_id, name)
    );

    -- Реальные лоты на продажу. Это ОТДЕЛЬНАЯ сущность от каталога трейтов выше:
    -- каталог — "какие модели вообще бывают", листинги — "что сейчас продаётся".
    CREATE TABLE IF NOT EXISTS listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
        collection_id INTEGER NOT NULL REFERENCES collections(id),
        model_id INTEGER REFERENCES gift_models(id),
        backdrop_id INTEGER REFERENCES gift_backdrops(id),
        symbol_id INTEGER REFERENCES gift_symbols(id),
        gift_number INTEGER NOT NULL,   -- порядковый номер конкретного экземпляра, напр. #56824
        nft_address TEXT,               -- адрес конкретного NFT в TON, если известен
        price REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', -- active | sold | cancelled
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sold_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_collection ON listings(collection_id);

    -- История операций пользователя (для экрана "История"): пополнения, выводы,
    -- покупки и продажи NFT. Данные о подарке денормализованы (снимок на момент
    -- операции), а не через JOIN на listings — так карточка в истории остаётся
    -- верной, даже если позже сам листинг/трейты поменяются или лот исчезнет.
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER NOT NULL REFERENCES users(tg_id),
        type TEXT NOT NULL,             -- deposit | withdraw | buy | sell
        amount REAL NOT NULL,           -- знак: + получено (пополнение/продажа), - потрачено (вывод/покупка)
        listing_id INTEGER REFERENCES listings(id),
        collection_name TEXT,
        collection_image TEXT,
        model_name TEXT,
        model_image TEXT,
        backdrop_name TEXT,
        backdrop_color TEXT,
        symbol_name TEXT,
        symbol_icon TEXT,
        gift_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_tg_id ON transactions(tg_id, created_at DESC);

    -- Ордера на покупку: пользователь резервирует сумму (max_price) и указывает,
    -- какой подарок хочет купить — коллекция обязательна, модель/фон/символ
    -- необязательны (NULL = "любой"). Как только кто-то выставляет подходящий
    -- листинг (см. findMatchingOrder), сделка исполняется мгновенно.
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        buyer_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
        collection_id INTEGER NOT NULL REFERENCES collections(id),
        model_id INTEGER REFERENCES gift_models(id),
        backdrop_id INTEGER REFERENCES gift_backdrops(id),
        symbol_id INTEGER REFERENCES gift_symbols(id),
        max_price REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', -- active | cancelled | filled
        matched_listing_id INTEGER REFERENCES listings(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_tg_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_match ON orders(collection_id, model_id, backdrop_id, symbol_id, status);
`);

// === Миграция: добавляем новые колонки в уже существующую базу ===
// (CREATE TABLE IF NOT EXISTS не трогает таблицы, которые уже были созданы раньше —
// если база уже существовала до этого изменения, новых колонок в ней ещё нет.)
function addColumnIfMissing(table, column, definition) {
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e) {
        // Колонка уже есть — это ожидаемо и нормально, ничего не делаем.
        if (!/duplicate column name/i.test(e.message)) throw e;
    }
}

addColumnIfMissing('gift_models', 'image_url', 'TEXT');
addColumnIfMissing('gift_backdrops', 'image_url', 'TEXT');

// === Подготовленные запросы: пользователи ===
const userStatements = {
    findByTgId: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
    insertUser: db.prepare(`
        INSERT INTO users (tg_id, username, first_name, last_name, photo_url)
        VALUES (@tg_id, @username, @first_name, @last_name, @photo_url)
    `),
    updateProfile: db.prepare(`
        UPDATE users
        SET username = @username, first_name = @first_name, last_name = @last_name, photo_url = @photo_url
        WHERE tg_id = @tg_id
    `),
    updateBalance: db.prepare('UPDATE users SET balance = ? WHERE tg_id = ?'),
};

function findOrCreateUser(tgUser) {
    const existing = userStatements.findByTgId.get(tgUser.id);

    const profile = {
        tg_id: tgUser.id,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        last_name: tgUser.last_name || null,
        photo_url: tgUser.photo_url || null,
    };

    if (existing) {
        userStatements.updateProfile.run(profile);
        return userStatements.findByTgId.get(tgUser.id);
    }

    userStatements.insertUser.run(profile);
    return userStatements.findByTgId.get(tgUser.id);
}

function getUserByTgId(tgId) {
    return userStatements.findByTgId.get(tgId);
}

function setBalance(tgId, newBalance) {
    userStatements.updateBalance.run(newBalance, tgId);
    return getUserByTgId(tgId);
}

function adjustBalance(tgId, delta) {
    const user = getUserByTgId(tgId);
    if (!user) throw new Error('Пользователь не найден');

    const newBalance = user.balance + delta;
    if (newBalance < 0) throw new Error('Недостаточно средств');

    return setBalance(tgId, newBalance);
}

// === Подготовленные запросы: коллекции и каталог трейтов (используется сид-скриптом) ===
const catalogStatements = {
    upsertCollection: db.prepare(`
        INSERT INTO collections (ton_address, name, image_url)
        VALUES (@ton_address, @name, @image_url)
        ON CONFLICT(ton_address) DO UPDATE SET name = excluded.name, image_url = excluded.image_url
    `),
    findCollectionByAddress: db.prepare('SELECT * FROM collections WHERE ton_address = ?'),
    listCollections: db.prepare('SELECT * FROM collections ORDER BY name'),

    upsertModel: db.prepare(`
        INSERT INTO gift_models (collection_id, name, image_url, rarity_permille)
        VALUES (@collection_id, @name, @image_url, @rarity_permille)
        ON CONFLICT(collection_id, name) DO UPDATE SET
            rarity_permille = excluded.rarity_permille,
            image_url = COALESCE(excluded.image_url, gift_models.image_url)
    `),
    upsertBackdrop: db.prepare(`
        INSERT INTO gift_backdrops (collection_id, name, color_hex, image_url, rarity_permille)
        VALUES (@collection_id, @name, @color_hex, @image_url, @rarity_permille)
        ON CONFLICT(collection_id, name) DO UPDATE SET
            rarity_permille = excluded.rarity_permille,
            image_url = COALESCE(excluded.image_url, gift_backdrops.image_url)
    `),
    upsertSymbol: db.prepare(`
        INSERT INTO gift_symbols (collection_id, name, icon_url, rarity_permille)
        VALUES (@collection_id, @name, @icon_url, @rarity_permille)
        ON CONFLICT(collection_id, name) DO UPDATE SET rarity_permille = excluded.rarity_permille
    `),

    modelsByCollection: db.prepare('SELECT id, collection_id, name, image_url, ROUND(rarity_permille / 10.0, 2) AS rarity_permille FROM gift_models WHERE collection_id = ? ORDER BY name'),
    backdropsByCollection: db.prepare('SELECT id, collection_id, name, color_hex, image_url, ROUND(rarity_permille / 10.0, 2) AS rarity_permille FROM gift_backdrops WHERE collection_id = ? ORDER BY name'),
    symbolsByCollection: db.prepare('SELECT id, collection_id, name, icon_url, ROUND(rarity_permille / 10.0, 2) AS rarity_permille FROM gift_symbols WHERE collection_id = ? ORDER BY name'),

    // Уникальные названия по ВСЕМ коллекциям сразу — для фильтров, когда
    // конкретная коллекция ещё не выбрана (сужаем список, только если выбрали "NFT").
    // Берём картинку/цвет/редкость из первой попавшейся строки с таким именем.
    allModelNames: db.prepare(`
        SELECT name, MIN(image_url) AS image_url, ROUND(AVG(rarity_permille) / 10.0, 2) AS rarity_permille
        FROM gift_models GROUP BY name ORDER BY name
    `),
    allBackdropNames: db.prepare(`
        SELECT name, MIN(color_hex) AS color_hex, MIN(image_url) AS image_url, ROUND(AVG(rarity_permille) / 10.0, 2) AS rarity_permille
        FROM gift_backdrops GROUP BY name ORDER BY name
    `),
    allSymbolNames: db.prepare(`
        SELECT name, MIN(icon_url) AS icon_url, ROUND(AVG(rarity_permille) / 10.0, 2) AS rarity_permille
        FROM gift_symbols GROUP BY name ORDER BY name
    `),
};

function upsertCollection({ ton_address, name, image_url }) {
    catalogStatements.upsertCollection.run({ ton_address: ton_address || null, name, image_url: image_url || null });
    return catalogStatements.findCollectionByAddress.get(ton_address);
}

function listCollections() {
    return catalogStatements.listCollections.all();
}

function upsertModel(collection_id, name, rarity_permille, image_url) {
    catalogStatements.upsertModel.run({ collection_id, name, rarity_permille: rarity_permille ?? null, image_url: image_url || null });
}

function upsertBackdrop(collection_id, name, color_hex, rarity_permille, image_url) {
    catalogStatements.upsertBackdrop.run({ collection_id, name, color_hex: color_hex || null, rarity_permille: rarity_permille ?? null, image_url: image_url || null });
}

function upsertSymbol(collection_id, name, icon_url, rarity_permille) {
    catalogStatements.upsertSymbol.run({ collection_id, name, icon_url: icon_url || null, rarity_permille: rarity_permille ?? null });
}

function getFiltersForCollection(collection_id) {
    return {
        models: catalogStatements.modelsByCollection.all(collection_id),
        backdrops: catalogStatements.backdropsByCollection.all(collection_id),
        symbols: catalogStatements.symbolsByCollection.all(collection_id),
    };
}

/**
 * Уникальные модели/фоны/символы — по всем коллекциям, либо только по
 * переданному списку id коллекций (сужение при выборе конкретных NFT).
 */
function getAllFilters(collectionIds) {
    if (Array.isArray(collectionIds) && collectionIds.length > 0) {
        const placeholders = collectionIds.map((_, i) => `@id${i}`).join(',');
        const params = {};
        collectionIds.forEach((id, i) => { params[`id${i}`] = id; });

        const models = db.prepare(`
            SELECT name, MIN(image_url) AS image_url, ROUND(AVG(rarity_permille) / 10.0, 2) AS rarity_permille
            FROM gift_models WHERE collection_id IN (${placeholders}) GROUP BY name ORDER BY name
        `).all(params);
        const backdrops = db.prepare(`
            SELECT name, MIN(color_hex) AS color_hex, MIN(image_url) AS image_url, ROUND(AVG(rarity_permille) / 10.0, 2) AS rarity_permille
            FROM gift_backdrops WHERE collection_id IN (${placeholders}) GROUP BY name ORDER BY name
        `).all(params);
        const symbols = db.prepare(`
            SELECT name, MIN(icon_url) AS icon_url, ROUND(AVG(rarity_permille) / 10.0, 2) AS rarity_permille
            FROM gift_symbols WHERE collection_id IN (${placeholders}) GROUP BY name ORDER BY name
        `).all(params);

        return { models, backdrops, symbols };
    }

    return {
        models: catalogStatements.allModelNames.all(),
        backdrops: catalogStatements.allBackdropNames.all(),
        symbols: catalogStatements.allSymbolNames.all(),
    };
}

// === Подготовленные запросы: листинги (реальные лоты на продажу) ===
const listingStatements = {
    insert: db.prepare(`
        INSERT INTO listings (owner_tg_id, collection_id, model_id, backdrop_id, symbol_id, gift_number, nft_address, price)
        VALUES (@owner_tg_id, @collection_id, @model_id, @backdrop_id, @symbol_id, @gift_number, @nft_address, @price)
    `),
    findById: db.prepare('SELECT * FROM listings WHERE id = ?'),
    setStatus: db.prepare(`UPDATE listings SET status = ?, sold_at = CASE WHEN ? = 'sold' THEN datetime('now') ELSE sold_at END WHERE id = ?`),
};

function createListing(data) {
    const info = listingStatements.insert.run(data);
    return listingStatements.findById.get(info.lastInsertRowid);
}

function getListingById(id) {
    return listingStatements.findById.get(id);
}

/** Как getListingById, но с названиями/картинками трейтов через JOIN (без ограничения
 * по статусу) — нужно для снимка данных подарка при записи операции в историю. */
function getListingWithDetails(id) {
    return db.prepare(`
        SELECT
            l.id, l.price, l.gift_number, l.nft_address, l.status, l.created_at, l.owner_tg_id,
            c.id AS collection_id, c.name AS collection_name, c.image_url AS collection_image,
            gm.name AS model_name, gm.image_url AS model_image, gm.rarity_permille AS model_rarity,
            gb.name AS backdrop_name, gb.color_hex AS backdrop_color, gb.rarity_permille AS backdrop_rarity,
            gs.name AS symbol_name, gs.icon_url AS symbol_icon, gs.rarity_permille AS symbol_rarity
        FROM listings l
        JOIN collections c ON c.id = l.collection_id
        LEFT JOIN gift_models gm ON gm.id = l.model_id
        LEFT JOIN gift_backdrops gb ON gb.id = l.backdrop_id
        LEFT JOIN gift_symbols gs ON gs.id = l.symbol_id
        WHERE l.id = ?
    `).get(id);
}

function setListingStatus(id, status) {
    listingStatements.setStatus.run(status, status, id);
    return getListingById(id);
}

/**
 * Гибкая выборка активных листингов с join'ом на названия трейтов —
 * ровно то, что нужно фронту для карточек и фильтров.
 * filters: { collectionId, modelName, backdropName, symbolName, search, sort }
 * Каждое из collectionId/modelName/backdropName/symbolName может быть
 * одиночным значением ИЛИ массивом значений (мультивыбор — "любое из").
 */
function findListings(filters = {}) {
    const where = [`l.status = 'active'`];
    const params = {};

    // Добавляет условие "поле IN (...)" или "поле = ..." в зависимости от того,
    // передан массив или одно значение.
    function addFilter(column, value, paramPrefix) {
        if (value === undefined || value === null) return;
        const values = Array.isArray(value) ? value : [value];
        if (values.length === 0) return;

        if (values.length === 1) {
            const key = paramPrefix;
            where.push(`${column} = @${key}`);
            params[key] = values[0];
        } else {
            const placeholders = values.map((_, i) => {
                const key = `${paramPrefix}${i}`;
                params[key] = values[i];
                return `@${key}`;
            });
            where.push(`${column} IN (${placeholders.join(',')})`);
        }
    }

    addFilter('l.collection_id', filters.collectionId, 'collectionId');
    addFilter('gm.name', filters.modelName, 'modelName');
    addFilter('gb.name', filters.backdropName, 'backdropName');
    addFilter('gs.name', filters.symbolName, 'symbolName');

    if (filters.search) {
        where.push('c.name LIKE @search');
        params.search = `%${filters.search}%`;
    }

    const sortMap = {
        price_asc: 'l.price ASC',
        price_desc: 'l.price DESC',
        time_asc: 'l.created_at ASC',
        time_desc: 'l.created_at DESC',
        num_asc: 'l.gift_number ASC',
        num_desc: 'l.gift_number DESC',
    };
    const orderBy = sortMap[filters.sort] || 'l.created_at DESC';

    const sql = `
        SELECT
            l.id, l.price, l.gift_number, l.nft_address, l.status, l.created_at, l.owner_tg_id,
            c.id AS collection_id, c.name AS collection_name, c.image_url AS collection_image,
            gm.name AS model_name, gm.image_url AS model_icon, gm.rarity_permille AS model_rarity,
            gb.name AS backdrop_name, gb.color_hex AS backdrop_color, gb.rarity_permille AS backdrop_rarity,
            gs.name AS symbol_name, gs.icon_url AS symbol_icon, gs.rarity_permille AS symbol_rarity
        FROM listings l
        JOIN collections c ON c.id = l.collection_id
        LEFT JOIN gift_models gm ON gm.id = l.model_id
        LEFT JOIN gift_backdrops gb ON gb.id = l.backdrop_id
        LEFT JOIN gift_symbols gs ON gs.id = l.symbol_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
    `;

    return db.prepare(sql).all(params);
}

// === Подготовленные запросы: история операций (пополнения/выводы/покупки/продажи) ===
const transactionStatements = {
    insert: db.prepare(`
        INSERT INTO transactions (
            tg_id, type, amount, listing_id,
            collection_name, collection_image,
            model_name, model_image,
            backdrop_name, backdrop_color,
            symbol_name, symbol_icon,
            gift_number
        ) VALUES (
            @tg_id, @type, @amount, @listing_id,
            @collection_name, @collection_image,
            @model_name, @model_image,
            @backdrop_name, @backdrop_color,
            @symbol_name, @symbol_icon,
            @gift_number
        )
    `),
    listByUser: db.prepare('SELECT * FROM transactions WHERE tg_id = ? ORDER BY created_at DESC, id DESC'),
};

/**
 * Записывает одну операцию в историю пользователя.
 * data: { tg_id, type: 'deposit'|'withdraw'|'buy'|'sell', amount, listing_id?,
 *         collection_name?, collection_image?, model_name?, model_image?,
 *         backdrop_name?, backdrop_color?, symbol_name?, symbol_icon?, gift_number? }
 * Поля подарка необязательны — для deposit/withdraw их просто не передают (останутся NULL).
 */
function createTransaction(data) {
    const info = transactionStatements.insert.run({
        tg_id: data.tg_id,
        type: data.type,
        amount: data.amount,
        listing_id: data.listing_id ?? null,
        collection_name: data.collection_name ?? null,
        collection_image: data.collection_image ?? null,
        model_name: data.model_name ?? null,
        model_image: data.model_image ?? null,
        backdrop_name: data.backdrop_name ?? null,
        backdrop_color: data.backdrop_color ?? null,
        symbol_name: data.symbol_name ?? null,
        symbol_icon: data.symbol_icon ?? null,
        gift_number: data.gift_number ?? null,
    });
    return info.lastInsertRowid;
}

function listTransactionsForUser(tgId) {
    return transactionStatements.listByUser.all(tgId);
}

// === Подготовленные запросы: ордера на покупку ===
const orderStatements = {
    insert: db.prepare(`
        INSERT INTO orders (buyer_tg_id, collection_id, model_id, backdrop_id, symbol_id, max_price)
        VALUES (@buyer_tg_id, @collection_id, @model_id, @backdrop_id, @symbol_id, @max_price)
    `),
    findById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    setStatus: db.prepare(`
        UPDATE orders
        SET status = ?,
            matched_listing_id = COALESCE(?, matched_listing_id),
            closed_at = CASE WHEN ? != 'active' THEN datetime('now') ELSE closed_at END
        WHERE id = ?
    `),
};

function createOrder(data) {
    const info = orderStatements.insert.run({
        buyer_tg_id: data.buyer_tg_id,
        collection_id: data.collection_id,
        model_id: data.model_id ?? null,
        backdrop_id: data.backdrop_id ?? null,
        symbol_id: data.symbol_id ?? null,
        max_price: data.max_price,
    });
    return orderStatements.findById.get(info.lastInsertRowid);
}

function getOrderById(id) {
    return orderStatements.findById.get(id);
}

function setOrderStatus(id, status, matchedListingId = null) {
    orderStatements.setStatus.run(status, matchedListingId, status, id);
    return getOrderById(id);
}

// Общий SELECT: критерии ордера (коллекция/модель/фон/символ, через JOIN на
// каталог трейтов — так же, как для листингов) + данные исполненного лота,
// если ордер уже сматчился (matched_listing_id).
function ordersDetailQuery() {
    return `
        SELECT
            o.id, o.buyer_tg_id, o.max_price, o.status, o.created_at, o.closed_at, o.matched_listing_id,
            c.id AS collection_id, c.name AS collection_name, c.image_url AS collection_image,
            gm.name AS model_name, gm.image_url AS model_image,
            gb.name AS backdrop_name, gb.color_hex AS backdrop_color,
            gs.name AS symbol_name, gs.icon_url AS symbol_icon,
            ml.price AS matched_price, ml.gift_number AS matched_gift_number
        FROM orders o
        JOIN collections c ON c.id = o.collection_id
        LEFT JOIN gift_models gm ON gm.id = o.model_id
        LEFT JOIN gift_backdrops gb ON gb.id = o.backdrop_id
        LEFT JOIN gift_symbols gs ON gs.id = o.symbol_id
        LEFT JOIN listings ml ON ml.id = o.matched_listing_id
    `;
}

function getOrderWithDetails(id) {
    return db.prepare(`${ordersDetailQuery()} WHERE o.id = ?`).get(id);
}

function listActiveOrdersForUser(tgId) {
    return db.prepare(`${ordersDetailQuery()} WHERE o.buyer_tg_id = ? AND o.status = 'active' ORDER BY o.created_at DESC`).all(tgId);
}

function listOrderHistoryForUser(tgId) {
    return db.prepare(`${ordersDetailQuery()} WHERE o.buyer_tg_id = ? AND o.status != 'active' ORDER BY o.created_at DESC`).all(tgId);
}

/**
 * Ищет лучший активный ордер под свежесозданный листинг: коллекция обязана
 * совпасть, модель/фон/символ ордера — либо совпадают с листингом, либо не
 * заданы в ордере (NULL = "любой"), а цена ордера должна покрывать цену лота.
 * При нескольких подходящих берём тот, что предлагает больше денег, а при
 * равной цене — тот, что ждёт дольше.
 */
function findMatchingOrder(listing) {
    return db.prepare(`
        SELECT * FROM orders
        WHERE status = 'active'
          AND collection_id = @collection_id
          AND (model_id IS NULL OR model_id = @model_id)
          AND (backdrop_id IS NULL OR backdrop_id = @backdrop_id)
          AND (symbol_id IS NULL OR symbol_id = @symbol_id)
          AND max_price >= @price
        ORDER BY max_price DESC, created_at ASC
        LIMIT 1
    `).get({
        collection_id: listing.collection_id,
        model_id: listing.model_id,
        backdrop_id: listing.backdrop_id,
        symbol_id: listing.symbol_id,
        price: listing.price,
    });
}

module.exports = {
    db,
    findOrCreateUser,
    getUserByTgId,
    setBalance,
    adjustBalance,
    upsertCollection,
    listCollections,
    upsertModel,
    upsertBackdrop,
    upsertSymbol,
    getFiltersForCollection,
    getAllFilters,
    createListing,
    getListingById,
    getListingWithDetails,
    setListingStatus,
    findListings,
    createTransaction,
    listTransactionsForUser,
    createOrder,
    getOrderById,
    getOrderWithDetails,
    setOrderStatus,
    listActiveOrdersForUser,
    listOrderHistoryForUser,
    findMatchingOrder,
};
