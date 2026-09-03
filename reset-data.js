/**
 * reset-data.js
 *
 * ОДНОРАЗОВЫЙ сброс всех пользовательских данных: баланс, Хранилище,
 * активные лоты на Маркете, ордера на покупку и трейды — обнуляются
 * или удаляются для ВСЕХ пользователей разом.
 *
 * НЕ трогает:
 *   - Каталог коллекций/моделей/фонов/символов (то, что заполняет
 *     seed-collections.js) — это общий справочник, не пользовательские данные.
 *   - Историю транзакций (просто отвязывается от удалённых лотов —
 *     сами данные о подарке в каждой строке уже продублированы, ничего
 *     не теряется).
 *   - Учётные записи пользователей (tg_id, имя, фото) — только их баланс.
 *
 * Запуск (важно — на том же окружении, где переменная DB_PATH указывает
 * на ту же базу, что использует сам сервер, иначе обнулите пустую
 * локальную копию вместо боевой):
 *   node reset-data.js
 *
 * Это разовая операция, не часть постоянного функционала приложения —
 * после использования файл можно удалить.
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'boommarket.db');
const db = new Database(dbPath);
console.log(`База данных: ${dbPath}`);

db.pragma('foreign_keys = ON');

const resetAll = db.transaction(() => {
    const usersCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const balanceSum = db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM users').get().s;
    const listingsCount = db.prepare('SELECT COUNT(*) AS n FROM listings').get().n;
    const ordersCount = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    const tradesCount = db.prepare('SELECT COUNT(*) AS n FROM trades').get().n;

    // 1. Баланс всех пользователей -> 0
    db.prepare('UPDATE users SET balance = 0').run();

    // 2. Историю транзакций не удаляем, но отвязываем от листингов, которые
    //    сейчас удалим (иначе нарушится внешний ключ transactions.listing_id).
    db.prepare('UPDATE transactions SET listing_id = NULL').run();

    // 3. Трейды и их айтемы
    db.prepare('DELETE FROM trade_items').run();
    db.prepare('DELETE FROM trades').run();

    // 4. Ордера на покупку (до листингов — есть внешний ключ matched_listing_id)
    db.prepare('DELETE FROM orders').run();

    // 5. Лоты — и активные (Маркет), и просто лежащие в "owned" (Хранилище)
    db.prepare('DELETE FROM listings').run();

    return { usersCount, balanceSum, listingsCount, ordersCount, tradesCount };
});

const stats = resetAll();

console.log('\nГотово. Сброшено:');
console.log(`  Пользователей: ${stats.usersCount} (баланс каждого -> 0)`);
console.log(`  Суммарный обнулённый баланс: ${stats.balanceSum.toFixed(2)} 💎`);
console.log(`  Удалено лотов (маркет + хранилище): ${stats.listingsCount}`);
console.log(`  Удалено ордеров: ${stats.ordersCount}`);
console.log(`  Удалено трейдов: ${stats.tradesCount}`);
console.log('\nИстория транзакций сохранена (не удалялась), каталог коллекций/трейтов не тронут.');

db.close();
