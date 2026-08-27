/**
 * scripts/seed-collections.js
 *
 * Заполняет таблицы collections / gift_models / gift_backdrops / gift_symbols
 * РЕАЛЬНЫМИ данными из TonAPI (https://tonapi.io) — публичного индексатора TON,
 * а не руками вписанными названиями.
 *
 * Как это работает:
 *   1. Ты указываешь TON-адреса коллекций, которые хочешь добавить в маркет
 *      (см. массив COLLECTION_ADDRESSES ниже).
 *   2. Скрипт тянет метаданные коллекции + все её NFT-айтемы через TonAPI.
 *   3. Из атрибутов каждого айтема (model / backdrop / symbol — так они называются
 *      в метаданных апгрейженных подарков Telegram) собирается каталог трейтов
 *      с процентом редкости, посчитанным по реальному количеству повторов.
 *
 * Откуда взять адреса коллекций:
 *   - Открой нужную коллекцию на https://getgems.io или https://tonviewer.com
 *   - В URL/на странице будет TON-адрес коллекции вида "EQ..." или "UQ..."
 *   - TonAPI можно погонять руками, чтобы проверить адрес:
 *     https://tonapi.io/v2/nfts/collections/EQ...
 *
 * Запуск:
 *   node scripts/seed-collections.js
 *
 * Опционально: TONAPI_KEY в переменных окружения — без ключа TonAPI работает,
 * но с более строгим лимитом запросов в минуту.
 */

const {
    upsertCollection,
    upsertModel,
    upsertBackdrop,
    upsertSymbol,
} = require('./database');

// === ЗАПОЛНИ ЭТИМ СПИСКОМ реальные адреса нужных тебе коллекций ===
const COLLECTION_ADDRESSES = [
    'EQBG-g6ahkAUGWpefWbx-D_9sQ8oWbvy6puuq78U2c4NUDFS', // Plush Pepe
    'EQATuUGdvrjLvTWE5ppVFOVCqU2dlCLUnKTsu0n1JYm9la10',
    'EQD9ikZq6xPgKjzmdBG0G0S80RvUJjbwgHrPZXDKc_wsE84w',
    'EQA4i58iuS9DUYRtUZ97sZo5mnkbiYUBpWXQOe3dEUCcP1W8',
    'EQCE80Aln8YfldnQLwWMvOfloLGgmPY0eGDJz9ufG3gRui3D',
    'EQBI07PXew94YQz7GwN72nPNGF6htSTOJkuU4Kx_bjTZv32U',
    'EQC1gud6QO8NdJjVrqr7qFBMO0oQsktkvzhmIRoMKo8vxiyL',
    'EQAlROpjm1k1mW30r61qRx3lYHsZkTKXVSiaHEIhOlnYA4oy',
    'EQDeX0F1GDugNjtxkFRihu9ZyFFumBv2jYF5Al1thx2ADDQs',
    'EQDIReleOkTxCD4g_XEm8xj0LYNg6-zMsTGAAwCA-vEbkGBu',
    'EQACcQpR2fmdeENWdE2YGQWHVxSTyA8Zq4_k7rk_IaxCRXNe',
    'EQAoJw7BpOcBD3y9voMuEQ-qhS3K4gtM-6EePLxkzk8iSifX',
    'EQDCPq7QSUvCmq7kBhmDulxVdeFHKFc1wT9MQxnesanl1Hql',
    'EQDTro-ogJbS7o-OBD6bt2NysPt7SnGm5zfuRXGB1nE_rbGa',
    'EQC6zjid8vJNEWqcXk10XjsdDLRKbcPZzbHusuEW6FokOWIm',
    'EQA2RI7XvIs9wJQKrxkTb7YtpeUuaD-p0eT5uBe4bkcGT2bd',
    'EQDvZ_9Z3tJ9k6eELLtTeuQAz4yOOWyYFZfzqNv2dGJiHvrF',
    'EQCrGA9slCoksgD-NyRDjtHySKN0Ts8k6hdueJkUkZZdD4_K',
    'EQAZjuUJmbP-V4Ryowjexh7bIcdNrrojr0WKSpdggB0zbst5',
    'EQAqtF5tZIgNZal80ChzdPMvZCN8OEbJCVJPn_0xNPghQJPW',
    'EQBMcfMAZlMUr1W3X8kdEw3fJMUAaWH4-XcmE5R5RfFIY0E2',
    'EQAwnP7dGfE_WO0xiCiulkAXUG1K1bWH1vE1k64T4G-7gruO',
    'EQCNsmpHqRSY_Dxnyh6P0MMO7zcABf8sVvG0wr245pBzO3B3',
    'EQA72Uevr_MHvzYwSCHJUK-uC6kd-w8kbxzhJ49WIiG-o6CD',
    'EQBUvskEvmWdp_V6HX-2Tyfp4mFSzMzdg9TaUz6zKVz6Ov3f',
    'EQCa1I09fE9UoTV6awM6QC9-fkv51hoii24w1tJoFfigG_ax',
    'EQDJsN9OJBhKGZoWZWtkEpzkCfIu16Z9UzTWbYjeLpuHdT5f',
    'EQDL7HMbca0FufrjHFcRoiLkEiOXkXoO_vH2gVUN8JNp4khK',
    'EQCwEFfUbbR-22fn3VgxUpBil7bwBQqEHm7wgQYbWY9c08YJ',
    'EQCgaTxb2wA_3Bi8Ec4FFNu8CauoHo0VPpnwxdrhAgOrOXvA',
    'EQCZxxFMS-y1hcGADL6EPB7usNstQqD9u-yBaYpXVVMr75NF',
    'EQCWh1lPltyTwCWxCXm4umL5tPZoXR8kTIcT-pd0JqoadLHo',
    'EQDaj18cd61VLZHCHsM7sKbfxBudD3gaSfcN02olVnQ3BCIB',
    'EQBSIId7sMmlqN8oBGaMNtUeuaLeSQPUR1ByMwpnfWL3hhZq',
    'EQDRrfw5pgIC4e6NafUAx52Z9Ym6q1k26xxaXR_qx0LKJJ7D',
    'EQCZ4-h65iTiWDPRPcLlS63gbcS40YBadEFLA4W-iIWUZld0',
    'EQAtFU9GrGfix4UG9DOivN58QxvgBJUaAZ_pdZBZCmbhKo4P',
    'EQCeTSJOPXP_SSvOjILY-kui4bGHUmsa-U7TXP4DjUANTl4s',
    'EQCMBgeRNOjZo6A_GpF4G66VTA8V4vpSitIZzJP3Qz4ZO5YM',
    'EQBayCY2wZwrVBExNfLL8v9K0mHNmrQTntZldgpYiRwB_QKK',
    'EQBIj0uF-qIASqv6qIvcTif2wKSdt4WQc4mcoBywNp5GntuG',
    'EQCDBbQYbv3n91TwywBRD9YrJNuNVmbD3Sprpq6hWIDHVu4p',
    'EQBD8aBKC4NsnYMqtkCfPQk2EVnieynJQp1UgZVyx1VmR5Ml',
    'EQA0JBiVCjdgqkiHiYmIgTUBbZI6mNbnSymqf0HFC7FhxpuT',
    'EQDIruSTyxvq60gUH8j2kkj3qzoBrBaJy9WkKbeNNRasWe4j',
    'EQD6mH9bwbn6S3M_tCRWOvqAIW8M34kRwbI01niGLRPeDPsl',
    // 'tonkinside-in-telegram' — это НЕ TON-адрес, а красивый URL-слаг getgems.
    // TonAPI по нему коллекцию не найдёт. Нужен настоящий адрес EQ.../UQ... —
    // смотри на странице коллекции на getgems (обычно в разделе "Contract"/"О коллекции").
    'EQCt2C3yCRNX267B3l6h1QsU6agm4ZgTAb7NpVGiFKlBXOAA',
    'EQAXHW9KVYYgDmLaUNcgzNPZ4WKGek97-ldsd0fPUHg4K7SU',
    'EQDr4xn5_GoCzDxhGJMek7fv3nm6W7bhRvlDSBjcNZul52tZ',
    'EQBlBJ4n01pmYez5VPd8Wo598s8agbQCyVOjucXKxLDAi9r7',
    'EQBCe75G0AhjqC64B7H_BHP0wgfONX_x98rszmsEwndDVAjG',
    'EQBw2tO5UaJ4c_YXt3I8y5KD0k37staZxedV2O5HmryiK0dN',
    'EQDc08YxzZWtlKAohSybNc3kXAkAPPtHch-jY_E6KMQ3b1mn',
    'EQC8WVW9DSN4PPfFlCW2AHJkXxBUHBFsvnhXiYqSTpD7tXsp',
    'EQADvJxMxCHA7fRlYjoceBORf7RwKs0rzjVaKepQACMnZzG7',
    'EQDumy3bnZYzV4bSWMSSZkmXqx50XuH5d9RlX_yEi2FNlivk',
    'EQC2lsUy1SKxJEJBwj5ZCfVnLPvAqDqy5c26Xg8xS_pDTXGk',
    'EQCyAMkb6bNyNlKPH0tJbubk1VVjASqyq9sZwkJ8AbxMkxxU',
    'EQDsiZuliQn_FTUeyCVaVhojljY7LmimdUtJK1SntGTzff5z',
    'EQBBLRFtC_3PLxNpWX5nfchwapk7eWcG3dzKoxbV6cWzqROo',
    'EQAOYYJib8K6-91TjeOYRbWEtbtRJHXKoWltnULwdaqd7mR5',
    'EQAwzubeoJwnqmmBuTPpnUSurRzWPB8ERzcfzx55Z2YjE0jx',
    'EQDQ6DjRabTYSAxf2xrZsnsXtqcIm1bj9dF5x_h8lNjWPmH4',
    'EQBdlKhLzezYFMCWSWTCnhpKC1uyczaBUOj3EtPjcatUsTrC',
    'EQA2lHcvZWW_bN_2NMKrkEUv9xz6fx8wTE5upa8u1neZb6hJ',
    'EQDLM65t0shS7gZAg0lMltGHYhsU94PzsMJHhYibmRV7kdUs',
    'EQAIwEMO6wB8Iby8Va0EQGPkDWcVc6uUmMOfXmEyqZmM93sl',
    'EQCehrkZtKDtVe0qyvBAsrHx3hW-hroQyDrS_MZOOVYth2DG',
    'EQAkqbUwkuFy5sgkgXEGSr9WSxnbslVCc25Ri9BfAEIzXFU-',
    'EQA_kx2WOydXWzYUYO1DP80aHl4yhlLGYhxjPAtRPNjMgfYM',
    'EQBT9PbZBR6FGcZBSnwgo-DLpc0r7_X_8dlhG5UA6v9l9uJM',
    'EQD7yDu2WCgd9Uzx1dF_DQkWK7IZJJ4Mp9M9g1rGUUiQE43m',
    'EQA401QqpXtBnwIaDbFjwd5yXfP2mYiCusbJ3Zcw9eXR9CqL',
    'EQDycOgkLwcfPDokh8q-2DIUzVhPetdFuZmwrFYFP6i1nZ_u',
    'EQB8zLzEOFQK3qTyMYgPD8BuzmNwblnouqaB80PW-s2E7nct',
    'EQB6AtBPOuTtQml8oSA7X8ZqJ5QmcOYYqoz92sQYXGUQrxyB',
    'EQDz_VecErEBTLOTiR1tq0VS3lZuHHqhYmhZbthcrbFk7ztK',
    'EQAtgbhSHOqTxjuRLLOAab6T66FPcQWTNd_DT3VgCG1-tHJw',
    'EQAo_snApDDqF6GKV0xe_T5oe28r842gJtgmkgPMhX0-dRkh',
    'EQCBK_JBASAA5XVz1D17Pn--kQaMWm0b9wReVtsEdRO4Tgy9',
    'EQA8DCWyCWyywgOKYORerRoSVevWrUQ_FjKQgNihxY1227x7',
    'EQDpxJ6VAwUA-tX6w8ACnoAJLrP3hKWmieBl71uv1_qKRD3x',
    'EQAaTIR7oJyowDiumYLVN0oe61kGE3I6EPEn7WgHPGuWAeCy',
    'EQBM3U1twWjI_vYUaPdFkzZs1q9c0orHhQjx0m2Xa9ljgTqY',
    'EQAUffQWl09_yhXDTp8oN13Px8ygPm0xcyNGhHOiONV-x3om',
    'EQC7oPa-gJDZ6JRwW0WW4WH_Vjn7ioKmfDdFItD7nYFGdbuU',
    'EQCBcMPpEjKJysTb534Nvt3FXQgkzVyhaaBDIyrcaKD1PsFF',
    'EQB1ATaKGNYk6T5R2cA18BOF-KB_idaKKigwYI2jtjWuLg8n',
    'EQB5P3ZP2PjLION52Y1SNAux1do4-ZOqMWotXS-fdMpqHcCH',
    'EQC-ZdsouFU-xMa509yP8kzKceZnGV7lSQskxima1Mr3iDYB',
    'EQC65Yy6N04vHoeCJ0yo4qll5eu-ZaWbS5nxsdilxymhmSus',
    'EQD9z87hRZAV7C2MV1gk39-bSg5Yfs2EdMr9HfK81IuB2Rlc',
    'EQDx-SqQEhP9Rzfi2cqdehTVUvQbArsUz1X7t-ul8IiKZpYb',
    'EQBaOL8mH5YywkXjkps65X1OLPNH7pns4YcfLmaVpFaoNKZn',
    'EQBAXR68f1UgRhToFR_bXY1zPJy5O6sm2St0CRTo92BTxGiH',
    'EQBG2o0lp-6Oy86NGEJm717BeTDAw_F5ELkgaX2l9UsfavWE',
    'EQDqHwSzU4I_U44vSM9EDP4HGGKWy9yWjbzkpCa3K8iMBEVD',
    'EQBzZLNIr4lie0pTfrbRsANJOtFYwY5gmngRfs84Ras5-aVN',
    'EQBbUKx5CalEly2TekDNeFbv4e02pj6xsAqXZP0X_AprKj4I',
    'EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y', // Homemade Cakes (getgems slug: tonkinside-in-telegram)
    'EQAPNu648fe_uqUoeH6V_-fIDJYea_5Xu2rXn6iZFil49bMY',
    'EQA3-i1IUFjWyDhaIoCGdYUB4nt2IYaT3T-95CHPrSvV3AfX',
    'EQB4x3sT1DVdODzay3H-4VJIdOooS5-kTgyKcYMZWogPOsiq',
    'EQBcNxMCTyEHkcQ5cK3fO_3Ebjf6JcA5JJ_OJV4npDN-604P',
    'EQDjBdu3zS-JT94OwIup4KVNaQjxDzGcIPRJ24Ha0Y8jLw83',
    'EQARIAumGWBmKSv2BoMxtunCEFybIn6nimCq_laeqkD-AVSk',
    'EQBV5XozKA0e06Z5y6eL7pWrUUpEolbPhNdcNS0K4ZDk1jCs',
    'EQAIM-5QzZGXYTSZR1RGeT2g9rNpYmNPQ09_HtvaInHaTyPX',
    'EQD1YFp12AGEgX6C3uiWh751EcRxPZo6GtBmHziY29jcbQzS',
    'EQCEVLBbgzL5Ih9bzMkneLi68xzOelYN3NEugm_4gZTpuAFP',
    'EQBEngWldzev9oqzctu59Go9afX8HF8HksZ9pJ7x1bRJXsc7',
    'EQC212djrq0gglQXi8MSFX1bcw4LHw3Es62lKvt1lZzzsYuF',
    'EQA0EzRYX5wm_q46_NX8b7EYhtOkXfXgsr06ETbov1a7StZl',
    'EQBjzdi27ZI-Re93OOIia0m7YmUU8d8ubJNsStZTc7qNJnOv',
    'EQDLda715GocP1sYDkCecPhO7eFNsNvARD4pumbGSan96wvZ',
    'EQDsNmzs1xb4df4U439Oo91bp-s2UDP_DxfL-E0Yhf4UULLu',
    'EQBCwFnalN0aGzoJgVihtMLTeXuKO_tHIxq7bddNlnH2JoVB',
];

const TONAPI_BASE = 'https://tonapi.io/v2';
const TONAPI_KEY = process.env.TONAPI_KEY || '';
const PAGE_SIZE = 1000;

function headers() {
    return TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tonapiGet(url, attempt = 1) {
    const res = await fetch(url, { headers: headers() });

    if (res.status === 429 && attempt <= 5) {
        const waitMs = attempt * 2000;
        console.log(`  Лимит запросов TonAPI, жду ${waitMs / 1000}с и пробую снова (попытка ${attempt}/5)...`);
        await sleep(waitMs);
        return tonapiGet(url, attempt + 1);
    }

    if (!res.ok) {
        throw new Error(`TonAPI ${res.status} для ${url}: ${await res.text()}`);
    }
    return res.json();
}

async function fetchCollectionMeta(address) {
    return tonapiGet(`${TONAPI_BASE}/nfts/collections/${address}`);
}

/** Тянет ВСЕ айтемы коллекции постранично (TonAPI отдаёт максимум PAGE_SIZE за раз). */
async function fetchAllItems(address) {
    let offset = 0;
    let all = [];

    while (true) {
        const page = await tonapiGet(
            `${TONAPI_BASE}/nfts/collections/${address}/items?limit=${PAGE_SIZE}&offset=${offset}`
        );
        const items = page.nft_items || [];
        all = all.concat(items);

        if (items.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        await sleep(TONAPI_KEY ? 150 : 600);
    }

    return all;
}

/** Достаёт trait_type/value пары из metadata.attributes конкретного айтема. */
function extractTraits(item) {
    const attrs = item.metadata?.attributes || [];
    const get = (traitType) =>
        attrs.find((a) => (a.trait_type || '').toLowerCase() === traitType)?.value || null;

    return {
        model: get('model'),
        backdrop: get('backdrop'),
        symbol: get('symbol'),
    };
}

function computeRarity(counter, total) {
    // permille = доля * 1000, напр. 15.0 значит 1.5%
    const out = {};
    for (const [name, count] of Object.entries(counter)) {
        out[name] = total ? (count / total) * 1000 : null;
    }
    return out;
}

async function seedCollection(address) {
    console.log(`\n→ Коллекция ${address}`);

    const meta = await fetchCollectionMeta(address);
    const name = meta.metadata?.name || meta.name || address;
    const image = meta.metadata?.image || meta.previews?.[0]?.url || null;

    const collection = upsertCollection({ ton_address: address, name, image_url: image });
    console.log(`  Название: ${name}`);

    const items = await fetchAllItems(address);
    console.log(`  Айтемов найдено: ${items.length}`);

    const modelCounts = {};
    const backdropCounts = {};
    const symbolCounts = {};

    for (const item of items) {
        const { model, backdrop, symbol } = extractTraits(item);
        if (model) modelCounts[model] = (modelCounts[model] || 0) + 1;
        if (backdrop) backdropCounts[backdrop] = (backdropCounts[backdrop] || 0) + 1;
        if (symbol) symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1;
    }

    const total = items.length;
    const modelRarity = computeRarity(modelCounts, total);
    const backdropRarity = computeRarity(backdropCounts, total);
    const symbolRarity = computeRarity(symbolCounts, total);

    for (const modelName of Object.keys(modelCounts)) {
        upsertModel(collection.id, modelName, modelRarity[modelName]);
    }
    for (const backdropName of Object.keys(backdropCounts)) {
        upsertBackdrop(collection.id, backdropName, null, backdropRarity[backdropName]);
    }
    for (const symbolName of Object.keys(symbolCounts)) {
        upsertSymbol(collection.id, symbolName, null, symbolRarity[symbolName]);
    }

    console.log(
        `  Сохранено: ${Object.keys(modelCounts).length} моделей, ` +
        `${Object.keys(backdropCounts).length} фонов, ` +
        `${Object.keys(symbolCounts).length} символов`
    );
}

async function main() {
    if (COLLECTION_ADDRESSES.length === 0) {
        console.log(
            'Список COLLECTION_ADDRESSES пуст. Впиши в него реальные TON-адреса ' +
            'коллекций (см. комментарий в начале файла) и запусти скрипт снова.'
        );
        return;
    }

    for (const address of COLLECTION_ADDRESSES) {
        try {
            await seedCollection(address);
        } catch (e) {
            console.error(`  Ошибка для ${address}:`, e.message);
        }
        // Небольшая пауза между коллекциями, чтобы не упереться в лимит TonAPI
        // (особенно заметно без TONAPI_KEY). Если ключ есть — можно смело уменьшить.
        await sleep(TONAPI_KEY ? 300 : 1200);
    }

    console.log('\nГотово.');
}

main();
