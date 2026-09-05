const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { TonClient, WalletContractV3R2, WalletContractV4, WalletContractV5R1, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { Address, toNano } = require('@ton/core');
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
    createDeposit,
    getDepositById,
    getDepositByMemo,
    getDepositByTxHash,
    confirmDeposit,
    expireDeposit,
    createOrder,
    getOrderById,
    getOrderWithDetails,
    setOrderStatus,
    fillOrderOnce,
    listActiveOrdersForUser,
    listOrderHistoryForUser,
    listOrdersForCollection,
    findMatchingOrder,
    findMatchingListingsForOrder,
    listOffersForUser,
    declineOfferAsSeller,
    searchUsersByUsername,
    listOwnedItemsForTgId,
    createTrade,
    getTradeWithItems,
    listIncomingTradesForUser,
    listMyTradesForUser,
    acceptTrade,
    declineTrade,
    cancelTrade,
    upsertModel,
    upsertBackdrop,
    upsertSymbol,
    findOrCreateCollectionByName,
    saveBusinessConnection,
    getActiveBusinessConnection,
    isGiftAlreadyDeposited,
    recordGiftDeposit,
    getGiftDepositByListingId,
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

// === Реальные TON-пополнения ===
// TON_DEPOSIT_ADDRESS — адрес кошелька площадки, куда пользователи реально
// присылают TON при пополнении (см. /api/deposit/init и /api/deposit/:id/status
// ниже). TONAPI_KEY — тот же ключ TonAPI, что и в scripts/seed-collections.js,
// без него запросы тоже работают, но с более строгим лимитом в минуту.
const TON_DEPOSIT_ADDRESS = process.env.TON_DEPOSIT_ADDRESS || '';
const TONAPI_KEY = process.env.TONAPI_KEY || '';
const TONAPI_BASE = 'https://tonapi.io/v2';

if (!TON_DEPOSIT_ADDRESS) {
    console.warn('⚠️  TON_DEPOSIT_ADDRESS не задан — реальное пополнение будет недоступно!');
}

// === Реальные TON-выводы ===
// TON_WITHDRAW_MNEMONIC — 24 слова мнемоники "горячего" кошелька площадки,
// с которого реально уходят выводы (см. /api/withdraw ниже). Обычно это тот
// же кошелёк, что принимает депозиты (TON_DEPOSIT_ADDRESS) — тогда все TON
// пользователей крутятся на одном балансе. TONCENTER_API_KEY — ключ
// toncenter.com (бесплатно у @tonapibot в Telegram), поднимает лимит запросов;
// без ключа тоже работает, но легко словить 429 при активном использовании.
const TON_WITHDRAW_MNEMONIC = process.env.TON_WITHDRAW_MNEMONIC || '';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
const TONCENTER_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC';

if (!TON_WITHDRAW_MNEMONIC) {
    console.warn('⚠️  TON_WITHDRAW_MNEMONIC не задан — реальный вывод TON будет недоступен!');
}

// TON_WITHDRAW_WALLET_VERSION — необязательный РУЧНОЙ override версии
// контракта кошелька выплат ('v3r2' | 'v4' | 'v5r1'), если понадобится
// принудительно указать версию. Обычно не нужен — см. detectHotWalletVersion
// ниже: сервер сам определяет версию, проверяя в блокчейне, какой из
// адресов (посчитанных из той же мнемоники под разные версии) реально
// задеплоен/имеет баланс, поскольку из ОДНОЙ сид-фразы разные версии
// кошелька дают РАЗНЫЕ адреса.
const TON_WITHDRAW_WALLET_VERSION = (process.env.TON_WITHDRAW_WALLET_VERSION || '').toLowerCase();

const WALLET_VERSION_CANDIDATES = [
    ['v3r2', WalletContractV3R2],
    ['v4', WalletContractV4],
    ['v5r1', WalletContractV5R1],
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Проверяет в блокчейне для каждой версии кошелька: задеплоен ли адрес
// (т.е. хоть раз отправлял транзакцию) и какой у него баланс. Так можно
// понять, какой версией реально пользуется владелец сид-фразы, не спрашивая
// его каждый раз вручную. Небольшая пауза между запросами — иначе анонимный
// (без TONCENTER_API_KEY) лимит TonCenter легко словить всего на 6 запросах
// подряд (429 Too Many Requests).
async function detectHotWalletVersion(client, publicKey) {
    const infos = [];
    for (const [label, WalletClass] of WALLET_VERSION_CANDIDATES) {
        let address = null;
        let deployed = false;
        let balanceNano = 0n;
        try {
            address = WalletClass.create({ workchain: 0, publicKey }).address;
            try { deployed = await client.isContractDeployed(address); } catch (e) { /* сеть могла моргнуть — не критично */ }
            await sleep(350);
            try { balanceNano = await client.getBalance(address); } catch (e) { /* аналогично */ }
            await sleep(350);
        } catch (e) {
            // Эта версия вообще не смогла вычислить адрес — пропускаем.
        }
        infos.push({ label, WalletClass, address, deployed, balanceNano });
    }
    return infos;
}

// Кошелёк поднимается лениво и один раз на весь процесс (создание TonClient +
// разбор мнемоники не бесплатны, а withdraw дёргается часто).
let hotWalletPromise = null;
function getHotWallet() {
    if (!hotWalletPromise) {
        hotWalletPromise = (async () => {
            const keyPair = await mnemonicToPrivateKey(TON_WITHDRAW_MNEMONIC.trim().split(/\s+/));
            const client = new TonClient({
                endpoint: TONCENTER_ENDPOINT,
                apiKey: TONCENTER_API_KEY || undefined,
            });

            const infos = await detectHotWalletVersion(client, keyPair.publicKey);

            console.log('🔎 Автоопределение версии горячего кошелька для выводов (по данным блокчейна):');
            infos.forEach(info => {
                const addrStr = info.address ? info.address.toString({ bounceable: false }) : '— не вычислен';
                const balanceStr = info.address ? `${(Number(info.balanceNano) / 1e9).toFixed(4)} TON` : '';
                const deployedStr = info.address ? (info.deployed ? 'задеплоен' : 'не задеплоен') : '';
                console.log(`   ${info.label}: ${addrStr}  ${balanceStr}  ${deployedStr}`.trimEnd());
            });

            let chosen = null;

            // 1) Ручной override, если явно задан — имеет приоритет над автоопределением.
            if (TON_WITHDRAW_WALLET_VERSION) {
                chosen = infos.find(i => i.label === TON_WITHDRAW_WALLET_VERSION && i.address);
                if (chosen) console.log(`   → используется версия из TON_WITHDRAW_WALLET_VERSION: ${chosen.label}`);
            }

            // 2) Автовыбор: версия, чей адрес реально задеплоен в блокчейне —
            // это и есть тот кошелёк, которым владелец фактически пользуется.
            if (!chosen) {
                const deployedOnes = infos.filter(i => i.deployed);
                if (deployedOnes.length === 1) {
                    chosen = deployedOnes[0];
                    console.log(`   → автоматически выбрана версия: ${chosen.label} (единственная задеплоенная в сети)`);
                } else if (deployedOnes.length > 1) {
                    // Редкий случай — несколько версий когда-либо использовались.
                    // Берём с наибольшим текущим балансом как наиболее вероятную "рабочую".
                    chosen = deployedOnes.reduce((a, b) => (a.balanceNano > b.balanceNano ? a : b));
                    console.log(`   ⚠️  Задеплоено сразу несколько версий — выбрана с наибольшим балансом: ${chosen.label}. Если это не та, задайте TON_WITHDRAW_WALLET_VERSION вручную.`);
                }
            }

            // 3) Ни одна версия ещё не задеплоена (свежесозданный кошелёк), но на
            // одной из них уже есть баланс — значит именно её вы и планируете
            // использовать (просто ещё ни разу не отправляли с неё перевод).
            if (!chosen) {
                const funded = infos.filter(i => i.balanceNano > 0n);
                if (funded.length === 1) {
                    chosen = funded[0];
                    console.log(`   → автоматически выбрана версия: ${chosen.label} (единственная с ненулевым балансом)`);
                } else if (funded.length > 1) {
                    chosen = funded.reduce((a, b) => (a.balanceNano > b.balanceNano ? a : b));
                    console.log(`   ⚠️  Баланс есть сразу на нескольких версиях — выбрана с наибольшим: ${chosen.label}. Если это не та, задайте TON_WITHDRAW_WALLET_VERSION вручную.`);
                }
            }

            // 4) Совсем ничего не удалось определить (кошелёк пуст и ни разу не
            // использовался) — используем v4 по умолчанию и явно предупреждаем,
            // чтобы не было тихой ошибки "перевёл, а деньги ушли не туда".
            if (!chosen) {
                chosen = infos.find(i => i.label === 'v4' && i.address) || infos.find(i => i.address);
                console.log(`   ⚠️  Не удалось определить версию автоматически (кошелёк ещё пуст/не задеплоен) — используется версия по умолчанию: ${chosen ? chosen.label : '?'}. Пополните нужный адрес из списка выше и перезапустите сервер, либо задайте TON_WITHDRAW_WALLET_VERSION вручную.`);
            }

            const wallet = chosen.WalletClass.create({ workchain: 0, publicKey: keyPair.publicKey });
            const contract = client.open(wallet);
            // Печатаем итоговый выбор один раз при первом использовании — без
            // этого невозможно проверить в эксплорере (tonviewer.com/tonscan.org),
            // есть ли на нём вообще TON для покрытия выводов и комиссии сети.
            console.log(`💼 Горячий кошелёк для выводов (версия ${chosen.label}): ${wallet.address.toString({ bounceable: false })}`);
            return { client, contract, keyPair, address: wallet.address };
        })().catch((e) => {
            // Если инициализация (разбор мнемоники и т.п.) провалилась — не
            // кэшируем сломанный промис навсегда, иначе КАЖДЫЙ следующий вывод
            // будет падать с той же ошибкой без единого шанса на повтор после
            // исправления переменных окружения.
            hotWalletPromise = null;
            throw e;
        });
    }
    return hotWalletPromise;
}

/**
 * Подписывает и реально отправляет TON с горячего кошелька площадки на
 * адрес пользователя. Ждём роста seqno кошелька как подтверждения, что
 * сеть приняла транзакцию — сама транзакция уже не отменяется на этом
 * этапе, а точный час её попадания в блок для UX не критичен.
 */
async function sendTonWithdrawal(toAddress, amountTon, commentText) {
    const { client, contract, keyPair, address } = await getHotWallet();

    // Проверяем баланс горячего кошелька ДО отправки — иначе при нехватке
    // TON транзакция просто не подтвердится в сети, и мы 40 секунд впустую
    // прождём таймаут ("Транзакция отправлена, но подтверждение не пришло
    // вовремя"), вместо понятной причины сразу.
    const walletBalanceNano = await client.getBalance(address);
    const requiredNano = toNano(amountTon.toFixed(9)) + toNano('0.05'); // + запас на комиссию сети
    if (walletBalanceNano < requiredNano) {
        throw new Error(
            `На горячем кошельке площадки недостаточно TON для вывода (нужно ~${amountTon} + комиссия, ` +
            `на кошельке ${(Number(walletBalanceNano) / 1e9).toFixed(4)} TON) — пополните горячий кошелёк`
        );
    }

    const seqnoBefore = await contract.getSeqno();

    await contract.sendTransfer({
        seqno: seqnoBefore,
        secretKey: keyPair.secretKey,
        messages: [
            internal({
                to: toAddress,
                value: toNano(amountTon.toFixed(9)),
                body: commentText || '',
                bounce: false,
            }),
        ],
    });

    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const seqnoNow = await contract.getSeqno();
        if (seqnoNow > seqnoBefore) return;
    }

    throw new Error('Транзакция отправлена, но подтверждение не пришло вовремя');
}

/** "Chill Flame #433898" — как называют подарок в самом Telegram. */
function giftDisplayName(details) {
    const name = details.model_name || details.collection_name || 'Подарок';
    return details.gift_number ? `${name} #${details.gift_number}` : name;
}

const TOKEN_LIFETIME = '24h';

// =====================================================================
// УВЕДОМЛЕНИЯ В TELEGRAM (через Bot API — тот же BOT_TOKEN, что и для
// проверки initData). Отправляем при продаже подарка, новых офферах на
// свой лот и трейдах — с картинкой подарка и кнопкой "Открыть BoomMarket".
// Бот может писать пользователю, только если тот уже открывал бота (это
// условие обычно уже выполнено — авторизация в Mini App идёт через него).
// =====================================================================
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Публичный юзернейм личного аккаунта, подключённого как Telegram Business
// (см. блок "ПРИЁМ ПОДАРКОВ-NFT" ниже) — именно ему пользователи реально
// присылают NFT-подарки, чтобы они зачислились в Хранилище. Используется
// только для ссылки "Открыть чат" в модалке депозита на фронте, ничего
// секретного тут нет — юзернейм и так виден всем в самом Telegram.
const BUSINESS_ACCOUNT_USERNAME = process.env.BUSINESS_ACCOUNT_USERNAME || '';
if (!BUSINESS_ACCOUNT_USERNAME) {
    console.warn('⚠️  BUSINESS_ACCOUNT_USERNAME не задан — кнопка "Добавить NFT" не сможет открыть чат для отправки подарка!');
}

app.get('/api/deposit-nft-info', (req, res) => {
    res.json({ ok: true, username: BUSINESS_ACCOUNT_USERNAME });
});
// URL мини-приложения — тот же, что в tonconnect-manifest.json.
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://holdenholden72-dotcom.github.io/BoomMarket/';

/**
 * Отправляет пользователю уведомление в бота: с картинкой подарка (если
 * есть photoUrl) или просто текстом, плюс кнопка "Открыть BoomMarket".
 * Никогда не бросает исключение наружу — сбой уведомления не должен
 * ломать основной запрос (продажу/трейд/оффер), только логируется.
 */
async function notifyTelegram(tgId, text, photoUrl) {
    if (!BOT_TOKEN || !tgId) return;

    const replyMarkup = {
        inline_keyboard: [[
            { text: '🚀 Открыть BoomMarket', web_app: { url: MINI_APP_URL } },
        ]],
    };

    try {
        const method = photoUrl ? 'sendPhoto' : 'sendMessage';
        const body = photoUrl
            ? { chat_id: tgId, photo: photoUrl, caption: text, parse_mode: 'HTML', reply_markup: replyMarkup }
            : { chat_id: tgId, text, parse_mode: 'HTML', reply_markup: replyMarkup };

        const res = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`⚠️  Не удалось отправить Telegram-уведомление пользователю ${tgId}:`, errText);
        }
    } catch (e) {
        console.error(`⚠️  Ошибка отправки Telegram-уведомления пользователю ${tgId}:`, e.message);
    }
}

// =====================================================================
// ПРИЁМ ПОДАРКОВ-NFT ИЗ TELEGRAM (Business API)
//
// Личный Telegram-аккаунт, на который люди присылают подарки, подключён
// как Telegram Business с этим ботом (Settings → Telegram Business →
// Chatbots), боту выдано право "Просмотр подарков и звёзд"
// (can_view_gifts_and_stars). Когда кто-то дарит подарок этому аккаунту,
// в чате с отправителем появляется служебное сообщение — Telegram доставляет
// его боту как апдейт update.business_message, точно так же, как обычное
// сообщение в подключённом чате.
//
// ВАЖНО: чтобы это вообще заработало, у бота должен быть настроен вебхук
// (setWebhook на этот URL) — без него апдейты не придут ни через getUpdates
// по умолчанию (business-апдейты идут только туда, куда подписались), ни
// тем более сюда. Секрет (TELEGRAM_WEBHOOK_SECRET) сверяется с заголовком
// X-Telegram-Bot-Api-Secret-Token — так сюда не сможет достучаться никто,
// кроме самого Telegram.
// =====================================================================
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

app.post('/api/telegram/webhook', async (req, res) => {
    // Секрет ОБЯЗАТЕЛЕН: без него любой в интернете мог бы слать сюда
    // поддельные апдейты и зачислять себе чужие подарки. Раньше при
    // отсутствии TELEGRAM_WEBHOOK_SECRET проверка просто пропускалась
    // (fail-open) — это позволяло полностью анонимно накручивать себе
    // фейковые депозиты подарков. Теперь при отсутствии/неверном секрете
    // эндпоинт всегда отказывает (fail-closed), а не тихо деградирует.
    if (!TELEGRAM_WEBHOOK_SECRET) {
        console.error('⛔ TELEGRAM_WEBHOOK_SECRET не задан — вебхук отклоняет ВСЕ запросы, пока секрет не настроен.');
        return res.sendStatus(500);
    }

    const gotSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (!isSecretMatch(gotSecret, TELEGRAM_WEBHOOK_SECRET)) {
        return res.sendStatus(401);
    }

    // Telegram не ждёт от нас содержательного ответа и не разбирает тело —
    // важно только быстро ответить 200, иначе он будет повторять апдейт.
    // Всю обработку делаем уже после отправки ответа.
    res.sendStatus(200);

    try {
        await handleTelegramUpdate(req.body);
    } catch (e) {
        console.error('⚠️  Ошибка обработки Telegram-апдейта:', e);
    }
});

async function handleTelegramUpdate(update) {
    if (!update) return;

    // Бот подключили/отключили/переподключили к Business-аккаунту —
    // запоминаем connection_id (пригодится позже для вывода подарков обратно
    // через transferGift) и сам факт подключения.
    if (update.business_connection) {
        const conn = update.business_connection;
        saveBusinessConnection(conn.id, conn.user && conn.user.id, conn.is_enabled);
        console.log(`ℹ️  Business-подключение обновлено: ${conn.id}, аккаунт ${conn.user?.id}, включено: ${conn.is_enabled}`);
        return;
    }

    // Новое сообщение в чате, куда подключён business-бот. Нас интересует
    // только случай "кто-то подарил NFT-подарок этому аккаунту".
    const message = update.business_message;
    if (!message || !message.unique_gift) return;

    await creditIncomingGift(message);
}

/**
 * Заводит депонированный подарок в инвентарь ("Хранилище") приславшего
 * его пользователя. Идемпотентно — по owned_gift_id: при повторной
 * доставке того же апдейта Telegram (это штатное поведение вебхуков)
 * подарок не зачислится дважды.
 */
async function creditIncomingGift(message) {
    const sender = message.from;
    const giftInfo = message.unique_gift; // UniqueGiftInfo
    const gift = giftInfo.gift; // UniqueGift: base_name, name, number, model, symbol, backdrop

    if (!sender || !gift) return;

    // owned_gift_id есть только у сообщений, которые Telegram доставляет
    // именно управляемому business-аккаунту — то, что нам и нужно. Если
    // его нет, значит это сообщение не про "нам подарили", пропускаем.
    const ownedGiftId = giftInfo.owned_gift_id || gift.name;
    if (isGiftAlreadyDeposited(ownedGiftId)) {
        console.log(`ℹ️  Подарок ${ownedGiftId} уже был зачислен ранее, пропускаю повтор.`);
        return;
    }

    // Коллекция матчится по названию (base_name) — TON-адреса тут нет,
    // Telegram отдаёт только человекочитаемое имя. Если такой коллекции
    // ещё нет в каталоге — заводим новую (без ton_address).
    const collection = findOrCreateCollectionByName(gift.base_name, null);

    const modelId = upsertModel(
        collection.id,
        gift.model?.name || 'Unknown',
        gift.model?.rarity_per_mille ?? null,
        null
    );
    const backdropId = upsertBackdrop(
        collection.id,
        gift.backdrop?.name || 'Unknown',
        gift.backdrop?.colors?.center_color
            ? `#${gift.backdrop.colors.center_color.toString(16).padStart(6, '0')}`
            : null,
        gift.backdrop?.rarity_per_mille ?? null,
        null
    );
    const symbolId = upsertSymbol(
        collection.id,
        gift.symbol?.name || 'Unknown',
        null,
        gift.symbol?.rarity_per_mille ?? null
    );

    const depositUser = findOrCreateUser({
        id: sender.id,
        username: sender.username,
        first_name: sender.first_name,
        last_name: sender.last_name,
    });

    const listing = createListing({
        owner_tg_id: depositUser.tg_id,
        collection_id: collection.id,
        model_id: modelId,
        backdrop_id: backdropId,
        symbol_id: symbolId,
        gift_number: gift.number,
        nft_address: null, // Telegram не отдаёт TON-адрес самого NFT-айтема
        price: 0,
        status: 'owned',
    });

    recordGiftDeposit(ownedGiftId, depositUser.tg_id, listing.id);

    console.log(`✅ Зачислен подарок "${gift.base_name} #${gift.number}" пользователю ${depositUser.tg_id}`);

    await notifyTelegram(
        depositUser.tg_id,
        `🎁 Ваш подарок <b>${gift.base_name} #${gift.number}</b> зачислен в Хранилище BoomMarket!`
    );
}

// Проверяет, что сумма — число в заданном диапазоне с не более чем одним
// знаком после запятой (0.2, 1.4, 10.7, 10 — можно; 1.76, 9.87 — нельзя).
function isValidAmount(amount, min = 0.1, max = 100000) {
    if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) return false;
    if (amount < min || amount > max) return false;
    const tenths = Math.round(amount * 10);
    return Math.abs(tenths - amount * 10) < 1e-6;
}

// Сравнение секретов постоянным временем — обычное === "утекает" через
// время выполнения (сколько символов совпало до первого расхождения),
// что теоретически позволяет подобрать секрет по времени ответа. Здесь
// это не бог весть какой большой риск (секрет длинный и меняется редко),
// но раз уж переписываем проверку вебхука — сделаем как положено.
function isSecretMatch(received, expected) {
    if (typeof received !== 'string' || !expected) return false;
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    // timingSafeEqual требует буферы одинаковой длины — иначе сам бросит
    // исключение, а разная длина уже сама по себе "не совпало".
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
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
// =====================================================================
// РЕАЛЬНОЕ ПОПОЛНЕНИЕ БАЛАНСА (настоящий TON, не виртуальные циферки)
// =====================================================================
//
// Схема (классический паттерн "оплата по уникальному комментарию"):
//   1. Клиент вызывает /api/deposit/init — сервер создаёт заявку на депозит
//      с уникальным memo (например "BM-7F3K9QXZ") и возвращает адрес
//      кошелька площадки, куда нужно отправить TON.
//   2. Клиент через TonConnect отправляет реальную транзакцию с этого
//      адреса на TON_DEPOSIT_ADDRESS, приложив memo как текстовый комментарий.
//   3. Клиент опрашивает /api/deposit/:id/status — сервер спрашивает у TonAPI
//      последние входящие переводы на кошелёк площадки и ищет среди них
//      перевод с таким же комментарием и суммой не меньше ожидаемой.
//      Как только находит — начисляет баланс и помечает заявку 'confirmed'.
//
// Это НЕ enterprise-grade платёжный процессор (нет вебхуков, нет учёта
// глубины подтверждения блока), а простое и рабочее решение для маркета
// такого масштаба — TonAPI отдаёт транзакцию в /events практически сразу
// после появления в блоке.
function generateDepositMemo() {
    // Без символов, которые легко перепутать при ручном вводе (0/O, 1/I).
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return `BM-${code}`;
}

const DEPOSIT_EXPIRY_MINUTES = 45;
const DEPOSIT_AMOUNT_TOLERANCE_TON = 0.001; // допуск на погрешность округления при сверке сумм

// === Создать заявку на пополнение — возвращает адрес и memo, которые нужно
// передать в TonConnect-транзакцию на клиенте ===
app.post('/api/deposit/init', requireAuth, (req, res) => {
    if (!TON_DEPOSIT_ADDRESS) {
        return res.status(503).json({ ok: false, error: 'Пополнение временно недоступно — обратитесь в поддержку' });
    }

    const amount = parseFloat(req.body.amount);
    if (!isValidAmount(amount, 0.1, 100000)) {
        return res.status(400).json({ ok: false, error: 'Сумма должна быть от 0.1 до 100000, максимум с одним знаком после запятой' });
    }

    let memo = generateDepositMemo();
    for (let attempt = 0; attempt < 5 && getDepositByMemo(memo); attempt++) {
        memo = generateDepositMemo();
    }

    const deposit = createDeposit(req.tgId, amount, memo);

    res.json({
        ok: true,
        depositId: deposit.id,
        memo: deposit.memo,
        amount: deposit.amount,
        address: TON_DEPOSIT_ADDRESS,
    });
});

// Достаёт последние события кошелька площадки через TonAPI и ищет среди
// входящих TON-переводов тот, что подходит по memo (точное совпадение
// комментария) и по сумме (с небольшим допуском на округление).
async function findTonDepositTransfer(memo, expectedAmount) {
    const url = `${TONAPI_BASE}/accounts/${TON_DEPOSIT_ADDRESS}/events?limit=30`;
    const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`TonAPI вернул ${res.status}`);
    const data = await res.json();

    for (const event of data.events || []) {
        for (const action of event.actions || []) {
            if (action.type !== 'TonTransfer' || action.status !== 'ok') continue;
            const transfer = action.TonTransfer;
            const comment = transfer?.comment?.trim();
            if (!comment || comment !== memo) continue;

            const receivedTon = Number(transfer.amount) / 1e9;
            if (receivedTon + DEPOSIT_AMOUNT_TOLERANCE_TON < expectedAmount) continue;

            return { txHash: event.event_id || null, receivedTon };
        }
    }
    return null;
}

// === Проверить статус заявки на пополнение — клиент опрашивает этот
// эндпоинт после отправки транзакции, пока не получит 'confirmed' ===
app.get('/api/deposit/:id/status', requireAuth, async (req, res) => {
    const deposit = getDepositById(parseInt(req.params.id, 10));
    if (!deposit || deposit.tg_id !== req.tgId) {
        return res.status(404).json({ ok: false, error: 'Заявка на пополнение не найдена' });
    }

    if (deposit.status !== 'pending') {
        const user = getUserByTgId(req.tgId);
        return res.json({ ok: true, status: deposit.status, balance: user.balance });
    }

    const ageMinutes = (Date.now() - new Date(`${deposit.created_at}Z`).getTime()) / 60000;
    if (ageMinutes > DEPOSIT_EXPIRY_MINUTES) {
        expireDeposit(deposit.id);
        return res.json({ ok: true, status: 'expired' });
    }

    try {
        const match = await findTonDepositTransfer(deposit.memo, deposit.amount);
        if (!match) {
            return res.json({ ok: true, status: 'pending' });
        }
        if (match.txHash && getDepositByTxHash(match.txHash)) {
            // Эта транзакция уже была засчитана за другой депозит — не начисляем повторно.
            return res.json({ ok: true, status: 'pending' });
        }

        confirmDeposit(deposit.id, match.txHash || `memo:${deposit.memo}:${Date.now()}`);
        const user = adjustBalance(req.tgId, deposit.amount);
        createTransaction({ tg_id: req.tgId, type: 'deposit', amount: deposit.amount });

        res.json({ ok: true, status: 'confirmed', balance: user.balance });
    } catch (e) {
        console.error('Ошибка проверки пополнения через TonAPI:', e);
        // Не показываем пользователю техническую ошибку — просто продолжаем поллинг.
        res.json({ ok: true, status: 'pending' });
    }
});

// === Вывод средств (реальный перевод TON на кошелёк пользователя) ===
app.post('/api/withdraw', requireAuth, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    const addressRaw = String(req.body.address || '').trim();

    if (!isValidAmount(amount, 0.5, 100000)) {
        return res.status(400).json({ ok: false, error: 'Сумма должна быть от 0.5 до 100000, максимум с одним знаком после запятой' });
    }
    if (!addressRaw) {
        return res.status(400).json({ ok: false, error: 'Подключите кошелёк для вывода' });
    }
    if (!TON_WITHDRAW_MNEMONIC) {
        return res.status(503).json({ ok: false, error: 'Вывод временно недоступен, попробуйте позже' });
    }

    let toAddress;
    try {
        toAddress = Address.parse(addressRaw);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Некорректный адрес кошелька' });
    }

    // Списываем баланс СРАЗУ, до отправки на блокчейн — иначе повторный
    // запрос, отправленный за секунду до первого ответа, мог бы списать
    // ту же сумму дважды. Если сама отправка ниже провалится — вернём
    // деньги обратно на баланс.
    let user;
    try {
        user = adjustBalance(req.tgId, -amount);
    } catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
    }

    try {
        await sendTonWithdrawal(toAddress, amount, 'BoomMarket withdraw');
        createTransaction({ tg_id: req.tgId, type: 'withdraw', amount: -amount });
        res.json({ ok: true, balance: user.balance });
    } catch (e) {
        console.error(`⚠️  Ошибка вывода TON пользователю ${req.tgId} (сумма ${amount}, адрес ${addressRaw}):`, e.message);
        console.error(e.stack);
        const restored = adjustBalance(req.tgId, amount);
        res.status(500).json({
            ok: false,
            error: 'Не удалось отправить перевод, средства возвращены на баланс',
            balance: restored.balance,
        });
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
    const { collectionId, model, backdrop, symbol, search, sort, ownerTgId } = req.query;

    const listings = findListings({
        collectionId: parseCsvIntParam(collectionId),
        modelName: parseCsvParam(model),
        backdropName: parseCsvParam(backdrop),
        symbolName: parseCsvParam(symbol),
        search: search || undefined,
        sort: sort || undefined,
        // "Мои лоты" на Маркете — фильтр по владельцу, без отдельной авторизации:
        // ownerTgId приходит от фронта (currentTgId уже известен клиенту из
        // Telegram initData), сам список остаётся публичным, как и раньше.
        ownerTgId: ownerTgId ? parseInt(ownerTgId, 10) : undefined,
    });

    res.json({ ok: true, listings });
});

// Комиссия маркетплейса — удерживается с продавца при продаже (из выручки),
// покупатель платит ровно ту цену, что указана в лоте, без наценки.
const MARKETPLACE_FEE_PERCENT = 1.5;

// NB: раньше здесь был POST /api/listings — эндпоинт "выставить лот",
// который создавал лот прямо из того, что прислал клиент (collectionId,
// modelId, giftNumber и т.д.), БЕЗ проверки, что у пользователя вообще
// есть такой подарок. Любой мог заминтить себе фейковый лот любой
// "редкости" и продать его за настоящий TON. Фронтенд его больше не
// вызывает (продажа теперь идёт только через переиспользование уже
// зачисленного подарка — см. /api/listings/:id/relist ниже, там владение
// проверяется), поэтому эндпоинт просто убран целиком, а не починен.
// в Хранилище просто по введённым вручную названиям (без всякой проверки
// владения). Это позволяло любому нарисовать себе сколько угодно "подарков"
// и тут же продать их за реальный TON — критическая дыра. Единственный
// настоящий способ зачисления NFT теперь — раздел "ПРИЁМ ПОДАРКОВ-NFT"
// ниже (реальный подарок в Telegram → вебхук → creditIncomingGift).

// =====================================================================
// ВЫВОД ПОДАРКА-NFT ОБРАТНО В TELEGRAM (Business API)
//
// Зеркально приёму: подарок физически "лежит" на business-аккаунте, пока
// он у пользователя в Хранилище. При выводе просим Telegram передать
// именно этот экземпляр (по owned_gift_id, сохранённому при депозите)
// обратно на аккаунт владельца через transferGift.
// =====================================================================

/**
 * Ищет конкретный подарок по owned_gift_id среди подарков business-аккаунта,
 * постранично перебирая getBusinessAccountGifts — нужен главным образом
 * ради поля transfer_star_count (сколько Stars спишется за перевод, если
 * перевод платный; для большинства подарков это 0 — бесплатно).
 * Ищет не более MAX_PAGES страниц, чтобы не уйти в бесконечный цикл, если
 * подарок почему-то не найдётся (например, был выведен вручную из Telegram).
 */
async function findOwnedGiftById(businessConnectionId, ownedGiftId) {
    const MAX_PAGES = 20;
    let offset = '';

    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetch(`${TELEGRAM_API_BASE}/getBusinessAccountGifts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                business_connection_id: businessConnectionId,
                exclude_unique: false,
                exclude_from_blockchain: false,
                offset,
                limit: 100,
            }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.description || 'getBusinessAccountGifts failed');

        const found = (data.result.gifts || []).find(g => g.owned_gift_id === ownedGiftId);
        if (found) return found;

        if (!data.result.next_offset) break;
        offset = data.result.next_offset;
    }

    return null;
}

app.post('/api/inventory/:id/withdraw-gift', requireAuth, async (req, res) => {
    const listing = getListingWithDetails(req.params.id);

    if (!listing || listing.owner_tg_id !== req.tgId) {
        return res.status(404).json({ ok: false, error: 'Подарок не найден' });
    }
    if (listing.status !== 'owned') {
        return res.status(400).json({ ok: false, error: 'Подарок сейчас выставлен на продажу или уже недоступен' });
    }

    const deposit = getGiftDepositByListingId(listing.id);
    if (!deposit) {
        return res.status(400).json({
            ok: false,
            error: 'Этот подарок был добавлен не через депозит из Telegram — автоматический вывод для него недоступен',
        });
    }

    const connection = getActiveBusinessConnection();
    if (!connection) {
        return res.status(503).json({ ok: false, error: 'Приём/вывод подарков сейчас не настроен, попробуйте позже' });
    }

    try {
        // Узнаём точную стоимость перевода в Stars (обычно 0 — бесплатно).
        const giftOnAccount = await findOwnedGiftById(connection.connection_id, deposit.owned_gift_id);
        const starCount = giftOnAccount?.transfer_star_count || 0;

        if (giftOnAccount && giftOnAccount.can_be_transferred === false) {
            return res.status(400).json({ ok: false, error: 'Telegram временно запрещает передачу этого подарка, попробуйте позже' });
        }

        const transferRes = await fetch(`${TELEGRAM_API_BASE}/transferGift`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                business_connection_id: connection.connection_id,
                owned_gift_id: deposit.owned_gift_id,
                new_owner_chat_id: req.tgId,
                star_count: starCount,
            }),
        });
        const transferData = await transferRes.json();

        if (!transferData.ok) {
            console.error('⚠️  transferGift не удался:', transferData.description);
            // Самая частая причина — получатель не был активен в Telegram
            // последние 24 часа (требование самого Telegram).
            return res.status(400).json({
                ok: false,
                error: transferData.description?.includes('CHAT_ADMIN_REQUIRED') || transferData.description?.includes('USER_')
                    ? 'Не удалось передать подарок — откройте Telegram и повторите попытку через минуту'
                    : (transferData.description || 'Не удалось передать подарок'),
            });
        }

        setListingStatus(listing.id, 'withdrawn');
        createTransaction({
            tg_id: req.tgId,
            type: 'withdraw_gift',
            amount: 0,
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
        });

        res.json({ ok: true });
    } catch (e) {
        console.error('⚠️  Ошибка вывода подарка:', e);
        res.status(500).json({ ok: false, error: 'Техническая ошибка при выводе, попробуйте позже' });
    }
});

// =====================================================================
// ИГРА "СЛОТЫ"
// =====================================================================

// Комиссия с выигрыша — удерживается со всех игр в разделе казино
// (слоты, рулетка, бомбер, башня, кости, плинко). Считается от суммы
// выигрыша (не от ставки и не при проигрыше), округляется до копеек так же,
// как и сам выигрыш.
const GAME_WIN_FEE_PERCENT = 0.01;

function applyGameWinFee(rawWinAmount) {
    if (!rawWinAmount) return rawWinAmount;
    return Math.round(rawWinAmount * (1 - GAME_WIN_FEE_PERCENT / 100) * 100) / 100;
}

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
    const winAmount = isWin ? applyGameWinFee(Math.round(bet * multiplier * 100) / 100) : 0;

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
    const winAmount = isWin ? applyGameWinFee(Math.round(bet * segment.multiplier * 100) / 100) : 0;

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
        const winAmount = applyGameWinFee(Math.round(game.bet * multiplier * 100) / 100);
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
    const winAmount = applyGameWinFee(Math.round(game.bet * multiplier * 100) / 100);
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
// ИГРА "БАШНЯ" (Tower) — подъём по этажам, на каждом свой шанс
// =====================================================================
//
// Правила:
//   - Башня состоит из 5 этажей с ФИКСИРОВАННОЙ конфигурацией — на каждом
//     этаже своё количество плиток и ловушек (чем выше этаж, тем меньше
//     плиток, но и множитель на нём круче):
//       • Этаж 1 — 6 плиток, 2 ловушки (шанс пройти этаж 4/6 ≈ 67%)
//       • Этаж 2 — 5 плиток, 3 ловушки (шанс пройти этаж 2/5 = 40%)
//       • Этаж 3 — 4 плитки, 2 ловушки (шанс пройти этаж 2/4 = 50%)
//       • Этаж 4 — 3 плитки, 2 ловушки (шанс пройти этаж 1/3 ≈ 33%)
//       • Этаж 5 — 2 плитки, 1 ловушка (шанс пройти этаж 1/2 = 50%)
//   - На каждом этаже ловушки расставляются случайно и хранятся ТОЛЬКО
//     на сервере — клиент не знает, где они, пока не наступит на плитку
//     или не проиграет.
//   - Игрок выбирает одну плитку на текущем (нижнем непройденном) этаже.
//     Если плитка безопасна — игрок поднимается на этаж выше, множитель
//     выигрыша растёт. Чем выше поднялся — тем больше множитель и риск.
//   - В любой момент после подъёма хотя бы на один этаж можно нажать
//     «Забрать выигрыш» (Cashout) — ставка × текущий множитель
//     зачисляется на баланс.
//   - Если выбрана плитка с ловушкой — раунд проигран, ставка сгорает.
//   - Если пройдены ВСЕ этажи (достигнута вершина башни) — выигрыш
//     засчитывается автоматически по максимальному множителю раунда.
//
// Каждый этаж — независимое испытание (ловушки каждого этажа выбираются
// заново, вне зависимости от других этажей). Множитель за каждый этаж
// задан явно (не считается по формуле от количества плиток/ловушек) —
// значения кумулятивные, то есть это итоговый множитель ставки при
// кэшауте именно на этом этаже.
const TOWER_FLOOR_CONFIG = [
    { tiles: 6, traps: 2, multiplier: 1.5 }, // этаж 1
    { tiles: 5, traps: 3, multiplier: 2 },   // этаж 2
    { tiles: 4, traps: 2, multiplier: 2.5 }, // этаж 3
    { tiles: 3, traps: 1, multiplier: 3 },   // этаж 4
    { tiles: 2, traps: 1, multiplier: 5 },   // этаж 5 (вершина)
];
const TOWER_FLOORS = TOWER_FLOOR_CONFIG.length;
const TOWER_MIN_BET = 0.3;
const TOWER_MAX_BET = 1000;

// Активные раунды хранятся в памяти процесса (как и у слотов/рулетки/бомбера) —
// раунд живёт от старта до кэшаута/проигрыша, между рестартами сервера
// персистентность не нужна. Один активный раунд на пользователя одновременно.
const towerActiveGames = new Map(); // tgId -> { bet, trapsByFloor:[[...]], climbed, path:[], startedAt }

function towerMultiplier(floorsClimbed) {
    if (floorsClimbed <= 0) return 1;
    const cfg = TOWER_FLOOR_CONFIG[floorsClimbed - 1];
    return cfg ? cfg.multiplier : 1;
}

function towerPublicState(game) {
    const currentMultiplier = Math.round(towerMultiplier(game.climbed) * 100) / 100;
    const nextMultiplier = game.climbed < TOWER_FLOORS
        ? Math.round(towerMultiplier(game.climbed + 1) * 100) / 100
        : null;
    return {
        bet: game.bet,
        floors: TOWER_FLOOR_CONFIG.map(f => ({ tiles: f.tiles, traps: f.traps })),
        totalFloors: TOWER_FLOORS,
        climbed: game.climbed,
        path: [...game.path],
        currentMultiplier,
        nextMultiplier,
        potentialWin: Math.round(game.bet * currentMultiplier * 100) / 100,
    };
}

// Расставляет `traps` уникальных ловушек среди `tiles` плиток этажа.
function towerGenerateFloorTraps(tiles, traps) {
    const positions = Array.from({ length: tiles }, (_, i) => i);
    for (let i = positions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    return positions.slice(0, traps);
}

// === Начать раунд: списываем ставку сразу (резерв), расставляем ловушки ===
app.post('/api/games/tower/start', requireAuth, (req, res) => {
    const bet = parseFloat(req.body.bet);

    if (!isValidAmount(bet, TOWER_MIN_BET, TOWER_MAX_BET)) {
        return res.status(400).json({
            ok: false,
            error: `Ставка должна быть от ${TOWER_MIN_BET} до ${TOWER_MAX_BET} TON, максимум с одним знаком после запятой`,
        });
    }
    if (towerActiveGames.has(req.tgId)) {
        return res.status(400).json({ ok: false, error: 'У вас уже есть активный раунд — завершите его (выберите плитку или заберите выигрыш)' });
    }

    let user;
    try {
        user = adjustBalance(req.tgId, -bet);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    const trapsByFloor = TOWER_FLOOR_CONFIG.map(cfg => towerGenerateFloorTraps(cfg.tiles, cfg.traps));

    const game = { bet, trapsByFloor, climbed: 0, path: [], startedAt: Date.now() };
    towerActiveGames.set(req.tgId, game);

    res.json({ ok: true, balance: user.balance, game: towerPublicState(game) });
});

// === Выбрать плитку на текущем этаже ===
app.post('/api/games/tower/pick', requireAuth, (req, res) => {
    const tile = parseInt(req.body.tile, 10);
    const game = towerActiveGames.get(req.tgId);

    if (!game) {
        return res.status(400).json({ ok: false, error: 'Нет активного раунда — начните новую игру' });
    }

    const floor = game.climbed;
    const cfg = TOWER_FLOOR_CONFIG[floor];
    if (!Number.isInteger(tile) || tile < 0 || tile >= cfg.tiles) {
        return res.status(400).json({ ok: false, error: 'Некорректная плитка' });
    }

    const floorTraps = game.trapsByFloor[floor];

    if (floorTraps.includes(tile)) {
        // Ловушка — раунд проигран, ставка не возвращается (она уже списана при старте).
        towerActiveGames.delete(req.tgId);
        createTransaction({ tg_id: req.tgId, type: 'game_tower', amount: -game.bet });
        return res.json({
            ok: true,
            win: false,
            floor,
            hitTile: tile,
            trapTiles: floorTraps,
            betAmount: game.bet,
            winAmount: 0,
            tilesPerFloor: cfg.tiles,
        });
    }

    game.path.push(tile);
    game.climbed += 1;

    if (game.climbed >= TOWER_FLOORS) {
        // Пройдены все этажи — автоматический кэшаут по максимальному множителю.
        const multiplier = Math.round(towerMultiplier(game.climbed) * 100) / 100;
        const winAmount = applyGameWinFee(Math.round(game.bet * multiplier * 100) / 100);
        towerActiveGames.delete(req.tgId);
        const user = adjustBalance(req.tgId, winAmount);
        createTransaction({ tg_id: req.tgId, type: 'game_tower', amount: winAmount - game.bet });
        return res.json({
            ok: true,
            win: true,
            cleared: true,
            floor,
            tile,
            multiplier,
            betAmount: game.bet,
            winAmount,
            balance: user.balance,
        });
    }

    res.json({ ok: true, win: null, floor, tile, game: towerPublicState(game) });
});

// === Забрать выигрыш досрочно ===
app.post('/api/games/tower/cashout', requireAuth, (req, res) => {
    const game = towerActiveGames.get(req.tgId);
    if (!game) {
        return res.status(400).json({ ok: false, error: 'Нет активного раунда' });
    }
    if (game.climbed === 0) {
        return res.status(400).json({ ok: false, error: 'Поднимитесь хотя бы на один этаж перед выводом' });
    }

    const multiplier = Math.round(towerMultiplier(game.climbed) * 100) / 100;
    const winAmount = applyGameWinFee(Math.round(game.bet * multiplier * 100) / 100);
    towerActiveGames.delete(req.tgId);

    const user = adjustBalance(req.tgId, winAmount);
    createTransaction({ tg_id: req.tgId, type: 'game_tower', amount: winAmount - game.bet });

    res.json({ ok: true, win: true, multiplier, betAmount: game.bet, winAmount, balance: user.balance });
});

// === Текущее состояние раунда (на случай, если пользователь обновил страницу) ===
app.get('/api/games/tower/state', requireAuth, (req, res) => {
    const game = towerActiveGames.get(req.tgId);
    if (!game) {
        return res.json({ ok: true, game: null });
    }
    res.json({ ok: true, game: towerPublicState(game) });
});

// =====================================================================
// ИГРА "КОСТИ" (Dice) — обычный игральный кубик, ставка на одно число
// =====================================================================
//
// Правила:
//   - Обычный кубик с гранями 1–6. Игрок выбирает ОДНО число, на которое
//     ставит, и делает ставку.
//   - Сервер честно бросает кубик (случайное число 1–6).
//   - Если выпавшее число совпало с выбранным — выигрыш x3 от ставки.
//   - Если нет — ставка сгорает.
const DICE_MIN_BET = 0.3;
const DICE_MAX_BET = 1000;
const DICE_PAYOUT_MULTIPLIER = 3;

// === Бросить кубик: всё считается на сервере за один запрос — ставка
// списывается и выигрыш (если есть) начисляется в этом же ответе ===
app.post('/api/games/dice/roll', requireAuth, (req, res) => {
    const bet = parseFloat(req.body.bet);
    const number = parseInt(req.body.number, 10);

    if (!isValidAmount(bet, DICE_MIN_BET, DICE_MAX_BET)) {
        return res.status(400).json({
            ok: false,
            error: `Ставка должна быть от ${DICE_MIN_BET} до ${DICE_MAX_BET} TON, максимум с одним знаком после запятой`,
        });
    }
    if (!Number.isInteger(number) || number < 1 || number > 6) {
        return res.status(400).json({ ok: false, error: 'Число должно быть от 1 до 6' });
    }

    // Бросок — случайное число от 1 до 6.
    const roll = 1 + Math.floor(Math.random() * 6);
    const isWin = roll === number;
    const winAmount = isWin ? applyGameWinFee(Math.round(bet * DICE_PAYOUT_MULTIPLIER * 100) / 100) : 0;
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
        number,
        win: isWin,
        multiplier: DICE_PAYOUT_MULTIPLIER,
        betAmount: bet,
        winAmount,
        balance: user.balance,
    });
});

// =====================================================================
// ИГРА "ПЛИНКО" (Plinko) — шарик падает через 16 рядов колышков в одну
// из 17 корзин с разным множителем внизу
// =====================================================================
//
// Правила:
//   - Игрок делает ставку и роняет шарик.
//   - Шарик "падает" через 16 рядов колышков и попадает в одну из 17 корзин
//     внизу — таблица множителей симметрична и зафиксирована (без выбора
//     риска): 10, 5, 3, 2.5, 2, 1.5, 1.3, 1.2, 0, 1.2, 1.3, 1.5, 2, 2.5, 3, 5, 10.
//   - Выигрыш = ставка × множитель той корзины, в которую попал шарик.
//   - Крайние корзины (самый большой множитель) — самые редкие, центральная
//     (x0) — самая частая. Вероятность подобрана НЕ как честная монетка на
//     каждом колышке (это дало бы отдачу больше 100% из-за высоких крайних
//     множителей), а отдельной весовой таблицей — так же, как в рулетке.
//     Путь шарика (path) при этом генерируется случайно и лишь визуально
//     соответствует итоговой корзине — само попадание уже решено заранее.
const PLINKO_MIN_BET = 0.3;
const PLINKO_MAX_BET = 1000;
const PLINKO_ROWS = 16; // 16 рядов колышков -> 17 корзин внизу (0..16 "вправо")

// Множители по корзинам, индекс = сколько раз шарик мог бы уйти "вправо" из 16 рядов.
const PLINKO_MULTIPLIERS = [10, 5, 3, 2.5, 2, 1.5, 1.3, 1.2, 0, 1.2, 1.3, 1.5, 2, 2.5, 3, 5, 10];

// Веса корзин (не путать с честной вероятностью колышка!) — геометрически
// убывают от центра к краям, подобраны так, чтобы отдача была ~86%,
// на уровне остальных игр в этом разделе.
const PLINKO_WEIGHTS = [
    0.001682, 0.003737, 0.008304, 0.018453, 0.041006, 0.091125, 0.2025, 0.45,
    1.0,
    0.45, 0.2025, 0.091125, 0.041006, 0.018453, 0.008304, 0.003737, 0.001682,
];
const PLINKO_TOTAL_WEIGHT = PLINKO_WEIGHTS.reduce((sum, w) => sum + w, 0);

// Выбираем итоговую корзину по весовой таблице (не по 16 честным монеткам).
function plinkoPickBinIndex() {
    let roll = Math.random() * PLINKO_TOTAL_WEIGHT;
    for (let i = 0; i < PLINKO_WEIGHTS.length; i++) {
        if (roll < PLINKO_WEIGHTS[i]) return i;
        roll -= PLINKO_WEIGHTS[i];
    }
    return PLINKO_WEIGHTS.length - 1;
}

// Строим правдоподобный путь шарика (для анимации на клиенте) длиной
// PLINKO_ROWS с ровно targetIndex шагами "вправо" — расставленными в
// случайном порядке, чтобы выглядело как настоящее блуждание по доске.
function plinkoGeneratePath(targetIndex) {
    const path = Array(PLINKO_ROWS).fill(false).fill(true, 0, targetIndex);
    for (let i = path.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [path[i], path[j]] = [path[j], path[i]];
    }
    return path;
}

// === Бросить шарик: корзина выбирается по весовой таблице, путь для
// анимации на клиенте генерируется отдельно и лишь визуально ведёт к ней ===
app.post('/api/games/plinko/drop', requireAuth, (req, res) => {
    const bet = parseFloat(req.body.bet);

    if (!isValidAmount(bet, PLINKO_MIN_BET, PLINKO_MAX_BET)) {
        return res.status(400).json({
            ok: false,
            error: `Ставка должна быть от ${PLINKO_MIN_BET} до ${PLINKO_MAX_BET} TON, максимум с одним знаком после запятой`,
        });
    }

    const slotIndex = plinkoPickBinIndex();
    const path = plinkoGeneratePath(slotIndex);
    const multiplier = PLINKO_MULTIPLIERS[slotIndex];
    const winAmount = applyGameWinFee(Math.round(bet * multiplier * 100) / 100);
    const netDelta = Math.round((winAmount - bet) * 100) / 100;

    let user;
    try {
        user = adjustBalance(req.tgId, netDelta);
    } catch (e) {
        return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });
    }

    createTransaction({ tg_id: req.tgId, type: 'game_plinko', amount: netDelta });

    res.json({
        ok: true,
        path,
        slotIndex,
        multiplier,
        betAmount: bet,
        winAmount,
        balance: user.balance,
    });
});

// === Создать ордер на покупку (сумма сразу резервируется на балансе) ===
app.post('/api/orders', requireAuth, (req, res) => {
    const { collectionId, modelId, backdropId, symbolId, maxPrice, quantity } = req.body;
    const parsedPrice = parseFloat(maxPrice);
    const parsedQuantity = parseInt(quantity, 10) || 1;

    if (!collectionId) {
        return res.status(400).json({ ok: false, error: 'Выберите коллекцию' });
    }
    if (!isValidAmount(parsedPrice, 0.1, 100000)) {
        return res.status(400).json({ ok: false, error: 'Цена должна быть от 0.1 до 100000, максимум с одним знаком после запятой' });
    }
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 1000) {
        return res.status(400).json({ ok: false, error: 'Количество должно быть целым числом от 1 до 1000' });
    }

    // Резервируем сразу всю сумму на все запрошенные единицы — цена за 1 штуку × количество.
    const totalReserve = Math.round(parsedPrice * parsedQuantity * 100) / 100;

    let buyer;
    try {
        buyer = adjustBalance(req.tgId, -totalReserve);
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
        quantity: parsedQuantity,
    });

    // Уведомляем владельцев всех подходящих активных лотов — им кинули
    // новое предложение на их подарок (совпадение по трейтам, необязательно
    // мгновенная сделка — продавец сам решает, принимать ли).
    const matchingListings = findMatchingListingsForOrder(order);
    for (const l of matchingListings) {
        notifyTelegram(
            l.owner_tg_id,
            `💰 Вам предложили <b>${parsedPrice} 💎</b> за <b>${giftDisplayName(l)}</b>`,
            l.model_image || l.collection_image
        );
    }

    res.json({ ok: true, order: getOrderWithDetails(order.id), balance: buyer.balance });
});

// === Активные ордера текущего пользователя ===
app.get('/api/orders', requireAuth, (req, res) => {
    res.json({ ok: true, orders: listActiveOrdersForUser(req.tgId) });
});

// === Ордербук по конкретной коллекции — ВСЕ активные ордера всех
// покупателей (не только свои), опционально суженные по модели/фону/символу.
// Открывается кнопкой "Смотреть ордера" на Маркете, когда выбрана ровно
// одна коллекция. Авторизация не обязательна — список публичный, как и сам
// маркет; фронт сам решает, что показать во вкладке "Мои", сверяя buyer_tg_id
// с текущим пользователем. ===
app.get('/api/orders/collection', (req, res) => {
    const collectionId = parseInt(req.query.collectionId, 10);
    if (!collectionId) {
        return res.status(400).json({ ok: false, error: 'Не указана коллекция' });
    }
    const orders = listOrdersForCollection({
        collectionId,
        modelName: req.query.model || undefined,
        backdropName: req.query.backdrop || undefined,
        symbolName: req.query.symbol || undefined,
    });
    res.json({ ok: true, orders });
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

    const remainingUnits = order.quantity - order.filled_count;
    const refund = Math.round(order.max_price * remainingUnits * 100) / 100;
    const user = adjustBalance(req.tgId, refund);
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

    notifyTelegram(
        sellerTgId,
        `🎉 <b>${giftDisplayName(listing)}</b> продан за ${listing.price} 💎\nНа баланс зачислено ${sellerPayout.toFixed(2)} 💎`,
        listing.model_image || listing.collection_image
    );

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
    // Разрешаем принимать предложение как по уже выставленному лоту ('active'),
    // так и по товару прямо из хранилища ('owned') — второе используется
    // кнопкой "Быстрая продажа" на Маркете, чтобы продать без промежуточного
    // выставления на продажу. Цена самого листинга тут не участвует вообще —
    // сделка всегда проходит по цене ордера (order.max_price) ниже.
    if (listing.status !== 'active' && listing.status !== 'owned') {
        return res.status(400).json({ ok: false, error: 'Товар недоступен для продажи' });
    }

    const orderId = parseInt(req.body.orderId, 10);
    const order = getOrderById(orderId);

    if (!order || order.status !== 'active') {
        return res.status(400).json({ ok: false, error: 'Это предложение больше недоступно' });
    }
    // Нельзя продать товар по собственному ордеру — это не настоящая сделка,
    // а просто перекладывание из одного кармана в другой с потерей на комиссии.
    if (order.buyer_tg_id === req.tgId) {
        return res.status(400).json({ ok: false, error: 'Нельзя продать товар по своему же ордеру на покупку' });
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
    fillOrderOnce(order.id, listing.id);
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

    notifyTelegram(
        order.buyer_tg_id,
        `✅ Ваше предложение принято!\n<b>${giftDisplayName(details)}</b> теперь ваш`,
        details.model_image || details.collection_image
    );

    res.json({ ok: true, listing: soldListing, balance: seller.balance });
});

// Продавец отклоняет чужое предложение (order) на свой лот — покупателю
// возвращаются зарезервированные деньги, ордер полностью отменяется (в т.ч.
// пропадает из "Предложений" у всех остальных продавцов с похожим лотом).
app.post('/api/listings/:id/decline-offer', requireAuth, (req, res) => {
    const listingId = parseInt(req.params.id, 10);
    const orderId = parseInt(req.body.orderId, 10);

    const order = getOrderById(orderId);
    const result = declineOfferAsSeller(orderId, listingId, req.tgId);

    if (!result.ok) {
        return res.status(400).json(result);
    }

    if (order) {
        notifyTelegram(
            order.buyer_tg_id,
            '❌ Ваше предложение на покупку отклонено продавцом. Деньги возвращены на баланс.'
        );
    }

    res.json({ ok: true });
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

    const firstItem = trade.initiatorItems[0];
    const itemsLabel = trade.initiatorItems.length > 1
        ? `${giftDisplayName(firstItem)} и ещё ${trade.initiatorItems.length - 1} шт.`
        : giftDisplayName(firstItem);
    notifyTelegram(
        recipientTgId,
        `🔄 Вам предложили обмен: <b>${itemsLabel}</b>${tonAmount && tonPayer === 'initiator' ? ` + ${tonAmount} 💎 доплата` : ''}`,
        firstItem.model_image || firstItem.collection_image
    );

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

    const firstItem = result.trade.recipientItems[0] || result.trade.initiatorItems[0];
    notifyTelegram(
        result.trade.initiator_tg_id,
        `✅ Ваш обмен принят! <b>${giftDisplayName(firstItem)}</b>${result.trade.recipientItems.length > 1 ? ` и ещё ${result.trade.recipientItems.length - 1} шт.` : ''} теперь у вас`,
        firstItem.model_image || firstItem.collection_image
    );

    res.json({ ok: true, trade: result.trade, balance: user.balance });
});

// === Отклонить трейд (только получатель) ===
app.post('/api/trades/:id/decline', requireAuth, (req, res) => {
    const result = declineTrade(parseInt(req.params.id, 10), req.tgId);
    if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
    }
    const user = getUserByTgId(req.tgId);

    notifyTelegram(
        result.trade.initiator_tg_id,
        `❌ Ваше предложение обмена отклонено`
    );

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
