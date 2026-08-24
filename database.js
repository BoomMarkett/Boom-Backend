const Database = require('better-sqlite3');
const path = require('path');

// Файл базы данных лежит рядом с server.js — при первом запуске создастся сам
const db = new Database(path.join(__dirname, 'boommarket.db'));

// Небольшой прирост производительности и надёжности для SQLite
db.pragma('journal_mode = WAL');

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
`);

// === Подготовленные запросы (переиспользуются — быстрее, чем собирать SQL каждый раз) ===
const statements = {
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

/**
 * Найти пользователя по tg_id, либо создать нового, если его ещё нет.
 * Если пользователь уже существует — заодно обновляем его профиль
 * (имя/юзернейм/аватар могли поменяться в Telegram).
 */
function findOrCreateUser(tgUser) {
    const existing = statements.findByTgId.get(tgUser.id);

    const profile = {
        tg_id: tgUser.id,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        last_name: tgUser.last_name || null,
        photo_url: tgUser.photo_url || null,
    };

    if (existing) {
        statements.updateProfile.run(profile);
        return statements.findByTgId.get(tgUser.id);
    }

    statements.insertUser.run(profile);
    return statements.findByTgId.get(tgUser.id);
}

function getUserByTgId(tgId) {
    return statements.findByTgId.get(tgId);
}

function setBalance(tgId, newBalance) {
    statements.updateBalance.run(newBalance, tgId);
    return getUserByTgId(tgId);
}

/**
 * Изменить баланс на delta (может быть отрицательным).
 * Бросает ошибку, если после операции баланс ушёл бы в минус.
 */
function adjustBalance(tgId, delta) {
    const user = getUserByTgId(tgId);
    if (!user) throw new Error('Пользователь не найден');

    const newBalance = user.balance + delta;
    if (newBalance < 0) throw new Error('Недостаточно средств');

    return setBalance(tgId, newBalance);
}

module.exports = {
    db,
    findOrCreateUser,
    getUserByTgId,
    setBalance,
    adjustBalance,
};
