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
        -- active — выставлен на продажу и виден в маркете
        -- owned — принадлежит owner_tg_id, но не продаётся: лежит в "Хранилище"
        --         (товар попадает сюда и после покупки, и при снятии с продажи)
        -- sold/cancelled — оставлены для обратной совместимости со старыми записями,
        --                   новый код их больше не использует
        status TEXT NOT NULL DEFAULT 'active', -- active | owned | sold | cancelled
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
        quantity INTEGER NOT NULL DEFAULT 1,     -- сколько айтемов всего нужно купить
        filled_count INTEGER NOT NULL DEFAULT 0, -- сколько уже куплено по этому ордеру
        status TEXT NOT NULL DEFAULT 'active', -- active | cancelled | filled
        matched_listing_id INTEGER REFERENCES listings(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_tg_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_match ON orders(collection_id, model_id, backdrop_id, symbol_id, status);

    -- Трейд (P2P-обмен подарками между двумя пользователями). Одна запись —
    -- одно предложение обмена: initiator предлагает свои предметы (и/или
    -- запрашивает предметы recipient'а), recipient соглашается или отклоняет.
    CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        initiator_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
        recipient_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
        status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled | failed
        fail_reason TEXT,
        -- Доплата TON поверх обмена предметами (необязательная):
        -- ton_payer = 'initiator' — доплачивает инициатор получателю (в дополнение
        --             к своим предметам, "с себя доплата на нфт другого человека");
        -- ton_payer = 'recipient' — доплачивает получатель инициатору (инициатор
        --             "просит доплату" за свои предметы);
        -- ton_payer = NULL / ton_amount = 0 — доплаты нет.
        ton_amount REAL NOT NULL DEFAULT 0,
        ton_payer TEXT,                          -- 'initiator' | 'recipient' | NULL
        -- Комиссия площадки за трейд — резервируется у инициатора СРАЗУ при
        -- создании (см. createTrade), возвращается при cancelled/declined/failed,
        -- списывается безвозвратно только если трейд успешно принят (accepted).
        fee_amount REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
    );

    -- Конкретные предметы (листинги в статусе 'owned'), участвующие в трейде —
    -- side указывает, чья это сторона: 'initiator' или 'recipient'.
    CREATE TABLE IF NOT EXISTS trade_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        side TEXT NOT NULL -- initiator | recipient
    );

    CREATE INDEX IF NOT EXISTS idx_trades_recipient ON trades(recipient_tg_id, status);
    CREATE INDEX IF NOT EXISTS idx_trades_initiator ON trades(initiator_tg_id, status);
    CREATE INDEX IF NOT EXISTS idx_trade_items_trade ON trade_items(trade_id);

    -- Реальные TON-пополнения. Каждая заявка на пополнение получает уникальный
    -- memo (комментарий) — пользователь отправляет TON на кошелёк площадки
    -- именно с этим комментарием, а сервер сверяет входящие переводы через
    -- TonAPI по memo+сумме и только тогда зачисляет баланс (см. server.js,
    -- /api/deposit/init и /api/deposit/:id/status). tx_hash уникален, чтобы
    -- одна и та же ончейн-транзакция не могла зачислить баланс дважды.
    CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER NOT NULL REFERENCES users(tg_id),
        amount REAL NOT NULL,
        memo TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | expired
        tx_hash TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        confirmed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_deposits_tg_id ON deposits(tg_id, status);
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
addColumnIfMissing('trades', 'ton_amount', "REAL NOT NULL DEFAULT 0");
addColumnIfMissing('trades', 'ton_payer', 'TEXT');
addColumnIfMissing('trades', 'fee_amount', "REAL NOT NULL DEFAULT 0");
// Ордер теперь может просить сразу НЕСКОЛЬКО одинаковых айтемов — quantity
// (сколько всего) и filled_count (сколько уже куплено по этому ордеру).
// У старых ордеров, созданных до этого изменения, quantity=1, filled_count=0 —
// именно так они себя и вели раньше (один ордер = один айтем).
addColumnIfMissing('orders', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('orders', 'filled_count', 'INTEGER NOT NULL DEFAULT 0');

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
        INSERT INTO listings (owner_tg_id, collection_id, model_id, backdrop_id, symbol_id, gift_number, nft_address, price, status)
        VALUES (@owner_tg_id, @collection_id, @model_id, @backdrop_id, @symbol_id, @gift_number, @nft_address, @price, @status)
    `),
    findById: db.prepare('SELECT * FROM listings WHERE id = ?'),
    setStatus: db.prepare(`UPDATE listings SET status = ?, sold_at = CASE WHEN ? = 'sold' THEN datetime('now') ELSE sold_at END WHERE id = ?`),
    // При покупке товар не просто "продан" — он переходит к покупателю и
    // оседает в его личном "Хранилище" (status = 'owned'), откуда его можно
    // либо просто держать, либо выставить обратно на продажу через relist.
    transferToBuyer: db.prepare(`UPDATE listings SET owner_tg_id = ?, status = 'owned', sold_at = datetime('now') WHERE id = ?`),
    // Возврат владельцу в хранилище — используется при снятии лота с продажи
    // (раньше товар после отмены просто "исчезал" в статусе cancelled).
    returnToOwner: db.prepare(`UPDATE listings SET status = 'owned' WHERE id = ?`),
    // Повторное выставление на продажу уже принадлежащего пользователю товара
    // (из "Хранилища") — та же запись листинга, новая цена, снова активна.
    relist: db.prepare(`UPDATE listings SET status = 'active', price = ?, created_at = datetime('now'), sold_at = NULL WHERE id = ?`),
};

function createListing(data) {
    // status необязателен — по умолчанию 'active' (как было раньше, для
    // обычного выставления на продажу). Передав status: 'owned' можно
    // сразу добавить подарок в личное "Хранилище", минуя маркет.
    const info = listingStatements.insert.run({ status: 'active', ...data });
    return listingStatements.findById.get(info.lastInsertRowid);
}

function getListingById(id) {
    return listingStatements.findById.get(id);
}

function transferListingToBuyer(id, buyerTgId) {
    listingStatements.transferToBuyer.run(buyerTgId, id);
    return getListingById(id);
}

function returnListingToOwnerStorage(id) {
    listingStatements.returnToOwner.run(id);
    return getListingById(id);
}

function relistOwnedItem(id, price) {
    listingStatements.relist.run(price, id);
    return getListingById(id);
}

/** Товары текущего пользователя, которые ему принадлежат, но сейчас НЕ
 * выставлены на продажу (лежат в "Хранилище") — те же поля/join'ы, что и
 * у карточек маркета, чтобы фронт мог переиспользовать те же компоненты. */
function listOwnedItemsForUser(tgId) {
    return db.prepare(`
        SELECT
            l.id, l.price, l.gift_number, l.nft_address, l.status, l.created_at, l.sold_at, l.owner_tg_id,
            c.id AS collection_id, c.name AS collection_name, c.image_url AS collection_image,
            gm.id AS model_id, gm.name AS model_name, gm.image_url AS model_icon, gm.rarity_permille AS model_rarity,
            gb.id AS backdrop_id, gb.name AS backdrop_name, gb.color_hex AS backdrop_color, gb.rarity_permille AS backdrop_rarity,
            gs.id AS symbol_id, gs.name AS symbol_name, gs.icon_url AS symbol_icon, gs.rarity_permille AS symbol_rarity
        FROM listings l
        JOIN collections c ON c.id = l.collection_id
        LEFT JOIN gift_models gm ON gm.id = l.model_id
        LEFT JOIN gift_backdrops gb ON gb.id = l.backdrop_id
        LEFT JOIN gift_symbols gs ON gs.id = l.symbol_id
        WHERE l.owner_tg_id = ? AND l.status = 'owned'
        ORDER BY l.sold_at DESC, l.created_at DESC
    `).all(tgId);
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
    addFilter('l.owner_tg_id', filters.ownerTgId, 'ownerTgId');

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
            gm.id AS model_id, gm.name AS model_name, gm.image_url AS model_icon, gm.rarity_permille AS model_rarity,
            gb.id AS backdrop_id, gb.name AS backdrop_name, gb.color_hex AS backdrop_color, gb.rarity_permille AS backdrop_rarity,
            gs.id AS symbol_id, gs.name AS symbol_name, gs.icon_url AS symbol_icon, gs.rarity_permille AS symbol_rarity
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

// === Подготовленные запросы: реальные TON-пополнения ===
const depositStatements = {
    insert: db.prepare('INSERT INTO deposits (tg_id, amount, memo) VALUES (?, ?, ?)'),
    findById: db.prepare('SELECT * FROM deposits WHERE id = ?'),
    findByMemo: db.prepare('SELECT * FROM deposits WHERE memo = ?'),
    findByTxHash: db.prepare('SELECT * FROM deposits WHERE tx_hash = ?'),
    confirm: db.prepare(`UPDATE deposits SET status = 'confirmed', tx_hash = ?, confirmed_at = datetime('now') WHERE id = ?`),
    expire: db.prepare(`UPDATE deposits SET status = 'expired' WHERE id = ?`),
};

function createDeposit(tgId, amount, memo) {
    const info = depositStatements.insert.run(tgId, amount, memo);
    return depositStatements.findById.get(info.lastInsertRowid);
}

function getDepositById(id) {
    return depositStatements.findById.get(id);
}

function getDepositByMemo(memo) {
    return depositStatements.findByMemo.get(memo);
}

function getDepositByTxHash(txHash) {
    return depositStatements.findByTxHash.get(txHash);
}

function confirmDeposit(id, txHash) {
    depositStatements.confirm.run(txHash, id);
    return getDepositById(id);
}

function expireDeposit(id) {
    depositStatements.expire.run(id);
    return getDepositById(id);
}

// === Подготовленные запросы: ордера на покупку ===
const orderStatements = {
    insert: db.prepare(`
        INSERT INTO orders (buyer_tg_id, collection_id, model_id, backdrop_id, symbol_id, max_price, quantity)
        VALUES (@buyer_tg_id, @collection_id, @model_id, @backdrop_id, @symbol_id, @max_price, @quantity)
    `),
    findById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    setStatus: db.prepare(`
        UPDATE orders
        SET status = ?,
            matched_listing_id = COALESCE(?, matched_listing_id),
            closed_at = CASE WHEN ? != 'active' THEN datetime('now') ELSE closed_at END
        WHERE id = ?
    `),
    // Засчитывает ОДНУ продажу по ордеру (filled_count+1) — ордер остаётся
    // 'active', пока не выкуплено всё запрошенное количество, и закрывается
    // сам собой, когда filled_count достигает quantity.
    fillOnce: db.prepare(`
        UPDATE orders
        SET filled_count = filled_count + 1,
            matched_listing_id = ?,
            status = CASE WHEN filled_count + 1 >= quantity THEN 'filled' ELSE status END,
            closed_at = CASE WHEN filled_count + 1 >= quantity THEN datetime('now') ELSE closed_at END
        WHERE id = ?
    `),
};

/** Проверяет, есть ли у пользователя собственный активный лот, который
 * совпадёт с ордером, задаваемым этими фильтрами — та же логика сопоставления,
 * что и в listOffersForUser (NULL в фильтре ордера = "любой"). Используется,
 * чтобы не дать пользователю создать ордер на покупку, который тут же
 * "сматчится" с его же собственным лотом. */
function hasOwnMatchingListing(tgId, { collectionId, modelId, backdropId, symbolId }) {
    const row = db.prepare(`
        SELECT 1 FROM listings
        WHERE status = 'active'
          AND owner_tg_id = @tg_id
          AND collection_id = @collection_id
          AND (@model_id IS NULL OR model_id = @model_id)
          AND (@backdrop_id IS NULL OR backdrop_id = @backdrop_id)
          AND (@symbol_id IS NULL OR symbol_id = @symbol_id)
        LIMIT 1
    `).get({
        tg_id: tgId,
        collection_id: collectionId,
        model_id: modelId ?? null,
        backdrop_id: backdropId ?? null,
        symbol_id: symbolId ?? null,
    });
    return !!row;
}

function createOrder(data) {
    const info = orderStatements.insert.run({
        buyer_tg_id: data.buyer_tg_id,
        collection_id: data.collection_id,
        model_id: data.model_id ?? null,
        backdrop_id: data.backdrop_id ?? null,
        symbol_id: data.symbol_id ?? null,
        max_price: data.max_price,
        quantity: data.quantity ?? 1,
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

// Засчитывает выкуп ОДНОЙ единицы по ордеру (см. orderStatements.fillOnce) —
// используется и при мгновенном авто-матче на создание лота, и при принятии
// предложения продавцом; ордер закрывается сам, когда выкуплено всё quantity.
function fillOrderOnce(id, listingId) {
    orderStatements.fillOnce.run(listingId, id);
    return getOrderById(id);
}

// Общий SELECT: критерии ордера (коллекция/модель/фон/символ, через JOIN на
// каталог трейтов — так же, как для листингов) + данные исполненного лота,
// если ордер уже сматчился (matched_listing_id).
function ordersDetailQuery() {
    return `
        SELECT
            o.id, o.buyer_tg_id, o.max_price, o.quantity, o.filled_count, o.status, o.created_at, o.closed_at, o.matched_listing_id,
            c.id AS collection_id, c.name AS collection_name, c.image_url AS collection_image,
            gm.id AS model_id, gm.name AS model_name, gm.image_url AS model_image,
            gb.id AS backdrop_id, gb.name AS backdrop_name, gb.color_hex AS backdrop_color,
            gs.id AS symbol_id, gs.name AS symbol_name, gs.icon_url AS symbol_icon,
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
 * Ордербук по конкретной коллекции (для кнопки "Смотреть ордера" на Маркете,
 * открытой при выбранной коллекции) — ВСЕ активные ордера всех покупателей
 * на эту коллекцию, опционально суженные по модели/фону/символу. Ордер
 * считается подходящим, если по этому полю у него не задано ограничение
 * (значит подойдёт любой вариант) ИЛИ оно совпадает с тем, что выбрал
 * смотрящий — то есть он увидит все ордера, которые сможет закрыть,
 * продав айтем с выбранными трейтами.
 */
function listOrdersForCollection({ collectionId, modelName, backdropName, symbolName }) {
    const where = [`o.status = 'active'`, 'o.collection_id = @collection_id'];
    const params = { collection_id: collectionId };

    if (modelName) {
        where.push('(gm.name IS NULL OR gm.name = @model_name)');
        params.model_name = modelName;
    }
    if (backdropName) {
        where.push('(gb.name IS NULL OR gb.name = @backdrop_name)');
        params.backdrop_name = backdropName;
    }
    if (symbolName) {
        where.push('(gs.name IS NULL OR gs.name = @symbol_name)');
        params.symbol_name = symbolName;
    }

    return db.prepare(`
        ${ordersDetailQuery()}
        WHERE ${where.join(' AND ')}
        ORDER BY o.max_price DESC, o.created_at ASC
    `).all(params);
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

/**
 * Возвращает ВСЕ активные ордера, которые подходят под конкретный листинг (та же
 * логика совпадения трейтов, что и при мгновенном матче на создание лота),
 * но БЕЗ фильтра по цене — продавцу нужно видеть все предложения на этот
 * трейт, в том числе ниже цены лота, чтобы самому решить, принимать ли.
 */
function findMatchingOrdersForListing(listing) {
    return db.prepare(`
        SELECT * FROM orders
        WHERE status = 'active'
          AND collection_id = @collection_id
          AND (model_id IS NULL OR model_id = @model_id)
          AND (backdrop_id IS NULL OR backdrop_id = @backdrop_id)
          AND (symbol_id IS NULL OR symbol_id = @symbol_id)
        ORDER BY max_price DESC, created_at ASC
    `).all({
        collection_id: listing.collection_id,
        model_id: listing.model_id,
        backdrop_id: listing.backdrop_id,
        symbol_id: listing.symbol_id,
    });
}

/**
 * Возвращает ВСЕ активные листинги, под которые подходит конкретный ордер
 * (обратная сторона findMatchingOrdersForListing) — используется, чтобы
 * уведомить владельцев подходящих лотов сразу при создании нового ордера
 * ("вам предложили купить ваш подарок"), без фильтра по цене — здесь важен
 * сам факт совпадения трейтов, а не мгновенное исполнение сделки.
 */
function findMatchingListingsForOrder(order) {
    return db.prepare(`
        SELECT l.*,
            c.name AS collection_name, c.image_url AS collection_image,
            gm.name AS model_name, gm.image_url AS model_image,
            gb.name AS backdrop_name, gb.color_hex AS backdrop_color,
            gs.name AS symbol_name, gs.icon_url AS symbol_icon
        FROM listings l
        JOIN collections c ON c.id = l.collection_id
        LEFT JOIN gift_models gm ON gm.id = l.model_id
        LEFT JOIN gift_backdrops gb ON gb.id = l.backdrop_id
        LEFT JOIN gift_symbols gs ON gs.id = l.symbol_id
        WHERE l.status = 'active'
          AND l.owner_tg_id != @buyer_tg_id
          AND l.collection_id = @collection_id
          AND (@model_id IS NULL OR l.model_id = @model_id)
          AND (@backdrop_id IS NULL OR l.backdrop_id = @backdrop_id)
          AND (@symbol_id IS NULL OR l.symbol_id = @symbol_id)
        ORDER BY l.created_at ASC
    `).all({
        buyer_tg_id: order.buyer_tg_id,
        collection_id: order.collection_id,
        model_id: order.model_id,
        backdrop_id: order.backdrop_id,
        symbol_id: order.symbol_id,
    });
}

/**
 * Сводный список предложений (подходящих активных ордеров) по ВСЕМ активным
 * лотам пользователя разом — используется вкладкой "Ордеры → Предложения",
 * чтобы продавец видел все входящие офферы в одном месте, без похода в
 * карточку каждого отдельного лота.
 */
function listOffersForUser(tgId) {
    return db.prepare(`
        SELECT
            o.id AS order_id, o.max_price, o.created_at AS offer_created_at,
            l.id AS listing_id, l.price AS listing_price, l.gift_number,
            c.name AS collection_name, c.image_url AS collection_image,
            gm.name AS model_name, gm.image_url AS model_icon,
            gb.name AS backdrop_name, gb.color_hex AS backdrop_color,
            gs.name AS symbol_name, gs.icon_url AS symbol_icon
        FROM listings l
        JOIN collections c ON c.id = l.collection_id
        LEFT JOIN gift_models gm ON gm.id = l.model_id
        LEFT JOIN gift_backdrops gb ON gb.id = l.backdrop_id
        LEFT JOIN gift_symbols gs ON gs.id = l.symbol_id
        JOIN orders o ON o.status = 'active'
            AND o.collection_id = l.collection_id
            AND (o.model_id IS NULL OR o.model_id = l.model_id)
            AND (o.backdrop_id IS NULL OR o.backdrop_id = l.backdrop_id)
            AND (o.symbol_id IS NULL OR o.symbol_id = l.symbol_id)
        WHERE l.status = 'active' AND l.owner_tg_id = @tg_id
          AND o.buyer_tg_id != l.owner_tg_id
        ORDER BY o.max_price DESC, o.created_at ASC
    `).all({ tg_id: tgId });
}

/** Продавец отклоняет чужое предложение (order) на свой лот — полностью
 * отменяет ЧУЖОЙ ордер на покупку целиком, с возвратом зарезервированных
 * денег покупателю. Ордер при этом пропадает и из "Предложений" у всех
 * остальных продавцов, у которых был похожий лот (он больше не активен).
 * Проверяем, что: (1) лот действительно принадлежит вызывающему, (2) ордер
 * активен и правда подходит под этот лот — не доверяем orderId с фронта вслепую. */
function declineOfferAsSeller(orderId, listingId, sellerTgId) {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    if (!listing || listing.owner_tg_id !== sellerTgId || listing.status !== 'active') {
        return { ok: false, error: 'Это не ваш активный лот' };
    }

    const order = orderStatements.findById.get(orderId);
    if (!order || order.status !== 'active') {
        return { ok: false, error: 'Это предложение уже неактуально' };
    }
    if (
        order.collection_id !== listing.collection_id ||
        (order.model_id !== null && order.model_id !== listing.model_id) ||
        (order.backdrop_id !== null && order.backdrop_id !== listing.backdrop_id) ||
        (order.symbol_id !== null && order.symbol_id !== listing.symbol_id)
    ) {
        return { ok: false, error: 'Предложение не подходит под этот лот' };
    }

    // Возвращаем только НЕвыкупленную часть — если по ордеру уже что-то
    // куплено (quantity > 1), эти деньги покупателю не принадлежат, они уже
    // потрачены на прошлые сделки по этому же ордеру.
    const refund = Math.round(order.max_price * (order.quantity - order.filled_count) * 100) / 100;
    adjustBalance(order.buyer_tg_id, refund);
    orderStatements.setStatus.run('cancelled', null, 'cancelled', orderId);

    return { ok: true };
}

// =====================================================================
// ТРЕЙД (P2P-обмен подарками)
// =====================================================================

/** Поиск пользователей по началу username (без учёта регистра) — для выбора
 * получателя обмена. Исключает самого себя, лимит 10 результатов. */
function searchUsersByUsername(query, excludeTgId) {
    const q = String(query || '').trim().replace(/^@/, '');
    if (!q) return [];
    return db.prepare(`
        SELECT tg_id, username, first_name, last_name, photo_url
        FROM users
        WHERE username IS NOT NULL
          AND LOWER(username) LIKE LOWER(?) || '%'
          AND tg_id != ?
        ORDER BY username ASC
        LIMIT 10
    `).all(q, excludeTgId);
}

/** Предметы конкретного пользователя (по трейтам, так же как listOwnedItemsForUser) —
 * используется, чтобы показать инициатору "предметы получателя" при создании трейда.
 * Данные не приватные — та же информация, что видна на публичных лотах маркета. */
function listOwnedItemsForTgId(tgId) {
    return listOwnedItemsForUser(tgId);
}

const tradeStatements = {
    insertTrade: db.prepare(`
        INSERT INTO trades (initiator_tg_id, recipient_tg_id, ton_amount, ton_payer, fee_amount)
        VALUES (@initiator_tg_id, @recipient_tg_id, @ton_amount, @ton_payer, @fee_amount)
    `),
    insertItem: db.prepare(`INSERT INTO trade_items (trade_id, listing_id, side) VALUES (?, ?, ?)`),
    findById: db.prepare('SELECT * FROM trades WHERE id = ?'),
    itemsForTrade: db.prepare('SELECT * FROM trade_items WHERE trade_id = ?'),
    setStatus: db.prepare(`
        UPDATE trades
        SET status = ?, fail_reason = ?, resolved_at = datetime('now')
        WHERE id = ?
    `),
};

/** Создаёт трейд + строки предметов одной транзакцией. Владение предметами
 * должна была уже проверить вызывающая сторона (маршрут в server.js) —
 * здесь только запись. Резерв денег (комиссия + доплата инициатора, если
 * есть) тоже делает вызывающая сторона ДО вызова этой функции. */
function createTrade({
    initiator_tg_id,
    recipient_tg_id,
    initiatorListingIds,
    recipientListingIds,
    ton_amount = 0,
    ton_payer = null,
    fee_amount = 0,
}) {
    const run = db.transaction(() => {
        const info = tradeStatements.insertTrade.run({
            initiator_tg_id,
            recipient_tg_id,
            ton_amount,
            ton_payer,
            fee_amount,
        });
        const tradeId = info.lastInsertRowid;
        for (const listingId of initiatorListingIds) {
            tradeStatements.insertItem.run(tradeId, listingId, 'initiator');
        }
        for (const listingId of recipientListingIds) {
            tradeStatements.insertItem.run(tradeId, listingId, 'recipient');
        }
        return tradeId;
    });
    const tradeId = run();
    return getTradeWithItems(tradeId);
}

function getTradeById(id) {
    return tradeStatements.findById.get(id);
}

/** Трейд + предметы обеих сторон с подробностями (картинка/название/трейты)
 * + краткие профили инициатора и получателя — всё, что нужно карточке на фронте. */
function getTradeWithItems(id) {
    const trade = getTradeById(id);
    if (!trade) return null;

    const rawItems = tradeStatements.itemsForTrade.all(id);
    const items = rawItems.map(item => ({
        side: item.side,
        ...getListingWithDetails(item.listing_id),
    }));

    return {
        ...trade,
        initiator: getUserByTgId(trade.initiator_tg_id),
        recipient: getUserByTgId(trade.recipient_tg_id),
        initiatorItems: items.filter(i => i.side === 'initiator'),
        recipientItems: items.filter(i => i.side === 'recipient'),
    };
}

/** Входящие предложения обмена, ожидающие решения пользователя (он — получатель). */
function listIncomingTradesForUser(tgId) {
    const rows = db.prepare(`
        SELECT id FROM trades WHERE recipient_tg_id = ? AND status = 'pending' ORDER BY created_at DESC
    `).all(tgId);
    return rows.map(r => getTradeWithItems(r.id));
}

/** Все трейды пользователя (как инициатора, так и получателя) — для вкладки
 * "Мои обмены": и ожидающие исходящие, и уже завершённые с обеих сторон. */
function listMyTradesForUser(tgId) {
    const rows = db.prepare(`
        SELECT id FROM trades
        WHERE initiator_tg_id = ? OR recipient_tg_id = ?
        ORDER BY created_at DESC
    `).all(tgId, tgId);
    return rows.map(r => getTradeWithItems(r.id));
}

/** Проверяет, что каждый предмет по-прежнему принадлежит заявленной стороне
 * и лежит в "Хранилище" (status='owned') — перепроверка на случай, если
 * предмет успели продать/выставить на продажу за время ожидания ответа. */
function verifyTradeItemsStillValid(trade) {
    for (const item of trade.initiatorItems) {
        if (item.owner_tg_id !== trade.initiator_tg_id || item.status !== 'owned') return false;
    }
    for (const item of trade.recipientItems) {
        if (item.owner_tg_id !== trade.recipient_tg_id || item.status !== 'owned') return false;
    }
    return true;
}

/** Принять трейд: recipient подтверждает обмен. Меняет владельца всех
 * предметов местами в одной транзакции, проводит доплату TON (если есть)
 * и оставляет комиссию площадки удержанной с инициатора (она уже была
 * зарезервирована при создании трейда — см. POST /api/trades).
 * Возвращает { ok, trade, error }. */
function acceptTrade(tradeId, actingTgId) {
    const trade = getTradeWithItems(tradeId);
    if (!trade) return { ok: false, error: 'Трейд не найден' };
    if (trade.recipient_tg_id !== actingTgId) return { ok: false, error: 'Это не ваше предложение обмена' };
    if (trade.status !== 'pending') return { ok: false, error: 'Этот трейд уже закрыт' };

    if (!verifyTradeItemsStillValid(trade)) {
        // Трейд не удался не по вине сторон (предмет продан/снят за время
        // ожидания) — возвращаем инициатору всё, что было у него зарезервировано.
        db.transaction(() => {
            tradeStatements.setStatus.run('failed', 'Один из предметов больше недоступен', tradeId);
            refundInitiatorReserve(trade);
        })();
        return { ok: false, error: 'Один из предметов уже продан или недоступен — трейд отменён' };
    }

    // Доплату от получателя (если это его сторона доплаты) списываем ЗДЕСЬ,
    // а не при создании трейда — до этого момента получатель ещё не соглашался
    // ни на что, и его баланс трогать нельзя. Если средств не хватает, трейд
    // остаётся pending — получатель может пополнить баланс и принять снова.
    if (trade.ton_payer === 'recipient' && trade.ton_amount > 0) {
        try {
            adjustBalance(trade.recipient_tg_id, -trade.ton_amount);
        } catch (e) {
            return { ok: false, error: `Не хватает баланса для доплаты ${trade.ton_amount} TON` };
        }
    }

    db.transaction(() => {
        for (const item of trade.initiatorItems) {
            transferListingToBuyer(item.id, trade.recipient_tg_id);
        }
        for (const item of trade.recipientItems) {
            transferListingToBuyer(item.id, trade.initiator_tg_id);
        }
        tradeStatements.setStatus.run('accepted', null, tradeId);

        // Доплата TON: сторона-плательщик уже рассчиталась (инициатор — при
        // создании трейда, получатель — чуть выше), теперь зачисляем деньги
        // получателю доплаты.
        if (trade.ton_amount > 0) {
            if (trade.ton_payer === 'initiator') {
                const payee = adjustBalance(trade.recipient_tg_id, trade.ton_amount);
                createTransaction({ tg_id: trade.recipient_tg_id, type: 'trade_topup_in', amount: trade.ton_amount });
                createTransaction({ tg_id: trade.initiator_tg_id, type: 'trade_topup_out', amount: -trade.ton_amount });
            } else if (trade.ton_payer === 'recipient') {
                adjustBalance(trade.initiator_tg_id, trade.ton_amount);
                createTransaction({ tg_id: trade.initiator_tg_id, type: 'trade_topup_in', amount: trade.ton_amount });
                createTransaction({ tg_id: trade.recipient_tg_id, type: 'trade_topup_out', amount: -trade.ton_amount });
            }
        }

        // Комиссия площадки: уже удержана с инициатора при создании трейда —
        // при успешном приёме она просто не возвращается (никакого движения
        // денег здесь больше не требуется).

        const logSide = (tgId, itemsGiven, itemsReceived) => {
            itemsGiven.forEach(gift => createTransaction({
                tg_id: tgId, type: 'trade_out', amount: 0, listing_id: gift.id,
                collection_name: gift.collection_name, collection_image: gift.collection_image,
                model_name: gift.model_name, model_image: gift.model_image,
                backdrop_name: gift.backdrop_name, backdrop_color: gift.backdrop_color,
                symbol_name: gift.symbol_name, symbol_icon: gift.symbol_icon,
                gift_number: gift.gift_number,
            }));
            itemsReceived.forEach(gift => createTransaction({
                tg_id: tgId, type: 'trade_in', amount: 0, listing_id: gift.id,
                collection_name: gift.collection_name, collection_image: gift.collection_image,
                model_name: gift.model_name, model_image: gift.model_image,
                backdrop_name: gift.backdrop_name, backdrop_color: gift.backdrop_color,
                symbol_name: gift.symbol_name, symbol_icon: gift.symbol_icon,
                gift_number: gift.gift_number,
            }));
        };
        logSide(trade.initiator_tg_id, trade.initiatorItems, trade.recipientItems);
        logSide(trade.recipient_tg_id, trade.recipientItems, trade.initiatorItems);
    })();

    return { ok: true, trade: getTradeWithItems(tradeId) };
}

/** Возвращает инициатору всё, что было у него зарезервировано при создании
 * трейда (комиссия + доплата, если доплачивал он) — используется при
 * decline/cancel/failed, когда трейд не состоялся. */
function refundInitiatorReserve(trade) {
    const refund = (trade.fee_amount || 0) + (trade.ton_payer === 'initiator' ? (trade.ton_amount || 0) : 0);
    if (refund > 1e-9) {
        adjustBalance(trade.initiator_tg_id, refund);
        createTransaction({ tg_id: trade.initiator_tg_id, type: 'trade_fee_refund', amount: refund });
    }
}

function declineTrade(tradeId, actingTgId) {
    const trade = getTradeWithItems(tradeId);
    if (!trade) return { ok: false, error: 'Трейд не найден' };
    if (trade.recipient_tg_id !== actingTgId) return { ok: false, error: 'Это не ваше предложение обмена' };
    if (trade.status !== 'pending') return { ok: false, error: 'Этот трейд уже закрыт' };

    db.transaction(() => {
        tradeStatements.setStatus.run('declined', null, tradeId);
        refundInitiatorReserve(trade);
    })();
    return { ok: true, trade: getTradeWithItems(tradeId) };
}

function cancelTrade(tradeId, actingTgId) {
    const trade = getTradeWithItems(tradeId);
    if (!trade) return { ok: false, error: 'Трейд не найден' };
    if (trade.initiator_tg_id !== actingTgId) return { ok: false, error: 'Это не ваш трейд' };
    if (trade.status !== 'pending') return { ok: false, error: 'Этот трейд уже закрыт' };

    db.transaction(() => {
        tradeStatements.setStatus.run('cancelled', null, tradeId);
        refundInitiatorReserve(trade);
    })();
    return { ok: true, trade: getTradeWithItems(tradeId) };
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
    transferListingToBuyer,
    returnListingToOwnerStorage,
    relistOwnedItem,
    listOwnedItemsForUser,
    createTransaction,
    listTransactionsForUser,
    createDeposit,
    getDepositById,
    getDepositByMemo,
    getDepositByTxHash,
    confirmDeposit,
    expireDeposit,
    createOrder,
    hasOwnMatchingListing,
    getOrderById,
    getOrderWithDetails,
    setOrderStatus,
    fillOrderOnce,
    listActiveOrdersForUser,
    listOrderHistoryForUser,
    listOrdersForCollection,
    findMatchingOrder,
    findMatchingOrdersForListing,
    findMatchingListingsForOrder,
    listOffersForUser,
    declineOfferAsSeller,
    searchUsersByUsername,
    listOwnedItemsForTgId,
    createTrade,
    getTradeById,
    getTradeWithItems,
    listIncomingTradesForUser,
    listMyTradesForUser,
    acceptTrade,
    declineTrade,
    cancelTrade,
};
