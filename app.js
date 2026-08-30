// === Адрес бэкенда на Railway ===
const API_URL = 'https://boom-backend-production-dc56.up.railway.app';

const grid = document.getElementById('marketGrid');
const searchInput = document.getElementById('searchInput');
const sortTriggerBtn = document.getElementById('sortTriggerBtn');
const sortModal = document.getElementById('sortModal');

// Элементы для переключения экранов
const marketScreen = document.getElementById('marketScreen');
const profileScreen = document.getElementById('profileScreen');
const historyScreen = document.getElementById('historyScreen');
const ordersScreen = document.getElementById('ordersScreen');
const storageScreen = document.getElementById('storageScreen');
const tradeScreen = document.getElementById('tradeScreen');
const openProfileBtn = document.getElementById('openProfileBtn');
const backToMarketBtn = document.getElementById('backToMarketBtn');
const backToProfileFromHistoryBtn = document.getElementById('backToProfileFromHistoryBtn');
const backToProfileFromOrdersBtn = document.getElementById('backToProfileFromOrdersBtn');
const backToProfileFromStorageBtn = document.getElementById('backToProfileFromStorageBtn');
const backToProfileFromTradeBtn = document.getElementById('backToProfileFromTradeBtn');

const screensByName = {
    market: marketScreen,
    profile: profileScreen,
    history: historyScreen,
    orders: ordersScreen,
    storage: storageScreen,
    trade: tradeScreen,
};

/** Показывает один экран из screensByName, скрывая остальные, и подсвечивает
 * соответствующий пункт во всех копиях нижней навигации (она есть на нескольких экранах). */
let currentScreenName = 'market';

function showScreen(name) {
    currentScreenName = name;

    Object.values(screensByName).forEach(screen => {
        if (screen) screen.classList.remove('active');
    });
    if (screensByName[name]) screensByName[name].classList.add('active');

    document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-nav') === name);
    });

    if (name === 'history') {
        loadHistory();
    }
    if (name === 'orders') {
        loadActiveOrders();
        loadOrderHistory();
        loadMyOffers();
    }
    if (name === 'storage') {
        loadInventory();
    }
    if (name === 'profile') {
        refreshOrdersStat();
    }
    if (name === 'trade') {
        resetTradeNewPanel();
        loadIncomingTrades();
        loadMyTrades();
    }
    if (name === 'market') {
        // Маркет — стартовый экран, а не отдельная вкладка с автообновлением:
        // без этого список лотов оставался закэшированным с прошлой загрузки
        // и не показывал изменения других пользователей (снятые/проданные лоты
        // пропадали только после полного перезахода в бота).
        loadListings();
    }
}

// === Автообновление маркета, пока пользователь на нём стоит ===
// Одного loadListings() при переходе на экран недостаточно: если человек
// просто сидит на маркете и никуда не переключается, чужие изменения
// (снятие лота, покупка, новый лот) не появятся сами — раньше это было
// видно только после полного перезахода в бота. Опрашиваем сервер, пока
// вкладка активна и открыт именно экран маркета, чтобы не слать лишние
// запросы, когда бот свёрнут или пользователь на другом экране.
const MARKET_POLL_INTERVAL_MS = 5000;

setInterval(() => {
    if (currentScreenName === 'market' && document.visibilityState === 'visible') {
        loadListings();
    }
}, MARKET_POLL_INTERVAL_MS);

openProfileBtn.addEventListener('click', () => {
    showScreen('profile');
});

backToMarketBtn.addEventListener('click', () => {
    showScreen('market');
});

if (backToProfileFromHistoryBtn) {
    backToProfileFromHistoryBtn.addEventListener('click', () => {
        showScreen('profile');
    });
}

if (backToProfileFromOrdersBtn) {
    backToProfileFromOrdersBtn.addEventListener('click', () => {
        showScreen('profile');
    });
}

if (backToProfileFromStorageBtn) {
    backToProfileFromStorageBtn.addEventListener('click', () => {
        showScreen('profile');
    });
}

if (backToProfileFromTradeBtn) {
    backToProfileFromTradeBtn.addEventListener('click', () => {
        showScreen('profile');
    });
}

// Нижняя навигация встречается на нескольких экранах (профиль, история) —
// делегируем клики по data-nav вместо привязки к id конкретной кнопки.
document.querySelectorAll('.bottom-nav .nav-item[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
        showScreen(btn.getAttribute('data-nav'));
    });
});

// =====================================================================
// СОСТОЯНИЕ ФИЛЬТРОВ И ДАННЫХ
// =====================================================================

// Текущие применённые фильтры (мультивыбор — везде массивы)
const activeFilters = {
    collectionIds: [],   // выбранные id коллекций (NFT)
    models: [],          // выбранные названия моделей
    backdrops: [],        // выбранные названия фонов
    symbols: [],          // выбранные названия символов
    sort: null,
};

let currentSearch = '';

// То же самое, но для экрана "Хранилище" — фильтруется локально по уже
// загруженному инвентарю пользователя, без похода на сервер.
const storageActiveFilters = {
    collectionIds: [],
    models: [],
    backdrops: [],
    symbols: [],
    sort: null,
};

let currentStorageSearch = '';

// Кэш справочников с сервера
let collectionsCache = [];       // [{id, name, image_url}]
let traitsCache = { models: [], backdrops: [], symbols: [] }; // зависит от выбранных коллекций

// =====================================================================
// ОБЩАЯ МОДАЛКА МУЛЬТИВЫБОРА (переиспользуется для 4 фильтров)
// =====================================================================

const filterPickerModal = document.getElementById('filterPickerModal');
const filterPickerTitle = document.getElementById('filterPickerTitle');
const filterPickerSearch = document.getElementById('filterPickerSearch');
const filterPickerSelectAll = document.getElementById('filterPickerSelectAll');
const filterPickerList = document.getElementById('filterPickerList');
const filterPickerReset = document.getElementById('filterPickerReset');
const filterPickerApply = document.getElementById('filterPickerApply');
const closeFilterPicker = document.getElementById('closeFilterPicker');

const filterButtons = {
    collection: document.getElementById('filterNftBtn'),
    model: document.getElementById('filterModelBtn'),
    backdrop: document.getElementById('filterBgBtn'),
    symbol: document.getElementById('filterSymbolBtn'),
};

const storageFilterButtons = {
    collection: document.getElementById('storageFilterNftBtn'),
    model: document.getElementById('storageFilterModelBtn'),
    backdrop: document.getElementById('storageFilterBgBtn'),
    symbol: document.getElementById('storageFilterSymbolBtn'),
};

const filterTitles = {
    collection: 'Коллекция',
    model: 'Модель',
    backdrop: 'Фон',
    symbol: 'Символ',
};

const filterStateKeys = {
    collection: 'collectionIds',
    model: 'models',
    backdrop: 'backdrops',
    symbol: 'symbols',
};

// Текущий открытый фильтр, его контекст ('market' или 'storage') и временный
// (черновой) выбор — применяется только по кнопке "Показать результаты",
// отменяется при закрытии крестиком.
let openFilterType = null;
let openFilterContext = 'market';
let draftSelection = new Set();

/** Возвращает список опций {value, label, image, colorHex, rarity} для указанного типа фильтра (Маркет). */
function getOptionsForFilterType(type) {
    if (type === 'collection') {
        return collectionsCache.map(c => ({
            value: String(c.id),
            label: c.name,
            image: c.image_url,
        }));
    }
    if (type === 'model') {
        return traitsCache.models.map(m => ({
            value: m.name,
            label: m.name,
            image: m.image_url,
            rarity: m.rarity_permille,
        }));
    }
    if (type === 'backdrop') {
        return traitsCache.backdrops.map(b => ({
            value: b.name,
            label: b.name,
            colorHex: b.color_hex,
            image: b.image_url,
            rarity: b.rarity_permille,
        }));
    }
    if (type === 'symbol') {
        return traitsCache.symbols.map(s => ({
            value: s.name,
            label: s.name,
            image: s.icon_url,
            rarity: s.rarity_permille,
        }));
    }
    return [];
}

/** Опции для фильтров Хранилища — считаются на лету из уже загруженного
 * инвентаря пользователя (без похода на сервер), сужаются по выбранным
 * коллекциям, если тип фильтра не сама коллекция (как и в Маркете).
 * В отличие от Маркета, проценты редкости здесь не показываем — это личный
 * инвентарь, а не витрина для выбора по редкости. */
function getStorageOptionsForFilterType(type) {
    let items = allInventoryItems;
    if (type !== 'collection' && storageActiveFilters.collectionIds.length) {
        items = items.filter(i => storageActiveFilters.collectionIds.includes(String(i.collection_id)));
    }

    const map = new Map();
    if (type === 'collection') {
        items.forEach(i => {
            if (!map.has(i.collection_id)) {
                map.set(i.collection_id, { value: String(i.collection_id), label: i.collection_name, image: i.collection_image });
            }
        });
    } else if (type === 'model') {
        items.forEach(i => {
            if (i.model_name && !map.has(i.model_name)) {
                map.set(i.model_name, { value: i.model_name, label: i.model_name, image: i.model_icon });
            }
        });
    } else if (type === 'backdrop') {
        items.forEach(i => {
            if (i.backdrop_name && !map.has(i.backdrop_name)) {
                // Если у фона нет цвета в базе — показываем картинку самого подарка
                // вместо пустой заглушки "?".
                const fallbackImage = i.model_icon || i.collection_image || null;
                map.set(i.backdrop_name, {
                    value: i.backdrop_name,
                    label: i.backdrop_name,
                    colorHex: i.backdrop_color || null,
                    image: i.backdrop_color ? null : fallbackImage,
                });
            }
        });
    } else if (type === 'symbol') {
        items.forEach(i => {
            if (i.symbol_name && !map.has(i.symbol_name)) {
                map.set(i.symbol_name, { value: i.symbol_name, label: i.symbol_name, image: i.symbol_icon });
            }
        });
    }
    return [...map.values()];
}

/** Опции для текущего открытого фильтра — с учётом того, какой экран (Маркет/Хранилище)
 * его открыл. */
function getOptionsForCurrentContext(type) {
    return openFilterContext === 'storage' ? getStorageOptionsForFilterType(type) : getOptionsForFilterType(type);
}

function renderFilterPickerList() {
    const search = filterPickerSearch.value.trim().toLowerCase();
    const allOptions = getOptionsForCurrentContext(openFilterType);
    let visibleOptions = search
        ? allOptions.filter(o => o.label.toLowerCase().includes(search))
        : allOptions;

    // Выбранные — наверх списка, порядок внутри каждой группы (выбрано/не выбрано)
    // сохраняем как был (алфавитный, как отдаёт бэкенд) — сортировка стабильная.
    visibleOptions = visibleOptions
        .slice()
        .sort((a, b) => (draftSelection.has(b.value) ? 1 : 0) - (draftSelection.has(a.value) ? 1 : 0));

    filterPickerList.innerHTML = '';

    if (visibleOptions.length === 0) {
        filterPickerList.innerHTML = `<li class="filter-picker-empty">Ничего не найдено</li>`;
        updateSelectAllCheckbox([]);
        return;
    }

    visibleOptions.forEach(opt => {
        const li = document.createElement('li');
        li.className = 'filter-picker-row';

        const checked = draftSelection.has(opt.value) ? 'checked' : '';

        let thumbHtml;
        if (opt.colorHex) {
            thumbHtml = `<span class="filter-picker-thumb is-color" style="background:${opt.colorHex}"></span>`;
        } else if (opt.image) {
            thumbHtml = `<img class="filter-picker-thumb" src="${opt.image}" alt="" loading="lazy">`;
        } else {
            thumbHtml = `<span class="filter-picker-thumb is-placeholder">?</span>`;
        }

        if (draftSelection.has(opt.value)) {
            li.classList.add('is-selected');
        }

        const rarityHtml = (opt.rarity !== undefined && opt.rarity !== null)
            ? `<span class="filter-picker-rarity">${opt.rarity}%</span>`
            : '';

        li.innerHTML = `
            <input type="checkbox" ${checked} data-value="${opt.value}">
            ${thumbHtml}
            <span class="filter-picker-name">${opt.label}</span>
            ${rarityHtml}
        `;

        li.addEventListener('click', (e) => {
            // Клик по самому чекбоксу уже переключает его — не переключаем дважды
            if (e.target.tagName !== 'INPUT') {
                const checkbox = li.querySelector('input[type="checkbox"]');
                checkbox.checked = !checkbox.checked;
            }
            const checkbox = li.querySelector('input[type="checkbox"]');
            if (checkbox.checked) {
                draftSelection.add(opt.value);
            } else {
                draftSelection.delete(opt.value);
            }
            // Перерисовываем список целиком — выбранный пункт переезжает наверх/обратно.
            renderFilterPickerList();
        });

        filterPickerList.appendChild(li);
    });

    updateSelectAllCheckbox(visibleOptions);
}

function updateSelectAllCheckbox(visibleOptions) {
    if (visibleOptions.length === 0) {
        filterPickerSelectAll.checked = false;
        filterPickerSelectAll.indeterminate = false;
        return;
    }
    const selectedCount = visibleOptions.filter(o => draftSelection.has(o.value)).length;
    filterPickerSelectAll.checked = selectedCount === visibleOptions.length;
    filterPickerSelectAll.indeterminate = selectedCount > 0 && selectedCount < visibleOptions.length;
}

function openFilterPicker(type, context = 'market') {
    openFilterType = type;
    openFilterContext = context;
    const filters = context === 'storage' ? storageActiveFilters : activeFilters;
    draftSelection = new Set(filters[filterStateKeys[type]]);
    filterPickerTitle.textContent = filterTitles[type];
    filterPickerSearch.value = '';
    renderFilterPickerList();
    filterPickerModal.classList.add('active');
}

function closeFilterPickerModal() {
    filterPickerModal.classList.remove('active');
    openFilterType = null;
}

Object.entries(filterButtons).forEach(([type, btn]) => {
    if (btn) btn.addEventListener('click', () => openFilterPicker(type, 'market'));
});

Object.entries(storageFilterButtons).forEach(([type, btn]) => {
    if (btn) btn.addEventListener('click', () => openFilterPicker(type, 'storage'));
});

closeFilterPicker.addEventListener('click', closeFilterPickerModal);

filterPickerModal.addEventListener('click', (e) => {
    if (e.target === filterPickerModal) closeFilterPickerModal();
});

filterPickerSearch.addEventListener('input', renderFilterPickerList);

filterPickerSelectAll.addEventListener('change', () => {
    const search = filterPickerSearch.value.trim().toLowerCase();
    const allOptions = getOptionsForCurrentContext(openFilterType);
    const visibleOptions = search
        ? allOptions.filter(o => o.label.toLowerCase().includes(search))
        : allOptions;

    if (filterPickerSelectAll.checked) {
        visibleOptions.forEach(o => draftSelection.add(o.value));
    } else {
        visibleOptions.forEach(o => draftSelection.delete(o.value));
    }
    renderFilterPickerList();
});

filterPickerReset.addEventListener('click', () => {
    draftSelection.clear();
    renderFilterPickerList();
});

filterPickerApply.addEventListener('click', async () => {
    const type = openFilterType;
    const context = openFilterContext;
    const key = filterStateKeys[type];

    if (context === 'storage') {
        storageActiveFilters[key] = [...draftSelection];
        updateFilterPillUI(type, 'storage');
        closeFilterPickerModal();
        applyStorageFilters();
        return;
    }

    activeFilters[key] = [...draftSelection];

    updateFilterPillUI(type, 'market');
    closeFilterPickerModal();

    // Если поменяли выбор коллекций (NFT) — модели/фоны/символы нужно
    // перезагрузить, сузив их до выбранных коллекций.
    if (type === 'collection') {
        await loadTraits();
    }

    await loadListings();
});

function updateFilterPillUI(type, context = 'market') {
    const btn = context === 'storage' ? storageFilterButtons[type] : filterButtons[type];
    if (!btn) return;

    const filters = context === 'storage' ? storageActiveFilters : activeFilters;
    const key = filterStateKeys[type];
    const count = filters[key].length;

    btn.innerHTML = filterTitles[type] === 'Коллекция' ? 'NFT' : filterTitles[type];
    if (count > 0) {
        btn.classList.add('has-selection');
        btn.innerHTML += ` <span class="pill-count">${count}</span>`;
    } else {
        btn.classList.remove('has-selection');
    }
}

// =====================================================================
// ЗАГРУЗКА СПРАВОЧНИКОВ И ЛИСТИНГОВ С СЕРВЕРА
// =====================================================================

async function loadCollections() {
    try {
        const res = await fetch(`${API_URL}/api/collections`);
        const data = await res.json();
        if (data.ok) collectionsCache = data.collections;
    } catch (e) {
        console.error('Не удалось загрузить коллекции:', e);
    }
}

async function loadTraits() {
    try {
        const params = new URLSearchParams();
        if (activeFilters.collectionIds.length) {
            params.set('collectionIds', activeFilters.collectionIds.join(','));
        }
        const res = await fetch(`${API_URL}/api/filters?${params.toString()}`);
        const data = await res.json();
        if (data.ok) traitsCache = data.filters;
    } catch (e) {
        console.error('Не удалось загрузить фильтры:', e);
    }
}

function buildListingsQuery() {
    const params = new URLSearchParams();
    if (activeFilters.collectionIds.length) params.set('collectionId', activeFilters.collectionIds.join(','));
    if (activeFilters.models.length) params.set('model', activeFilters.models.join(','));
    if (activeFilters.backdrops.length) params.set('backdrop', activeFilters.backdrops.join(','));
    if (activeFilters.symbols.length) params.set('symbol', activeFilters.symbols.join(','));
    if (currentSearch) params.set('search', currentSearch);
    if (activeFilters.sort) params.set('sort', activeFilters.sort);
    return params.toString();
}

async function loadListings() {
    try {
        const res = await fetch(`${API_URL}/api/listings?${buildListingsQuery()}`);
        const data = await res.json();
        if (data.ok) renderGrid(data.listings);
    } catch (e) {
        console.error('Не удалось загрузить листинги:', e);
        grid.innerHTML = `<div class="empty-state">Не удалось загрузить маркет. Проверьте соединение.</div>`;
    }
}

function renderGrid(listings) {
    grid.innerHTML = '';
    listingsById.clear();

    if (!listings || listings.length === 0) {
        grid.innerHTML = `<div class="empty-state">Пока нет активных лотов по выбранным фильтрам</div>`;
        return;
    }

    listings.forEach(item => {
        listingsById.set(String(item.id), item);

        const card = document.createElement('div');
        card.className = 'nft-card';

        const bg = item.backdrop_color || '#333';
        const image = item.model_icon || item.collection_image || '';

        card.innerHTML = `
            <div class="nft-image-container" style="background-color: ${bg};">
                ${image ? `<img src="${image}" class="nft-img" alt="${item.collection_name}">` : ''}
            </div>
            <div class="nft-info">
                <div class="nft-title">${item.collection_name}</div>
                <div class="nft-number">#${item.gift_number}</div>
                <div class="nft-bottom">
                    <div class="nft-price">💎 ${item.price}</div>
                    <div class="nft-actions">
                        <button class="order-quick-btn" data-listing-id="${item.id}" title="Создать ордер на этот трейт">🧾</button>
                        <button class="cart-btn" data-listing-id="${item.id}">🛒</button>
                    </div>
                </div>
            </div>
        `;
        grid.appendChild(card);
    });
}

// Кэш текущих загруженных лотов по id — чтобы открыть детальную карточку
// без повторного запроса к серверу, у нас уже есть все данные из /api/listings.
const listingsById = new Map();

// === Детальная карточка лота ===
const listingDetailModal = document.getElementById('listingDetailModal');
const closeListingDetailBtn = document.getElementById('closeListingDetail');
const listingDetailImageWrap = document.getElementById('listingDetailImageWrap');
const listingDetailImage = document.getElementById('listingDetailImage');
const listingDetailTitle = document.getElementById('listingDetailTitle');
const listingDetailNumber = document.getElementById('listingDetailNumber');
const listingDetailCollection = document.getElementById('listingDetailCollection');
const listingDetailModel = document.getElementById('listingDetailModel');
const listingDetailBackdrop = document.getElementById('listingDetailBackdrop');
const listingDetailSymbol = document.getElementById('listingDetailSymbol');
const listingDetailPrice = document.getElementById('listingDetailPrice');
const listingDetailBuyBtn = document.getElementById('listingDetailBuyBtn');
const listingDetailCancelBtn = document.getElementById('listingDetailCancelBtn');

let currentDetailListingId = null;

function traitLabel(name) {
    return name || '—';
}

function openListingDetail(item, opts = {}) {
    currentDetailListingId = item.id;

    // Разные ручки бэкенда называют картинку модели по-разному
    // (model_icon у листингов маркета/инвентаря, model_image у деталей
    // трейда) — берём что есть, иначе раньше подставлялась общая картинка
    // коллекции вместо реальной картинки подарка.
    const image = item.model_icon || item.model_image || item.collection_image || '';
    listingDetailImageWrap.style.backgroundColor = item.backdrop_color || '#333';
    listingDetailImage.src = image;
    listingDetailTitle.textContent = item.collection_name;
    listingDetailNumber.textContent = `#${item.gift_number}`;
    listingDetailCollection.textContent = item.collection_name;
    listingDetailModel.textContent = traitLabel(item.model_name);
    listingDetailBackdrop.textContent = traitLabel(item.backdrop_name);
    listingDetailSymbol.textContent = traitLabel(item.symbol_name);
    listingDetailPrice.textContent = item.price;

    // Режим просмотра (например, предмет обмена, который не выставлен на
    // продажу): показываем только трейты, без кнопок "Купить"/"Снять с продажи".
    if (opts.viewOnly) {
        if (listingDetailBuyBtn) listingDetailBuyBtn.style.display = 'none';
        if (listingDetailCancelBtn) listingDetailCancelBtn.style.display = 'none';
    } else {
        // Свой лот нельзя купить — вместо кнопки "Купить" показываем "Снять с продажи".
        const isOwn = currentTgId != null && item.owner_tg_id === currentTgId;
        if (listingDetailBuyBtn) listingDetailBuyBtn.style.display = isOwn ? 'none' : '';
        if (listingDetailCancelBtn) listingDetailCancelBtn.style.display = isOwn ? '' : 'none';
    }

    listingDetailModal.style.display = 'flex';
}

grid.addEventListener('click', (e) => {
    const cartBtn = e.target.closest('.cart-btn');
    if (cartBtn) {
        const item = listingsById.get(cartBtn.dataset.listingId);
        if (!item) return;

        openListingDetail(item);
        return;
    }

    const orderBtn = e.target.closest('.order-quick-btn');
    if (orderBtn) {
        const item = listingsById.get(orderBtn.dataset.listingId);
        if (item) {
            openQuickOrderModal(item);
        }
        return;
    }
});

// === Быстрое создание ордера на трейт конкретного айтема (кнопка 🧾) ===
// Оформлена как карточка покупки (картинка + трейты), но вместо "Купить"
// тут поле для своей цены — ордер создаётся на любой айтем с такими же
// моделью/фоном/символом, а не именно на этот экземпляр.
const quickOrderModal = document.getElementById('quickOrderModal');
const closeQuickOrderModalBtn = document.getElementById('closeQuickOrderModal');
const quickOrderImageWrap = document.getElementById('quickOrderImageWrap');
const quickOrderImage = document.getElementById('quickOrderImage');
const quickOrderTitle = document.getElementById('quickOrderTitle');
const quickOrderNumber = document.getElementById('quickOrderNumber');
const quickOrderCollection = document.getElementById('quickOrderCollection');
const quickOrderModel = document.getElementById('quickOrderModel');
const quickOrderBackdrop = document.getElementById('quickOrderBackdrop');
const quickOrderSymbol = document.getElementById('quickOrderSymbol');
const quickOrderPriceInput = document.getElementById('quickOrderPrice');
const quickOrderConfirmBtn = document.getElementById('quickOrderConfirmBtn');

let quickOrderPreset = null;

function openQuickOrderModal(item) {
    if (!authToken) {
        alert('Не удалось подтвердить личность. Попробуйте перезайти.');
        return;
    }

    quickOrderPreset = {
        collectionId: item.collection_id,
        modelId: item.model_id,
        backdropId: item.backdrop_id,
        symbolId: item.symbol_id,
    };

    const image = item.model_icon || item.collection_image || '';
    quickOrderImageWrap.style.backgroundColor = item.backdrop_color || '#333';
    quickOrderImage.src = image;
    quickOrderTitle.textContent = item.collection_name;
    quickOrderNumber.textContent = `по трейтам как у #${item.gift_number}`;
    quickOrderCollection.textContent = item.collection_name;
    quickOrderModel.textContent = traitLabel(item.model_name);
    quickOrderBackdrop.textContent = traitLabel(item.backdrop_name);
    quickOrderSymbol.textContent = traitLabel(item.symbol_name);
    quickOrderPriceInput.value = '';

    quickOrderModal.style.display = 'flex';
}

if (closeQuickOrderModalBtn && quickOrderModal) {
    closeQuickOrderModalBtn.addEventListener('click', () => {
        quickOrderModal.style.display = 'none';
        quickOrderPreset = null;
    });
}

if (quickOrderConfirmBtn) {
    quickOrderConfirmBtn.addEventListener('click', async () => {
        if (!quickOrderPreset) return;

        const maxPrice = parseFloat(quickOrderPriceInput.value);
        if (!maxPrice || maxPrice <= 0) {
            alert('Укажите корректную цену');
            return;
        }
        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        quickOrderConfirmBtn.disabled = true;

        try {
            const res = await fetch(`${API_URL}/api/orders`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify({
                    collectionId: quickOrderPreset.collectionId,
                    modelId: quickOrderPreset.modelId,
                    backdropId: quickOrderPreset.backdropId,
                    symbolId: quickOrderPreset.symbolId,
                    maxPrice,
                }),
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось создать ордер');
                return;
            }

            updateBalanceUI(data.balance);
            alert('Ордер создан!');
            quickOrderModal.style.display = 'none';
            quickOrderPreset = null;
            quickOrderPriceInput.value = '';

            await loadActiveOrders();
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        } finally {
            quickOrderConfirmBtn.disabled = false;
        }
    });
}

if (closeListingDetailBtn && listingDetailModal) {
    closeListingDetailBtn.addEventListener('click', () => {
        listingDetailModal.style.display = 'none';
        currentDetailListingId = null;
    });
}

if (listingDetailBuyBtn) {
    listingDetailBuyBtn.addEventListener('click', async () => {
        if (!currentDetailListingId) return;

        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        listingDetailBuyBtn.disabled = true;

        try {
            const res = await fetch(`${API_URL}/api/listings/${currentDetailListingId}/buy`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` },
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось купить лот');
                listingDetailBuyBtn.disabled = false;
                return;
            }

            updateBalanceUI(data.balance);
            alert('Покупка успешна!');
            listingDetailModal.style.display = 'none';
            currentDetailListingId = null;
            await loadListings();
        } catch (err) {
            alert('Ошибка соединения с сервером');
            console.error(err);
        } finally {
            listingDetailBuyBtn.disabled = false;
        }
    });
}

if (listingDetailCancelBtn) {
    listingDetailCancelBtn.addEventListener('click', async () => {
        if (!currentDetailListingId) return;

        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        listingDetailCancelBtn.disabled = true;

        try {
            // Сервер сам проверяет, что это лот текущего пользователя — чужой
            // лот снять не даст (403 "Это не ваш листинг").
            const res = await fetch(`${API_URL}/api/listings/${currentDetailListingId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${authToken}` },
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось снять лот с продажи');
                listingDetailCancelBtn.disabled = false;
                return;
            }

            alert('Лот снят с продажи и возвращён в Хранилище');
            listingDetailModal.style.display = 'none';
            currentDetailListingId = null;
            await loadListings();
            if (typeof loadInventory === 'function') {
                await loadInventory();
            }
        } catch (err) {
            alert('Ошибка соединения с сервером');
            console.error(err);
        } finally {
            listingDetailCancelBtn.disabled = false;
        }
    });
}

// =====================================================================
// ИСТОРИЯ ОПЕРАЦИЙ
// =====================================================================

const historyList = document.getElementById('historyList');
const historyById = new Map(); // кэш загруженной истории по id — для детальной карточки

const historyTypeLabels = {
    deposit: 'Пополнение баланса',
    withdraw: 'Вывод средств',
    buy: 'Покупка NFT',
    sell: 'Продажа NFT',
    trade_in: 'Получено в обмене',
    trade_out: 'Отдано в обмене',
    trade_fee: 'Комиссия за обмен',
    trade_fee_refund: 'Возврат резерва обмена',
    trade_topup_in: 'Доплата в обмене (получено)',
    trade_topup_out: 'Доплата в обмене (отдано)',
};

const historyTypeIcons = {
    deposit: '➕',
    withdraw: '➖',
};

/** Сервер отдаёт время в UTC как "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now')) —
 * добавляем "T"/"Z", чтобы Date() распознал строку как UTC, а не как локальное время. */
function formatHistoryDate(isoString) {
    if (!isoString) return '';
    const iso = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    const date = new Date(iso);
    if (isNaN(date.getTime())) return isoString;

    const datePart = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timePart = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `${datePart} · ${timePart}`;
}

function formatAmount(amount) {
    const sign = amount > 0 ? '+' : '';
    return `${sign}${amount} 💎`;
}

function renderHistoryList(items) {
    historyList.innerHTML = '';
    historyById.clear();

    if (!items || items.length === 0) {
        historyList.innerHTML = `<div class="empty-state">Пока нет операций</div>`;
        return;
    }

    items.forEach(item => {
        historyById.set(String(item.id), item);

        // "Картинка подарка" и клик на полную карточку доступны только для покупок/продаж —
        // у пополнения/вывода нет привязанного NFT.
        const isGift = item.type === 'buy' || item.type === 'sell' || item.type === 'trade_in' || item.type === 'trade_out';

        const li = document.createElement('li');
        li.className = 'history-row' + (isGift ? ' has-gift' : '');
        if (isGift) li.dataset.historyId = item.id;

        let thumbHtml;
        if (isGift) {
            const image = item.model_image || item.collection_image || '';
            const bg = item.backdrop_color || '#333';
            thumbHtml = `
                <div class="history-thumb" style="background-color:${bg};">
                    ${image ? `<img src="${image}" alt="">` : ''}
                </div>`;
        } else {
            thumbHtml = `<div class="history-thumb is-icon">${historyTypeIcons[item.type] || '💎'}</div>`;
        }

        const title = isGift ? item.collection_name : (historyTypeLabels[item.type] || item.type);
        const metaParts = [];
        if (isGift && item.gift_number) metaParts.push(`#${item.gift_number}`);
        metaParts.push(formatHistoryDate(item.created_at));

        const amountClass = item.amount >= 0 ? 'positive' : 'negative';

        li.innerHTML = `
            ${thumbHtml}
            <div class="history-info">
                <div class="history-name">${title}</div>
                <div class="history-meta">${metaParts.join(' · ')}</div>
            </div>
            <div class="history-amount ${amountClass}">${formatAmount(item.amount)}</div>
        `;

        historyList.appendChild(li);
    });
}

async function loadHistory() {
    if (!historyList) return;

    if (!authToken) {
        historyList.innerHTML = `<div class="empty-state">Не удалось подтвердить личность. Попробуйте перезайти.</div>`;
        return;
    }

    historyList.innerHTML = `<div class="empty-state">Загрузка...</div>`;

    try {
        const res = await fetch(`${API_URL}/api/history`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
        });
        const data = await res.json();

        if (!data.ok) {
            historyList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить историю'}</div>`;
            return;
        }

        renderHistoryList(data.history);
    } catch (e) {
        historyList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

// === Детальная карточка операции (открывается по клику на картинку подарка) ===
const historyDetailModal = document.getElementById('historyDetailModal');
const closeHistoryDetailBtn = document.getElementById('closeHistoryDetail');
const historyDetailImageWrap = document.getElementById('historyDetailImageWrap');
const historyDetailImage = document.getElementById('historyDetailImage');
const historyDetailTitle = document.getElementById('historyDetailTitle');
const historyDetailNumber = document.getElementById('historyDetailNumber');
const historyDetailCollection = document.getElementById('historyDetailCollection');
const historyDetailModelEl = document.getElementById('historyDetailModel');
const historyDetailBackdrop = document.getElementById('historyDetailBackdrop');
const historyDetailSymbol = document.getElementById('historyDetailSymbol');
const historyDetailType = document.getElementById('historyDetailType');
const historyDetailDate = document.getElementById('historyDetailDate');
const historyDetailAmount = document.getElementById('historyDetailAmount');

function openHistoryDetail(item) {
    const image = item.model_image || item.collection_image || '';
    historyDetailImageWrap.style.backgroundColor = item.backdrop_color || '#333';
    historyDetailImage.src = image;
    historyDetailTitle.textContent = item.collection_name;
    historyDetailNumber.textContent = item.gift_number ? `#${item.gift_number}` : '';
    historyDetailCollection.textContent = item.collection_name || '—';
    historyDetailModelEl.textContent = traitLabel(item.model_name);
    historyDetailBackdrop.textContent = traitLabel(item.backdrop_name);
    historyDetailSymbol.textContent = traitLabel(item.symbol_name);
    historyDetailType.textContent = historyTypeLabels[item.type] || item.type;
    historyDetailDate.textContent = formatHistoryDate(item.created_at);

    const amountClass = item.amount >= 0 ? 'positive' : 'negative';
    historyDetailAmount.className = `history-detail-amount ${amountClass}`;
    historyDetailAmount.textContent = formatAmount(item.amount);

    historyDetailModal.style.display = 'flex';
}

if (historyList) {
    historyList.addEventListener('click', (e) => {
        const row = e.target.closest('.history-row.has-gift');
        if (!row) return;
        const item = historyById.get(row.dataset.historyId);
        if (!item) return;
        openHistoryDetail(item);
    });
}

if (closeHistoryDetailBtn && historyDetailModal) {
    closeHistoryDetailBtn.addEventListener('click', () => {
        historyDetailModal.style.display = 'none';
    });
}

// =====================================================================
// ОРДЕРА НА ПОКУПКУ
// =====================================================================

const ordersActiveList = document.getElementById('ordersActiveList');
const ordersHistoryList = document.getElementById('ordersHistoryList');
const ordersOffersList = document.getElementById('ordersOffersList');
const ordersTabs = document.getElementById('ordersTabs');

const ordersActiveById = new Map();
const ordersHistoryById = new Map();
const myOffersById = new Map();

const orderStatusLabels = {
    active: 'Активен',
    filled: 'Исполнен',
    cancelled: 'Отменён',
};

/** Короткое описание запрошенных трейтов ордера — пустое поле в БД значит "любой". */
function orderCriteriaLabel(item) {
    const parts = [];
    parts.push(item.model_name ? item.model_name : 'Любая модель');
    parts.push(item.backdrop_name ? item.backdrop_name : 'Любой фон');
    parts.push(item.symbol_name ? item.symbol_name : 'Любой символ');
    return parts.join(' · ');
}

function renderOrdersList(container, cacheMap, items, { showCancel }) {
    container.innerHTML = '';
    cacheMap.clear();

    if (!items || items.length === 0) {
        container.innerHTML = `<div class="empty-state">${showCancel ? 'Нет активных ордеров' : 'История ордеров пуста'}</div>`;
        return;
    }

    items.forEach(item => {
        cacheMap.set(String(item.id), item);

        const image = item.model_image || item.collection_image || '';
        const bg = item.backdrop_color || '#333';

        const li = document.createElement('li');
        li.className = 'history-row has-gift';
        li.dataset.orderId = item.id;

        const displayPrice = (item.status === 'filled' && item.matched_price != null) ? item.matched_price : item.max_price;

        const rightHtml = showCancel
            ? `<div class="order-row-price">
                   <span>💎 ${displayPrice}</span>
                   <button class="order-row-cancel" data-cancel-order-id="${item.id}">Отменить</button>
               </div>`
            : `<div class="order-row-price">
                   <span>💎 ${displayPrice}</span>
                   <span class="order-row-status is-${item.status}">${orderStatusLabels[item.status] || item.status}</span>
               </div>`;

        li.innerHTML = `
            <div class="history-thumb" style="background-color:${bg};">
                ${image ? `<img src="${image}" alt="">` : ''}
            </div>
            <div class="history-info">
                <div class="history-name">${item.collection_name}</div>
                <div class="history-meta">${orderCriteriaLabel(item)}</div>
                <div class="history-meta">${formatHistoryDate(item.created_at)}</div>
            </div>
            ${rightHtml}
        `;

        container.appendChild(li);
    });
}

// Счётчик "Ордера" на экране профиля — держим в актуальном состоянии
// отдельной лёгкой функцией, чтобы обновлять его даже когда список активных
// ордеров не отображается (профиль открыт, а не вкладка "Ордеры").
const ordersStatValueEl = document.querySelector('.orders-stat-value');

function setOrdersStatValue(count) {
    if (ordersStatValueEl) ordersStatValueEl.textContent = String(count);
}

async function refreshOrdersStat() {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_URL}/api/orders`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (data.ok) setOrdersStatValue(data.orders.length);
    } catch (e) {
        console.error('Не удалось обновить счётчик ордеров:', e);
    }
}

async function loadActiveOrders() {
    if (!ordersActiveList) return;
    if (!authToken) {
        ordersActiveList.innerHTML = `<div class="empty-state">Не удалось подтвердить личность. Попробуйте перезайти.</div>`;
        return;
    }
    ordersActiveList.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/orders`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!data.ok) {
            ordersActiveList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить ордера'}</div>`;
            return;
        }
        renderOrdersList(ordersActiveList, ordersActiveById, data.orders, { showCancel: true });
        // Тот же ответ уже содержит актуальное число активных ордеров — обновляем
        // счётчик в профиле заодно, без лишнего запроса.
        setOrdersStatValue(data.orders.length);
    } catch (e) {
        ordersActiveList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

async function loadOrderHistory() {
    if (!ordersHistoryList) return;
    if (!authToken) {
        ordersHistoryList.innerHTML = `<div class="empty-state">Не удалось подтвердить личность. Попробуйте перезайти.</div>`;
        return;
    }
    ordersHistoryList.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/orders/history`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!data.ok) {
            ordersHistoryList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить историю ордеров'}</div>`;
            return;
        }
        renderOrdersList(ordersHistoryList, ordersHistoryById, data.orders, { showCancel: false });
    } catch (e) {
        ordersHistoryList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

// === Предложения покупателей по МОИМ активным лотам ===
function renderMyOffers(offers) {
    ordersOffersList.innerHTML = '';
    myOffersById.clear();

    if (!offers || offers.length === 0) {
        ordersOffersList.innerHTML = `<div class="empty-state">Пока нет предложений на ваши лоты</div>`;
        return;
    }

    offers.forEach(offer => {
        myOffersById.set(String(offer.order_id), offer);

        const image = offer.model_icon || offer.collection_image || '';
        const bg = offer.backdrop_color || '#333';

        const li = document.createElement('li');
        li.className = 'history-row has-gift';

        li.innerHTML = `
            <div class="history-thumb" style="background-color:${bg};">
                ${image ? `<img src="${image}" alt="">` : ''}
            </div>
            <div class="history-info">
                <div class="history-name">${offer.collection_name} #${offer.gift_number}</div>
                <div class="history-meta">Ваша цена: 💎 ${offer.listing_price}</div>
                <div class="history-meta">${formatHistoryDate(offer.offer_created_at)}</div>
            </div>
            <div class="order-row-price">
                <span>💎 ${offer.max_price}</span>
                <button class="offer-accept-btn" data-order-id="${offer.order_id}" data-listing-id="${offer.listing_id}">Продать</button>
            </div>
        `;

        ordersOffersList.appendChild(li);
    });
}

async function loadMyOffers() {
    if (!ordersOffersList) return;
    if (!authToken) {
        ordersOffersList.innerHTML = `<div class="empty-state">Не удалось подтвердить личность. Попробуйте перезайти.</div>`;
        return;
    }
    ordersOffersList.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/my-offers`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!data.ok) {
            ordersOffersList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить предложения'}</div>`;
            return;
        }
        renderMyOffers(data.offers);
    } catch (e) {
        ordersOffersList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

if (ordersOffersList) {
    ordersOffersList.addEventListener('click', async (e) => {
        const btn = e.target.closest('.offer-accept-btn');
        if (!btn) return;

        const listingId = btn.dataset.listingId;
        const orderId = btn.dataset.orderId;

        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }
        if (!confirm('Продать этот лот по цене предложения?')) return;

        btn.disabled = true;

        try {
            const res = await fetch(`${API_URL}/api/listings/${listingId}/accept-offer`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify({ orderId }),
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось продать лот');
                btn.disabled = false;
                return;
            }

            updateBalanceUI(data.balance);
            alert('Лот продан!');
            await loadMyOffers();
            await loadListings();
        } catch (err) {
            alert('Ошибка соединения с сервером');
            console.error(err);
            btn.disabled = false;
        }
    });
}

// === Переключение вкладок "Активные" / "История" / "Предложения" ===
if (ordersTabs) {
    ordersTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.orders-tab');
        if (!btn) return;

        const tab = btn.getAttribute('data-orders-tab');
        ordersTabs.querySelectorAll('.orders-tab').forEach(t => t.classList.toggle('active', t === btn));
        ordersActiveList.style.display = tab === 'active' ? '' : 'none';
        ordersHistoryList.style.display = tab === 'history' ? '' : 'none';
        ordersOffersList.style.display = tab === 'offers' ? '' : 'none';
    });
}

// === Детальная карточка ордера (открывается по клику на аватарку/строку, в т.ч. в истории) ===
const orderDetailModal = document.getElementById('orderDetailModal');
const closeOrderDetailBtn = document.getElementById('closeOrderDetail');
const orderDetailImageWrap = document.getElementById('orderDetailImageWrap');
const orderDetailImage = document.getElementById('orderDetailImage');
const orderDetailTitle = document.getElementById('orderDetailTitle');
const orderDetailNumber = document.getElementById('orderDetailNumber');
const orderDetailCollection = document.getElementById('orderDetailCollection');
const orderDetailModelEl = document.getElementById('orderDetailModel');
const orderDetailBackdrop = document.getElementById('orderDetailBackdrop');
const orderDetailSymbol = document.getElementById('orderDetailSymbol');
const orderDetailPrice = document.getElementById('orderDetailPrice');
const orderDetailStatus = document.getElementById('orderDetailStatus');
const orderDetailCreated = document.getElementById('orderDetailCreated');
const orderDetailClosedRow = document.getElementById('orderDetailClosedRow');
const orderDetailClosedLabel = document.getElementById('orderDetailClosedLabel');
const orderDetailClosed = document.getElementById('orderDetailClosed');
const orderDetailCancelBtn = document.getElementById('orderDetailCancelBtn');

let currentDetailOrderId = null;

function openOrderDetail(item) {
    currentDetailOrderId = item.id;

    const image = item.model_image || item.collection_image || '';
    orderDetailImageWrap.style.backgroundColor = item.backdrop_color || '#333';
    orderDetailImage.src = image;
    orderDetailTitle.textContent = item.collection_name;
    orderDetailNumber.textContent = (item.status === 'filled' && item.matched_gift_number) ? `#${item.matched_gift_number}` : '';
    orderDetailCollection.textContent = item.collection_name || '—';
    orderDetailModelEl.textContent = traitLabel(item.model_name) === '—' ? 'Любая' : item.model_name;
    orderDetailBackdrop.textContent = traitLabel(item.backdrop_name) === '—' ? 'Любой' : item.backdrop_name;
    orderDetailSymbol.textContent = traitLabel(item.symbol_name) === '—' ? 'Любой' : item.symbol_name;

    const displayPrice = (item.status === 'filled' && item.matched_price != null) ? item.matched_price : item.max_price;
    orderDetailPrice.textContent = `💎 ${displayPrice}`;
    orderDetailStatus.textContent = orderStatusLabels[item.status] || item.status;

    orderDetailCreated.textContent = formatHistoryDate(item.created_at);

    if (item.status === 'active') {
        orderDetailClosedRow.style.display = 'none';
        orderDetailCancelBtn.style.display = '';
    } else {
        orderDetailClosedRow.style.display = '';
        orderDetailClosedLabel.textContent = item.status === 'filled' ? 'Исполнен' : 'Отменён';
        orderDetailClosed.textContent = formatHistoryDate(item.closed_at);
        orderDetailCancelBtn.style.display = 'none';
    }

    orderDetailModal.style.display = 'flex';
}

async function cancelOrder(orderId) {
    if (!authToken) {
        alert('Не удалось подтвердить личность. Попробуйте перезайти.');
        return;
    }
    try {
        const res = await fetch(`${API_URL}/api/orders/${orderId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` },
        });
        const data = await res.json();
        if (!data.ok) {
            alert(data.error || 'Не удалось отменить ордер');
            return;
        }
        updateBalanceUI(data.balance);
        await loadActiveOrders();
        await loadOrderHistory();
    } catch (e) {
        alert('Ошибка соединения с сервером');
        console.error(e);
    }
}

function bindOrdersListClicks(container, cacheMap) {
    if (!container) return;
    container.addEventListener('click', (e) => {
        const cancelBtn = e.target.closest('.order-row-cancel');
        if (cancelBtn) {
            cancelOrder(cancelBtn.dataset.cancelOrderId);
            return;
        }
        const row = e.target.closest('.history-row[data-order-id]');
        if (!row) return;
        const item = cacheMap.get(row.dataset.orderId);
        if (!item) return;
        openOrderDetail(item);
    });
}

bindOrdersListClicks(ordersActiveList, ordersActiveById);
bindOrdersListClicks(ordersHistoryList, ordersHistoryById);

if (closeOrderDetailBtn && orderDetailModal) {
    closeOrderDetailBtn.addEventListener('click', () => {
        orderDetailModal.style.display = 'none';
        currentDetailOrderId = null;
    });
}

if (orderDetailCancelBtn) {
    orderDetailCancelBtn.addEventListener('click', async () => {
        if (!currentDetailOrderId) return;
        await cancelOrder(currentDetailOrderId);
        orderDetailModal.style.display = 'none';
        currentDetailOrderId = null;
    });
}

// === Модалка создания ордера ===
const createOrderModal = document.getElementById('createOrderModal');
const openCreateOrderBtn = document.getElementById('openCreateOrderBtn');
const closeCreateOrderModalBtn = document.getElementById('closeCreateOrderModal');
const orderCollectionSelect = document.getElementById('orderCollectionSelect');
const orderModelSelect = document.getElementById('orderModelSelect');
const orderBackdropSelect = document.getElementById('orderBackdropSelect');
const orderSymbolSelect = document.getElementById('orderSymbolSelect');
const orderMaxPriceInput = document.getElementById('orderMaxPrice');
const confirmCreateOrderBtn = document.getElementById('confirmCreateOrderBtn');

let orderTraitsCache = { models: [], backdrops: [], symbols: [] };

function resetOrderForm() {
    orderCollectionSelect.value = '';
    orderModelSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
    orderBackdropSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
    orderSymbolSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
    orderModelSelect.disabled = true;
    orderBackdropSelect.disabled = true;
    orderSymbolSelect.disabled = true;
    orderMaxPriceInput.value = '';
    orderTraitsCache = { models: [], backdrops: [], symbols: [] };
}

async function populateOrderCollectionSelect() {
    orderCollectionSelect.innerHTML = '<option value="">Выберите коллекцию</option>';
    collectionsCache.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        orderCollectionSelect.appendChild(opt);
    });
}

// Подгружает трейты (с id) выбранной коллекции в селекты модалки ордера;
// вынесено в отдельную функцию, чтобы вызывать и из события change, и
// программно — при открытии модалки с предзаполненным трейтом с карточки.
async function loadOrderTraitsForCollection(collectionId) {
    orderModelSelect.innerHTML = '<option value="">Загрузка...</option>';
    orderBackdropSelect.innerHTML = '<option value="">Загрузка...</option>';
    orderSymbolSelect.innerHTML = '<option value="">Загрузка...</option>';

    try {
        const res = await fetch(`${API_URL}/api/collections/${collectionId}/filters`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Не удалось загрузить трейты');

        orderTraitsCache = data.filters;

        fillListingSelect(orderModelSelect, orderTraitsCache.models, 'Любая модель', m =>
            m.rarity_permille != null ? `${m.name} (${m.rarity_permille}%)` : m.name);
        fillListingSelect(orderBackdropSelect, orderTraitsCache.backdrops, 'Любой фон', b =>
            b.rarity_permille != null ? `${b.name} (${b.rarity_permille}%)` : b.name);
        fillListingSelect(orderSymbolSelect, orderTraitsCache.symbols, 'Любой символ', s =>
            s.rarity_permille != null ? `${s.name} (${s.rarity_permille}%)` : s.name);

        // В отличие от формы выставления лота, здесь трейты не обязательны —
        // "Любая/Любой" остаётся доступным вариантом, поэтому селект не блокируем.
        orderModelSelect.disabled = false;
        orderBackdropSelect.disabled = false;
        orderSymbolSelect.disabled = false;
    } catch (e) {
        console.error('Не удалось загрузить трейты коллекции:', e);
        orderModelSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        orderBackdropSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        orderSymbolSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
    }
}

// Открывает модалку создания ордера. Если передан preset ({collectionId,
// modelId, backdropId, symbolId}) — сразу подгружает трейты этой коллекции
// и выставляет конкретные модель/фон/символ (используется кнопкой 🧾 на
// карточке маркета — "создать ордер именно на этот трейт").
async function openCreateOrderModal(preset = null) {
    if (!authToken) {
        alert('Не удалось подтвердить личность. Попробуйте перезайти.');
        return;
    }

    resetOrderForm();
    await populateOrderCollectionSelect();

    if (preset && preset.collectionId) {
        orderCollectionSelect.value = String(preset.collectionId);
        await loadOrderTraitsForCollection(preset.collectionId);
        if (preset.modelId) orderModelSelect.value = String(preset.modelId);
        if (preset.backdropId) orderBackdropSelect.value = String(preset.backdropId);
        if (preset.symbolId) orderSymbolSelect.value = String(preset.symbolId);
    }

    createOrderModal.style.display = 'flex';
}

if (openCreateOrderBtn && createOrderModal) {
    openCreateOrderBtn.addEventListener('click', () => openCreateOrderModal());
}

if (closeCreateOrderModalBtn && createOrderModal) {
    closeCreateOrderModalBtn.addEventListener('click', () => {
        createOrderModal.style.display = 'none';
    });
}

// При ручном выборе коллекции в модалке — подгружаем её трейты.
orderCollectionSelect.addEventListener('change', async () => {
    const collectionId = orderCollectionSelect.value;

    if (!collectionId) {
        orderModelSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
        orderBackdropSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
        orderSymbolSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
        orderModelSelect.disabled = true;
        orderBackdropSelect.disabled = true;
        orderSymbolSelect.disabled = true;
        return;
    }

    await loadOrderTraitsForCollection(collectionId);
});

if (confirmCreateOrderBtn) {
    confirmCreateOrderBtn.addEventListener('click', async () => {
        const collectionId = parseInt(orderCollectionSelect.value, 10);
        const modelId = orderModelSelect.value ? parseInt(orderModelSelect.value, 10) : null;
        const backdropId = orderBackdropSelect.value ? parseInt(orderBackdropSelect.value, 10) : null;
        const symbolId = orderSymbolSelect.value ? parseInt(orderSymbolSelect.value, 10) : null;
        const maxPrice = parseFloat(orderMaxPriceInput.value);

        if (!collectionId) {
            alert('Выберите коллекцию');
            return;
        }
        if (!maxPrice || maxPrice <= 0) {
            alert('Укажите корректную цену');
            return;
        }
        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        confirmCreateOrderBtn.disabled = true;

        try {
            const res = await fetch(`${API_URL}/api/orders`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify({ collectionId, modelId, backdropId, symbolId, maxPrice }),
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось создать ордер');
                return;
            }

            updateBalanceUI(data.balance);
            alert('Ордер создан!');
            createOrderModal.style.display = 'none';
            resetOrderForm();

            await loadActiveOrders();
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        } finally {
            confirmCreateOrderBtn.disabled = false;
        }
    });
}

// =====================================================================
// ПОИСК И СОРТИРОВКА
// =====================================================================

let searchDebounceTimer = null;
searchInput.addEventListener('input', (e) => {
    currentSearch = e.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadListings, 300);
});

const closeSortModalBtn = document.getElementById('closeSortModal');
const sortList = document.getElementById('sortList');
const sortResetBtn = document.getElementById('sortReset');
const sortApplyBtn = document.getElementById('sortApply');
const sortRows = Array.from(sortList.querySelectorAll('.filter-picker-row'));

// Черновой выбор сортировки — применяется только по кнопке "Показать результаты",
// отменяется при закрытии крестиком (как и в filterPickerModal).
// Сортировка по смыслу может быть только одна, поэтому выбор нового варианта
// снимает предыдущий — но визуально это те же квадратики-чекбоксы, что и в фильтрах.
let draftSort = activeFilters.sort;

function renderSortList() {
    sortRows.forEach(row => {
        const checkbox = row.querySelector('input[type="checkbox"]');
        const isChecked = row.getAttribute('data-sort') === draftSort;
        checkbox.checked = isChecked;
        row.classList.toggle('is-selected', isChecked);
    });
}

sortRows.forEach(row => {
    row.addEventListener('click', (e) => {
        const value = row.getAttribute('data-sort');
        draftSort = (draftSort === value) ? null : value;
        renderSortList();
    });
});

sortTriggerBtn.addEventListener('click', () => {
    draftSort = activeFilters.sort;
    renderSortList();
    sortModal.classList.add('active');
});

if (closeSortModalBtn) {
    closeSortModalBtn.addEventListener('click', () => {
        sortModal.classList.remove('active');
    });
}

sortModal.addEventListener('click', (e) => {
    if (e.target === sortModal) {
        sortModal.classList.remove('active');
    }
});

if (sortResetBtn) {
    sortResetBtn.addEventListener('click', () => {
        draftSort = null;
        renderSortList();
    });
}

if (sortApplyBtn) {
    sortApplyBtn.addEventListener('click', () => {
        activeFilters.sort = draftSort;
        sortModal.classList.remove('active');
        loadListings();
    });
}

// === То же самое для экрана "Хранилище" (поиск + сортировка) ===

const storageSearchInput = document.getElementById('storageSearchInput');
let storageSearchDebounceTimer = null;
if (storageSearchInput) {
    storageSearchInput.addEventListener('input', (e) => {
        currentStorageSearch = e.target.value;
        clearTimeout(storageSearchDebounceTimer);
        storageSearchDebounceTimer = setTimeout(applyStorageFilters, 300);
    });
}

const storageSortTriggerBtn = document.getElementById('storageSortTriggerBtn');
const storageSortModal = document.getElementById('storageSortModal');
const closeStorageSortModalBtn = document.getElementById('closeStorageSortModal');
const storageSortList = document.getElementById('storageSortList');
const storageSortResetBtn = document.getElementById('storageSortReset');
const storageSortApplyBtn = document.getElementById('storageSortApply');
const storageSortRows = storageSortList ? Array.from(storageSortList.querySelectorAll('.filter-picker-row')) : [];

let draftStorageSort = storageActiveFilters.sort;

function renderStorageSortList() {
    storageSortRows.forEach(row => {
        const checkbox = row.querySelector('input[type="checkbox"]');
        const isChecked = row.getAttribute('data-sort') === draftStorageSort;
        checkbox.checked = isChecked;
        row.classList.toggle('is-selected', isChecked);
    });
}

storageSortRows.forEach(row => {
    row.addEventListener('click', () => {
        const value = row.getAttribute('data-sort');
        draftStorageSort = (draftStorageSort === value) ? null : value;
        renderStorageSortList();
    });
});

if (storageSortTriggerBtn && storageSortModal) {
    storageSortTriggerBtn.addEventListener('click', () => {
        draftStorageSort = storageActiveFilters.sort;
        renderStorageSortList();
        storageSortModal.classList.add('active');
    });
}

if (closeStorageSortModalBtn && storageSortModal) {
    closeStorageSortModalBtn.addEventListener('click', () => {
        storageSortModal.classList.remove('active');
    });
}

if (storageSortModal) {
    storageSortModal.addEventListener('click', (e) => {
        if (e.target === storageSortModal) {
            storageSortModal.classList.remove('active');
        }
    });
}

if (storageSortResetBtn) {
    storageSortResetBtn.addEventListener('click', () => {
        draftStorageSort = null;
        renderStorageSortList();
    });
}

if (storageSortApplyBtn) {
    storageSortApplyBtn.addEventListener('click', () => {
        storageActiveFilters.sort = draftStorageSort;
        storageSortModal.classList.remove('active');
        applyStorageFilters();
    });
}

// =====================================================================
// ИНИЦИАЛИЗАЦИЯ МАРКЕТА
// =====================================================================

(async function initMarket() {
    grid.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    await Promise.all([loadCollections(), loadTraits()]);
    await loadListings();
})();

// Инициализация TonConnect UI
const tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
    manifestUrl: 'https://holdenholden72-dotcom.github.io/BoomMarket/tonconnect-manifest.json',
    buttonRootId: 'walletBtn'
});

// === Telegram WebApp + авторизация через бэкенд по JWT ===
const tg = window.Telegram?.WebApp;

let authToken = null;
let currentTgId = null;

function updateBalanceUI(balance) {
    const userBalanceElements = document.querySelectorAll('.user-balance');
    userBalanceElements.forEach(el => {
        el.textContent = Number(balance).toFixed(2);
    });
}

// Принудительно перечитывает актуальный баланс с сервера и обновляет UI.
// Используется там, где локально посчитанному/пришедшему в ответе балансу
// нельзя доверять на 100% (например, после отмены/принятия/отклонения
// трейда — там баланс не единственное, что меняется, и полагаться только
// на поле balance в ответе конкретного эндпоинта рискованно).
async function refreshBalance() {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_URL}/api/balance`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
        });
        const data = await res.json();
        if (data.ok && typeof data.balance === 'number') {
            updateBalanceUI(data.balance);
        }
    } catch (e) {
        console.error('Не удалось обновить баланс:', e);
    }
}

function showAuthError(message) {
    console.error('Ошибка авторизации:', message);
}

async function authenticateWithBackend(initData) {
    try {
        const res = await fetch(`${API_URL}/api/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData }),
        });

        const data = await res.json();

        if (!data.ok) {
            showAuthError(data.error || 'Неизвестная ошибка');
            return;
        }

        authToken = data.token;
        currentTgId = data.user.id;
        updateBalanceUI(data.user.balance);
        refreshOrdersStat();

        console.log('Авторизован как:', data.user.username || data.user.first_name);
    } catch (e) {
        showAuthError(e.message);
    }
}

if (tg) {
    tg.ready();
    tg.expand();

    const user = tg.initDataUnsafe?.user;

    if (user && user.photo_url) {
        const avatarElement = document.getElementById('openProfileBtn');
        if (avatarElement) {
            avatarElement.src = user.photo_url;
        }
    }

    if (tg.initData) {
        authenticateWithBackend(tg.initData);
    } else {
        console.log('initData пуст — вероятно, открыто не из Telegram');
    }
} else {
    console.log('Открыто не в Telegram');
}

// === БЛОК ВЫВОДА СРЕДСТВ ===

// Проверяет, что сумма — "круглое" число в заданном диапазоне с не более чем
// одним знаком после запятой (0.2, 1.4, 10.7, 10 — можно; 1.76, 9.87 — нельзя).
function isValidAmount(amount, min = 0.1, max = 100000) {
    if (isNaN(amount) || !isFinite(amount)) return false;
    if (amount < min || amount > max) return false;
    // Приводим к десятым и сравниваем — так надёжнее плавающей точки.
    const tenths = Math.round(amount * 10);
    return Math.abs(tenths - amount * 10) < 1e-6 || Math.abs(tenths / 10 - amount) < 1e-9;
}

const withdrawModal = document.getElementById('withdrawModal');
const confirmWithdrawBtn = document.getElementById('confirmWithdrawBtn');
const withdrawAmountInput = document.getElementById('withdrawAmount');

if (confirmWithdrawBtn) {
    confirmWithdrawBtn.addEventListener('click', async () => {
        const amount = parseFloat(withdrawAmountInput.value);

        if (!isValidAmount(amount, 0.5, 100000)) {
            alert('Сумма должна быть от 0.5 до 100000, максимум с одним знаком после запятой (например: 0.5, 1.4, 10.7, 10)');
            return;
        }

        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        try {
            const res = await fetch(`${API_URL}/api/withdraw`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify({ amount }),
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось выполнить вывод');
                return;
            }

            updateBalanceUI(data.balance);
            alert(`Запрос на вывод ${amount} успешно создан!`);

            if (withdrawModal) {
                withdrawModal.style.display = 'none';
            }
            withdrawAmountInput.value = '';
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        }
    });
}

// === БЛОК ПОПОЛНЕНИЯ СРЕДСТВ ===
const depositModal = document.getElementById('depositModal');
const plusDepositBtn = document.getElementById('plusDepositBtn');
const quickDepositBtn = document.getElementById('quickDepositBtn');
const closeDepositModalBtn = document.getElementById('closeDepositModal');
const confirmDepositBtn = document.getElementById('confirmDepositBtn');
const depositAmountInput = document.getElementById('depositAmount');

if (quickDepositBtn && depositModal) {
    quickDepositBtn.addEventListener('click', () => {
        depositModal.style.display = 'flex';
    });
}

if (plusDepositBtn && depositModal) {
    plusDepositBtn.addEventListener('click', () => {
        depositModal.style.display = 'flex';
    });
}

if (closeDepositModalBtn && depositModal) {
    closeDepositModalBtn.addEventListener('click', () => {
        depositModal.style.display = 'none';
    });
}

if (confirmDepositBtn && depositAmountInput) {
    confirmDepositBtn.addEventListener('click', async () => {
        const amount = parseFloat(depositAmountInput.value);

        if (!isValidAmount(amount)) {
            alert('Сумма должна быть от 0.1 до 100000, максимум с одним знаком после запятой (например: 0.2, 1.4, 10.7, 10)');
            return;
        }

        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        try {
            const res = await fetch(`${API_URL}/api/deposit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify({ amount }),
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось выполнить пополнение');
                return;
            }

            updateBalanceUI(data.balance);
            alert(`Баланс успешно пополнен на ${amount}!`);
            depositModal.style.display = 'none';
            depositAmountInput.value = '';
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        }
    });
}

const withdrawBtn = document.getElementById('withdrawBtn');
const closeWithdrawModalBtn = document.getElementById('closeWithdrawModal');

if (withdrawBtn && withdrawModal) {
    withdrawBtn.addEventListener('click', () => {
        withdrawModal.style.display = 'flex';
    });
}

if (closeWithdrawModalBtn && withdrawModal) {
    closeWithdrawModalBtn.addEventListener('click', () => {
        withdrawModal.style.display = 'none';
    });
}

// === БЛОК ВЫСТАВЛЕНИЯ NFT НА ПРОДАЖУ ===
const createListingModal = document.getElementById('createListingModal');
const addListingBtn = document.getElementById('addListingBtn');
const closeCreateListingModalBtn = document.getElementById('closeCreateListingModal');
const listingCollectionSelect = document.getElementById('listingCollectionSelect');
const listingModelSelect = document.getElementById('listingModelSelect');
const listingBackdropSelect = document.getElementById('listingBackdropSelect');
const listingSymbolSelect = document.getElementById('listingSymbolSelect');
const listingGiftNumberInput = document.getElementById('listingGiftNumber');
const listingPriceInput = document.getElementById('listingPrice');
const confirmCreateListingBtn = document.getElementById('confirmCreateListingBtn');

// Полные трейты (с id!) для ВЫБРАННОЙ в форме коллекции — отдельный кэш от
// traitsCache фильтров маркета, потому что здесь нужны именно id для отправки на сервер.
let listingTraitsCache = { models: [], backdrops: [], symbols: [] };

function fillListingSelect(selectEl, items, placeholder, labelFn) {
    selectEl.innerHTML = `<option value="">${placeholder}</option>`;
    items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = labelFn(item);
        selectEl.appendChild(opt);
    });
    selectEl.disabled = items.length === 0;
}

function resetListingForm() {
    listingCollectionSelect.value = '';
    listingModelSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
    listingBackdropSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
    listingSymbolSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
    listingModelSelect.disabled = true;
    listingBackdropSelect.disabled = true;
    listingSymbolSelect.disabled = true;
    listingGiftNumberInput.value = '';
    listingPriceInput.value = '';
    listingTraitsCache = { models: [], backdrops: [], symbols: [] };
}

async function populateListingCollectionSelect() {
    // Коллекции уже загружены маркетом в collectionsCache при старте —
    // переиспользуем, чтобы не дёргать сервер второй раз.
    listingCollectionSelect.innerHTML = '<option value="">Выберите коллекцию</option>';
    collectionsCache.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        listingCollectionSelect.appendChild(opt);
    });
}

if (addListingBtn && createListingModal) {
    addListingBtn.addEventListener('click', async () => {
        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }
        resetListingForm();
        await populateListingCollectionSelect();
        createListingModal.style.display = 'flex';
    });
}

if (closeCreateListingModalBtn && createListingModal) {
    closeCreateListingModalBtn.addEventListener('click', () => {
        createListingModal.style.display = 'none';
    });
}

// При выборе коллекции — подгружаем её реальные модели/фоны/символы (с id)
// через /api/collections/:id/filters и заполняем остальные select'ы.
listingCollectionSelect.addEventListener('change', async () => {
    const collectionId = listingCollectionSelect.value;

    if (!collectionId) {
        listingModelSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
        listingBackdropSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
        listingSymbolSelect.innerHTML = '<option value="">Сначала выберите коллекцию</option>';
        listingModelSelect.disabled = true;
        listingBackdropSelect.disabled = true;
        listingSymbolSelect.disabled = true;
        return;
    }

    listingModelSelect.innerHTML = '<option value="">Загрузка...</option>';
    listingBackdropSelect.innerHTML = '<option value="">Загрузка...</option>';
    listingSymbolSelect.innerHTML = '<option value="">Загрузка...</option>';

    try {
        const res = await fetch(`${API_URL}/api/collections/${collectionId}/filters`);
        const data = await res.json();

        if (!data.ok) throw new Error(data.error || 'Не удалось загрузить трейты');

        listingTraitsCache = data.filters;

        fillListingSelect(listingModelSelect, listingTraitsCache.models, 'Выберите модель', m =>
            m.rarity_permille != null ? `${m.name} (${m.rarity_permille}%)` : m.name);
        fillListingSelect(listingBackdropSelect, listingTraitsCache.backdrops, 'Выберите фон', b =>
            b.rarity_permille != null ? `${b.name} (${b.rarity_permille}%)` : b.name);
        fillListingSelect(listingSymbolSelect, listingTraitsCache.symbols, 'Выберите символ', s =>
            s.rarity_permille != null ? `${s.name} (${s.rarity_permille}%)` : s.name);
    } catch (e) {
        console.error('Не удалось загрузить трейты коллекции:', e);
        listingModelSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        listingBackdropSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        listingSymbolSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
    }
});

if (confirmCreateListingBtn) {
    confirmCreateListingBtn.addEventListener('click', async () => {
        const collectionId = parseInt(listingCollectionSelect.value, 10);
        const modelId = parseInt(listingModelSelect.value, 10);
        const backdropId = parseInt(listingBackdropSelect.value, 10);
        const symbolId = parseInt(listingSymbolSelect.value, 10);
        const giftNumber = parseInt(listingGiftNumberInput.value, 10);
        const price = parseFloat(listingPriceInput.value);

        if (!collectionId) {
            alert('Выберите коллекцию');
            return;
        }
        if (!modelId) {
            alert('Выберите модель');
            return;
        }
        if (!backdropId) {
            alert('Выберите фон');
            return;
        }
        if (!symbolId) {
            alert('Выберите символ');
            return;
        }
        if (!giftNumber || giftNumber <= 0) {
            alert('Укажите корректный номер подарка');
            return;
        }
        if (!price || price <= 0) {
            alert('Укажите корректную цену');
            return;
        }
        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        try {
            const res = await fetch(`${API_URL}/api/listings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify({ collectionId, modelId, backdropId, symbolId, giftNumber, price }),
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось выставить лот');
                return;
            }

            alert('NFT выставлен на продажу!');
            createListingModal.style.display = 'none';
            resetListingForm();

            // Возвращаемся на маркет и обновляем список — новый лот должен появиться сразу.
            showScreen('market');
            await loadListings();
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        }
    });
}

// =====================================================================
// ХРАНИЛИЩЕ — товары пользователя, которые сейчас не выставлены на продажу
// (попадают сюда после покупки лота или после снятия своего лота с продажи).
// =====================================================================

const storageGrid = document.getElementById('storageGrid');
const storageItemsById = new Map();

// Полный, неотфильтрованный список товаров пользователя с сервера —
// фильтры/поиск/сортировка Хранилища применяются к нему локально, без
// повторных запросов (в отличие от Маркета, где это делает бэкенд).
let allInventoryItems = [];

async function loadInventory() {
    if (!authToken) {
        storageGrid.innerHTML = `<div class="empty-state">Не удалось подтвердить личность. Попробуйте перезайти.</div>`;
        return;
    }

    try {
        const res = await fetch(`${API_URL}/api/inventory`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
        });
        const data = await res.json();
        if (data.ok) {
            allInventoryItems = data.items || [];
            applyStorageFilters();
        }
    } catch (e) {
        console.error('Не удалось загрузить хранилище:', e);
        storageGrid.innerHTML = `<div class="empty-state">Не удалось загрузить хранилище. Проверьте соединение.</div>`;
    }
}

/** Применяет текущие фильтры/поиск/сортировку Хранилища к полному списку
 * инвентаря и перерисовывает сетку. */
function applyStorageFilters() {
    let items = allInventoryItems;

    if (storageActiveFilters.collectionIds.length) {
        items = items.filter(i => storageActiveFilters.collectionIds.includes(String(i.collection_id)));
    }
    if (storageActiveFilters.models.length) {
        items = items.filter(i => storageActiveFilters.models.includes(i.model_name));
    }
    if (storageActiveFilters.backdrops.length) {
        items = items.filter(i => storageActiveFilters.backdrops.includes(i.backdrop_name));
    }
    if (storageActiveFilters.symbols.length) {
        items = items.filter(i => storageActiveFilters.symbols.includes(i.symbol_name));
    }
    if (currentStorageSearch.trim()) {
        const q = currentStorageSearch.trim().toLowerCase();
        items = items.filter(i =>
            (i.collection_name || '').toLowerCase().includes(q) ||
            String(i.gift_number).includes(q)
        );
    }

    items = items.slice();
    if (storageActiveFilters.sort === 'num_asc') {
        items.sort((a, b) => a.gift_number - b.gift_number);
    } else if (storageActiveFilters.sort === 'num_desc') {
        items.sort((a, b) => b.gift_number - a.gift_number);
    } else if (storageActiveFilters.sort === 'date_asc') {
        items.sort((a, b) => new Date(a.sold_at || a.created_at) - new Date(b.sold_at || b.created_at));
    } else if (storageActiveFilters.sort === 'date_desc') {
        items.sort((a, b) => new Date(b.sold_at || b.created_at) - new Date(a.sold_at || a.created_at));
    }

    renderStorageGrid(items, allInventoryItems.length === 0);
}

function renderStorageGrid(items, isTrulyEmpty) {
    storageGrid.innerHTML = '';
    storageItemsById.clear();

    if (!items || items.length === 0) {
        storageGrid.innerHTML = isTrulyEmpty
            ? `<div class="empty-state">Пока пусто — купленные подарки и снятые с продажи лоты появятся здесь</div>`
            : `<div class="empty-state">Ничего не найдено по выбранным фильтрам</div>`;
        return;
    }

    items.forEach(item => {
        storageItemsById.set(String(item.id), item);

        const card = document.createElement('div');
        card.className = 'nft-card';
        card.dataset.itemId = item.id;

        const bg = item.backdrop_color || '#333';
        const image = item.model_icon || item.collection_image || '';

        card.innerHTML = `
            <div class="nft-image-container" style="background-color: ${bg};">
                ${image ? `<img src="${image}" class="nft-img" alt="${item.collection_name}">` : ''}
            </div>
            <div class="nft-info">
                <div class="nft-title">${item.collection_name}</div>
                <div class="nft-number">#${item.gift_number}</div>
            </div>
        `;
        storageGrid.appendChild(card);
    });
}

if (storageGrid) {
    storageGrid.addEventListener('click', (e) => {
        const relistBtn = e.target.closest('.storage-relist-btn');
        if (relistBtn) {
            const item = storageItemsById.get(relistBtn.dataset.itemId);
            if (item) openRelistModal(item);
            return;
        }

        // Клик по всей карточке — открываем полную информацию о товаре
        // и возможность выставить его на продажу (кнопки на карточке больше нет).
        const card = e.target.closest('.nft-card');
        if (card) {
            const item = storageItemsById.get(card.dataset.itemId);
            if (item) openRelistModal(item);
        }
    });
}

// === Модалка "Выставить на продажу" из Хранилища ===
const relistModal = document.getElementById('relistModal');
const closeRelistModalBtn = document.getElementById('closeRelistModal');
const relistImageWrap = document.getElementById('relistImageWrap');
const relistImage = document.getElementById('relistImage');
const relistTitle = document.getElementById('relistTitle');
const relistNumber = document.getElementById('relistNumber');
const relistCollection = document.getElementById('relistCollection');
const relistModel = document.getElementById('relistModel');
const relistBackdrop = document.getElementById('relistBackdrop');
const relistSymbol = document.getElementById('relistSymbol');
const relistPriceInput = document.getElementById('relistPrice');
const relistConfirmBtn = document.getElementById('relistConfirmBtn');

let currentRelistItemId = null;

function openRelistModal(item) {
    currentRelistItemId = item.id;

    const image = item.model_icon || item.collection_image || '';
    relistImageWrap.style.backgroundColor = item.backdrop_color || '#333';
    relistImage.src = image;
    relistTitle.textContent = item.collection_name;
    relistNumber.textContent = `#${item.gift_number}`;
    relistCollection.textContent = item.collection_name;
    relistModel.textContent = traitLabel(item.model_name);
    relistBackdrop.textContent = traitLabel(item.backdrop_name);
    relistSymbol.textContent = traitLabel(item.symbol_name);
    relistPriceInput.value = '';

    relistModal.style.display = 'flex';
}

if (closeRelistModalBtn && relistModal) {
    closeRelistModalBtn.addEventListener('click', () => {
        relistModal.style.display = 'none';
        currentRelistItemId = null;
    });
}

if (relistConfirmBtn) {
    relistConfirmBtn.addEventListener('click', async () => {
        if (!currentRelistItemId) return;

        const price = parseFloat(relistPriceInput.value);
        if (!price || price <= 0) {
            alert('Укажите корректную цену');
            return;
        }
        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        relistConfirmBtn.disabled = true;

        try {
            const res = await fetch(`${API_URL}/api/listings/${currentRelistItemId}/relist`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify({ price }),
            });

            const data = await res.json();

            if (!data.ok) {
                alert(data.error || 'Не удалось выставить товар на продажу');
                return;
            }

            alert(data.matchedOrder ? 'Товар сразу продан по подходящему ордеру!' : 'Товар выставлен на продажу!');
            relistModal.style.display = 'none';
            currentRelistItemId = null;

            await loadInventory();
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        } finally {
            relistConfirmBtn.disabled = false;
        }
    });
}

// =====================================================================
// ТРЕЙД (P2P-обмен подарками между пользователями)
// =====================================================================

const tradeTabs = document.getElementById('tradeTabs');
const tradeNewPanel = document.getElementById('tradeNewPanel');
const tradeIncomingList = document.getElementById('tradeIncomingList');
const tradeMineList = document.getElementById('tradeMineList');
const tradeRecipientInput = document.getElementById('tradeRecipientInput');
const tradeFindUserBtn = document.getElementById('tradeFindUserBtn');
const tradeFoundUsers = document.getElementById('tradeFoundUsers');
const tradeSelectionArea = document.getElementById('tradeSelectionArea');
const tradeSelectedUserBox = document.getElementById('tradeSelectedUserBox');
const tradeMyItemsList = document.getElementById('tradeMyItemsList');
const tradeTheirItemsTitle = document.getElementById('tradeTheirItemsTitle');
const tradeTheirItemsList = document.getElementById('tradeTheirItemsList');
const tradeSubmitBtn = document.getElementById('tradeSubmitBtn');
const tradeTopupDirection = document.getElementById('tradeTopupDirection');
const tradeTopupAmount = document.getElementById('tradeTopupAmount');

const tradeDetailModal = document.getElementById('tradeDetailModal');
const closeTradeDetailModalBtn = document.getElementById('closeTradeDetailModal');
const tradeDetailMeta = document.getElementById('tradeDetailMeta');
const tradeDetailTopupNote = document.getElementById('tradeDetailTopupNote');
const tradeDetailGiveList = document.getElementById('tradeDetailGiveList');
const tradeDetailGetList = document.getElementById('tradeDetailGetList');
const tradeDetailActions = document.getElementById('tradeDetailActions');

let tradeTargetUser = null;
const tradeMySelected = new Set();
const tradeTheirSelected = new Set();
let tradeTopupPayer = 'none'; // 'none' | 'initiator' | 'recipient'
const tradeIncomingCache = new Map();
const tradeMineCache = new Map();
let currentTradeDetailId = null;

const tradeStatusLabels = {
    pending: 'Ожидает',
    accepted: 'Принят',
    declined: 'Отклонён',
    cancelled: 'Отменён',
    failed: 'Не удался',
};

/** Сбрасывает вкладку "Новый обмен" — вызывается при каждом заходе на экран
 * "Трейд", чтобы не оперировать устаревшим выбором предметов. */
function resetTradeNewPanel() {
    tradeTargetUser = null;
    tradeMySelected.clear();
    tradeTheirSelected.clear();
    tradeTopupPayer = 'none';
    if (tradeRecipientInput) tradeRecipientInput.value = '';
    if (tradeFoundUsers) tradeFoundUsers.innerHTML = '';
    if (tradeSelectionArea) tradeSelectionArea.style.display = 'none';
    if (tradeMyItemsList) tradeMyItemsList.innerHTML = '';
    if (tradeTheirItemsList) tradeTheirItemsList.innerHTML = '';
    if (tradeTopupAmount) {
        tradeTopupAmount.value = '';
        tradeTopupAmount.style.display = 'none';
    }
    if (tradeTopupDirection) {
        tradeTopupDirection.querySelectorAll('.trade-topup-dir-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.topupPayer === 'none');
        });
    }
}

if (tradeTopupDirection) {
    tradeTopupDirection.addEventListener('click', (e) => {
        const btn = e.target.closest('.trade-topup-dir-btn');
        if (!btn) return;
        tradeTopupPayer = btn.dataset.topupPayer;
        tradeTopupDirection.querySelectorAll('.trade-topup-dir-btn').forEach(b => {
            b.classList.toggle('active', b === btn);
        });
        if (tradeTopupAmount) {
            tradeTopupAmount.style.display = tradeTopupPayer === 'none' ? 'none' : '';
            if (tradeTopupPayer === 'none') tradeTopupAmount.value = '';
        }
    });
}

if (tradeTabs) {
    tradeTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.orders-tab');
        if (!btn) return;
        const tab = btn.getAttribute('data-trade-tab');
        tradeTabs.querySelectorAll('.orders-tab').forEach(t => t.classList.toggle('active', t === btn));
        tradeNewPanel.style.display = tab === 'new' ? '' : 'none';
        tradeIncomingList.style.display = tab === 'incoming' ? '' : 'none';
        tradeMineList.style.display = tab === 'mine' ? '' : 'none';
    });
}

async function searchTradeUsers() {
    if (!tradeRecipientInput || !tradeFoundUsers) return;
    const q = tradeRecipientInput.value.trim();
    if (!q) {
        tradeFoundUsers.innerHTML = '';
        return;
    }
    if (!authToken) {
        alert('Не удалось подтвердить личность. Попробуйте перезайти.');
        return;
    }
    tradeFoundUsers.innerHTML = `<div class="empty-state">Поиск...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/users/search?q=${encodeURIComponent(q)}`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
        });
        const data = await res.json();
        if (!data.ok) {
            tradeFoundUsers.innerHTML = `<div class="empty-state">${data.error || 'Ошибка поиска'}</div>`;
            return;
        }
        renderTradeFoundUsers(data.users);
    } catch (e) {
        tradeFoundUsers.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

function renderTradeFoundUsers(users) {
    tradeFoundUsers.innerHTML = '';
    if (!users || users.length === 0) {
        tradeFoundUsers.innerHTML = `<div class="empty-state">Пользователь не найден</div>`;
        return;
    }
    users.forEach(u => {
        const row = document.createElement('div');
        row.className = 'trade-found-row';
        const displayName = [u.first_name, u.last_name].filter(Boolean).join(' ');
        row.innerHTML = `
            <img class="trade-found-avatar" src="${u.photo_url || ''}" alt="">
            <div class="trade-found-name">${displayName ? displayName + ' · ' : ''}@${u.username}</div>
            <span>›</span>
        `;
        row.addEventListener('click', () => selectTradeTarget(u));
        tradeFoundUsers.appendChild(row);
    });
}

async function selectTradeTarget(user) {
    tradeTargetUser = user;
    tradeMySelected.clear();
    tradeTheirSelected.clear();
    tradeFoundUsers.innerHTML = '';
    tradeRecipientInput.value = '';
    tradeSelectedUserBox.innerHTML = `Обмен с <b>@${user.username}</b>`;
    tradeSelectionArea.style.display = '';
    tradeTheirItemsTitle.textContent = `ПРЕДМЕТЫ @${user.username}`;
    await Promise.all([loadTradeMyItems(), loadTradeTheirItems()]);
}

function renderTradePickList(container, items, selectedSet) {
    container.innerHTML = '';
    if (!items || items.length === 0) {
        container.innerHTML = `<div class="empty-state">Хранилище пусто</div>`;
        return;
    }
    items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'trade-pick-row';
        const image = item.model_icon || item.collection_image || '';
        const bg = item.backdrop_color || '#333';
        li.innerHTML = `
            <input type="checkbox" data-item-id="${item.id}" ${selectedSet.has(item.id) ? 'checked' : ''}>
            <div class="history-thumb" style="background-color:${bg};">
                ${image ? `<img src="${image}" alt="">` : ''}
            </div>
            <div class="history-info">
                <div class="history-name">${item.collection_name}${item.gift_number ? ' #' + item.gift_number : ''}</div>
                <div class="history-meta">${traitLabel(item.model_name)}</div>
            </div>
        `;
        const checkbox = li.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedSet.add(item.id);
            else selectedSet.delete(item.id);
        });
        li.addEventListener('click', (e) => {
            if (e.target === checkbox) return;
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
        });
        container.appendChild(li);
    });
}

async function loadTradeMyItems() {
    if (!tradeMyItemsList || !authToken) return;
    tradeMyItemsList.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/inventory`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!data.ok) {
            tradeMyItemsList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить хранилище'}</div>`;
            return;
        }
        renderTradePickList(tradeMyItemsList, data.items, tradeMySelected);
    } catch (e) {
        tradeMyItemsList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

async function loadTradeTheirItems() {
    if (!tradeTheirItemsList || !tradeTargetUser || !authToken) return;
    tradeTheirItemsList.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/users/${tradeTargetUser.tg_id}/inventory`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
        });
        const data = await res.json();
        if (!data.ok) {
            tradeTheirItemsList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить предметы'}</div>`;
            return;
        }
        renderTradePickList(tradeTheirItemsList, data.items, tradeTheirSelected);
    } catch (e) {
        tradeTheirItemsList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

if (tradeFindUserBtn) {
    tradeFindUserBtn.addEventListener('click', searchTradeUsers);
}
if (tradeRecipientInput) {
    tradeRecipientInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchTradeUsers();
    });
}

if (tradeSubmitBtn) {
    tradeSubmitBtn.addEventListener('click', async () => {
        if (!tradeTargetUser) {
            alert('Сначала выберите получателя');
            return;
        }
        if (tradeMySelected.size === 0 || tradeTheirSelected.size === 0) {
            alert('Выберите хотя бы один предмет с каждой стороны');
            return;
        }
        if (!authToken) {
            alert('Не удалось подтвердить личность. Попробуйте перезайти.');
            return;
        }

        // Доплата TON — необязательная, но если направление выбрано, сумма обязательна.
        let tonAmount = null;
        if (tradeTopupPayer !== 'none') {
            const parsed = parseFloat(tradeTopupAmount ? tradeTopupAmount.value : '');
            if (!isFinite(parsed) || parsed <= 0) {
                alert('Укажите сумму доплаты в TON');
                return;
            }
            tonAmount = parsed;
        }

        tradeSubmitBtn.disabled = true;
        try {
            const body = {
                recipientTgId: tradeTargetUser.tg_id,
                myItemIds: Array.from(tradeMySelected),
                theirItemIds: Array.from(tradeTheirSelected),
            };
            if (tonAmount !== null) {
                body.tonAmount = tonAmount;
                body.tonPayer = tradeTopupPayer; // 'initiator' | 'recipient'
            }

            const res = await fetch(`${API_URL}/api/trades`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!data.ok) {
                alert(data.error || 'Не удалось создать предложение обмена');
                return;
            }
            // Комиссия 0.05 TON (и доплата, если её вносит инициатор) уже
            // списаны сервером при создании трейда — обновляем баланс на экране,
            // а следом сверяем с сервером на всякий случай.
            if (typeof data.balance === 'number') {
                updateBalanceUI(data.balance);
            }
            alert('Предложение обмена отправлено!');
            resetTradeNewPanel();
            await Promise.all([loadMyTrades(), refreshBalance()]);
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        } finally {
            tradeSubmitBtn.disabled = false;
        }
    });
}

/** Возвращает "собеседника" по трейду относительно текущего пользователя. */
function tradeCounterparty(trade) {
    return trade.initiator_tg_id === currentTgId ? trade.recipient : trade.initiator;
}
/** Предметы, которые ОТДАЁТ текущий пользователь (независимо от того,
 * инициатор он или получатель обмена). */
function tradeItemsIGive(trade) {
    return trade.initiator_tg_id === currentTgId ? trade.initiatorItems : trade.recipientItems;
}
/** Предметы, которые текущий пользователь ПОЛУЧАЕТ. */
function tradeItemsIGet(trade) {
    return trade.initiator_tg_id === currentTgId ? trade.recipientItems : trade.initiatorItems;
}

function renderTradeSummaryRow(trade) {
    const other = tradeCounterparty(trade);
    const give = tradeItemsIGive(trade);
    const get = tradeItemsIGet(trade);
    const thumbSource = give[0] || get[0];
    const thumbImage = thumbSource ? (thumbSource.model_image || thumbSource.collection_image) : '';
    const bg = thumbSource ? (thumbSource.backdrop_color || '#333') : '#333';

    const isInitiator = trade.initiator_tg_id === currentTgId;
    let topupText = '';
    if (trade.ton_amount > 0 && trade.ton_payer) {
        const iAmPayer = (trade.ton_payer === 'initiator' && isInitiator) || (trade.ton_payer === 'recipient' && !isInitiator);
        topupText = iAmPayer ? ` · доплата −${trade.ton_amount} TON` : ` · доплата +${trade.ton_amount} TON`;
    }

    const li = document.createElement('li');
    li.className = 'history-row has-gift';
    li.dataset.tradeId = trade.id;
    li.innerHTML = `
        <div class="history-thumb" style="background-color:${bg};">
            ${thumbImage ? `<img src="${thumbImage}" alt="">` : ''}
        </div>
        <div class="history-info">
            <div class="history-name">@${other ? (other.username || other.first_name || other.tg_id) : '—'}</div>
            <div class="history-meta">Отдаёте ${give.length} · получаете ${get.length}${topupText}</div>
            <div class="history-meta">${formatHistoryDate(trade.created_at)}</div>
        </div>
        <span class="trade-status-badge is-${trade.status}">${tradeStatusLabels[trade.status] || trade.status}</span>
    `;
    return li;
}

async function loadIncomingTrades() {
    if (!tradeIncomingList) return;
    if (!authToken) {
        tradeIncomingList.innerHTML = `<div class="empty-state">Не удалось подтвердить личность. Попробуйте перезайти.</div>`;
        return;
    }
    tradeIncomingList.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/trades/incoming`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!data.ok) {
            tradeIncomingList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить обмены'}</div>`;
            return;
        }
        tradeIncomingCache.clear();
        tradeIncomingList.innerHTML = '';
        if (!data.trades.length) {
            tradeIncomingList.innerHTML = `<div class="empty-state">Нет входящих предложений</div>`;
            return;
        }
        data.trades.forEach(trade => {
            tradeIncomingCache.set(String(trade.id), trade);
            tradeIncomingList.appendChild(renderTradeSummaryRow(trade));
        });
    } catch (e) {
        tradeIncomingList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

async function loadMyTrades() {
    if (!tradeMineList) return;
    if (!authToken) {
        tradeMineList.innerHTML = `<div class="empty-state">Не удалось подтвердить личность. Попробуйте перезайти.</div>`;
        return;
    }
    tradeMineList.innerHTML = `<div class="empty-state">Загрузка...</div>`;
    try {
        const res = await fetch(`${API_URL}/api/trades/mine`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!data.ok) {
            tradeMineList.innerHTML = `<div class="empty-state">${data.error || 'Не удалось загрузить обмены'}</div>`;
            return;
        }
        tradeMineCache.clear();
        tradeMineList.innerHTML = '';
        if (!data.trades.length) {
            tradeMineList.innerHTML = `<div class="empty-state">Пока нет обменов</div>`;
            return;
        }
        data.trades.forEach(trade => {
            tradeMineCache.set(String(trade.id), trade);
            tradeMineList.appendChild(renderTradeSummaryRow(trade));
        });
    } catch (e) {
        tradeMineList.innerHTML = `<div class="empty-state">Ошибка соединения с сервером</div>`;
        console.error(e);
    }
}

function bindTradeListClicks(container, cacheMap) {
    if (!container) return;
    container.addEventListener('click', (e) => {
        const row = e.target.closest('.history-row[data-trade-id]');
        if (!row) return;
        const trade = cacheMap.get(row.dataset.tradeId);
        if (!trade) return;
        openTradeDetail(trade);
    });
}
bindTradeListClicks(tradeIncomingList, tradeIncomingCache);
bindTradeListClicks(tradeMineList, tradeMineCache);

function renderTradeItemRow(item) {
    const image = item.model_image || item.collection_image || '';
    const bg = item.backdrop_color || '#333';
    const li = document.createElement('li');
    li.className = 'history-row trade-item-row';
    li.innerHTML = `
        <div class="history-thumb" style="background-color:${bg};">
            ${image ? `<img src="${image}" alt="">` : ''}
        </div>
        <div class="history-info">
            <div class="history-name">${item.collection_name}${item.gift_number ? ' #' + item.gift_number : ''}</div>
            <div class="history-meta">${traitLabel(item.model_name)}</div>
        </div>
    `;
    // Клик по предмету обмена открывает ту же карточку с деталями, что и на
    // маркете (номер, коллекция, модель, фон, символ), но без кнопок
    // купли/продажи — это просто просмотр.
    li.addEventListener('click', () => openListingDetail(item, { viewOnly: true }));
    return li;
}

function openTradeDetail(trade) {
    currentTradeDetailId = trade.id;
    const other = tradeCounterparty(trade);
    const give = tradeItemsIGive(trade);
    const get = tradeItemsIGet(trade);
    const isInitiator = trade.initiator_tg_id === currentTgId;
    const isRecipient = trade.recipient_tg_id === currentTgId;

    tradeDetailMeta.textContent = `Обмен с @${other ? (other.username || other.first_name || other.tg_id) : '—'} · ${tradeStatusLabels[trade.status] || trade.status}`;

    // Доплата TON — показываем, только если она есть, и формулируем с точки
    // зрения текущего пользователя (я доплачиваю / мне доплачивают).
    if (tradeDetailTopupNote) {
        if (trade.ton_amount > 0 && trade.ton_payer) {
            const iAmPayer = (trade.ton_payer === 'initiator' && isInitiator) || (trade.ton_payer === 'recipient' && isRecipient);
            tradeDetailTopupNote.textContent = iAmPayer
                ? `Вы доплачиваете ${trade.ton_amount} TON`
                : `Вам доплачивают ${trade.ton_amount} TON`;
            tradeDetailTopupNote.style.display = '';
        } else {
            tradeDetailTopupNote.style.display = 'none';
        }
    }

    tradeDetailGiveList.innerHTML = '';
    give.forEach(item => tradeDetailGiveList.appendChild(renderTradeItemRow(item)));

    tradeDetailGetList.innerHTML = '';
    get.forEach(item => tradeDetailGetList.appendChild(renderTradeItemRow(item)));

    tradeDetailActions.innerHTML = '';

    if (trade.status === 'pending' && isRecipient) {
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'action-btn';
        acceptBtn.textContent = (trade.ton_amount > 0 && trade.ton_payer === 'recipient')
            ? `Принять и доплатить ${trade.ton_amount} TON`
            : 'Принять';
        acceptBtn.addEventListener('click', () => resolveTrade(trade.id, 'accept'));

        const declineBtn = document.createElement('button');
        declineBtn.className = 'action-btn trade-decline-btn';
        declineBtn.textContent = 'Отклонить';
        declineBtn.addEventListener('click', () => resolveTrade(trade.id, 'decline'));

        tradeDetailActions.appendChild(acceptBtn);
        tradeDetailActions.appendChild(declineBtn);
    } else if (trade.status === 'pending' && isInitiator) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'action-btn trade-decline-btn';
        cancelBtn.textContent = 'Отменить обмен';
        cancelBtn.addEventListener('click', () => resolveTrade(trade.id, 'cancel'));
        tradeDetailActions.appendChild(cancelBtn);
    }

    tradeDetailModal.style.display = 'flex';
}

async function resolveTrade(tradeId, action) {
    if (!authToken) {
        alert('Не удалось подтвердить личность. Попробуйте перезайти.');
        return;
    }
    try {
        const endpoint = action === 'cancel'
            ? `${API_URL}/api/trades/${tradeId}`
            : `${API_URL}/api/trades/${tradeId}/${action}`;
        const method = action === 'cancel' ? 'DELETE' : 'POST';
        const res = await fetch(endpoint, { method, headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!data.ok) {
            alert(data.error || 'Не удалось выполнить действие');
            return;
        }
        // Комиссия/доплата TON могли списаться или вернуться на баланс —
        // сначала применяем то, что уже пришло в ответе (быстро, без лишнего
        // запроса), а следом принудительно перепроверяем баланс с сервера —
        // чтобы он гарантированно был актуальным, даже если бы поле balance
        // в ответе этого конкретного эндпоинта почему-то не пришло/устарело.
        if (typeof data.balance === 'number') {
            updateBalanceUI(data.balance);
        }
        tradeDetailModal.style.display = 'none';
        currentTradeDetailId = null;
        await Promise.all([loadIncomingTrades(), loadMyTrades(), refreshBalance()]);
        if (action === 'accept') {
            await loadInventory(); // если открыто "Хранилище" — состав уже изменился
        }
    } catch (e) {
        alert('Ошибка соединения с сервером');
        console.error(e);
    }
}

if (closeTradeDetailModalBtn && tradeDetailModal) {
    closeTradeDetailModalBtn.addEventListener('click', () => {
        tradeDetailModal.style.display = 'none';
        currentTradeDetailId = null;
    });
}
