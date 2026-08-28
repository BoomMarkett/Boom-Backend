const Database = require('better-sqlite3');
const path = require('path');

// Файл базы данных лежит рядом с server.js — при первом запуске создастся сам
const db = new Database(path.join(__dirname, 'boommarket.db'));

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
            gm.name AS model_name, gm.image_url AS model_icon,
            gb.name AS backdrop_name, gb.color_hex AS backdrop_color,
            gs.name AS symbol_name, gs.icon_url AS symbol_icon
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
    setListingStatus,
    findListings,
};
