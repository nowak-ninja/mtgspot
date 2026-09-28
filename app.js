'use strict';

const API_KEY = 'b3d39321-5dc4-4298-98c6-0399432a948b';
const SHOP_API = 'https://gateway.mtgspot.pl/api/shop';
let results = [];
let busy = false;
let credentials = null;
let euroRate = null;
let marketSession = null;
const MARKET_API = 'https://magicznyrynek.pl/shop-api/?languageCode=pl&currencyCode=PLN';

function parseCards(text) {
    // Quantities in deck exports are ignored: one line still means one copy.
    return text.split(/\r?\n/).map(line => line.trim().replace(/^\d+\s+/, '').trim()).filter(Boolean);
}

function availableCards(cards, name) {
    return cards.filter(card => card && Number(card.stock) > 0 &&
        !['Tip Card', 'Token'].includes(card.rarity) &&
        typeof card.title === 'string' && card.title.toLowerCase() === name.toLowerCase() &&
        card.price !== null && String(card.price).trim() !== '' &&
        Number.isFinite(Number(card.price)) && Number(card.price) >= 0)
        .sort((a, b) => Number(a.price) - Number(b.price));
}

async function findSpotCard(cardName) {
    try {
        const cards = [];
        for (let offset = 0; ; offset += 300) {
            const response = await $.ajax({
                url: 'https://mtgspot.cn-panel.pl/products',
                data: { s_title: cardName, limit: 300, offset, order_by: 'title', sort_by: 'asc' },
                dataType: 'json', timeout: 30000
            });
            if (!Array.isArray(response?.data)) throw new Error('Invalid product response');
            cards.push(...availableCards(response.data, cardName));
            if (response.data.length < 300 || offset + 300 >= Number(response.count)) break;
        }
        const variants = availableCards(cards, cardName);
        return { cardName, variants, data: variants[0] };
    } catch {
        return { cardName, error: true };
    }
}

async function marketQuery(query, variables = {}, token = '') {
    const response = await $.ajax({
        url: MARKET_API,
        type: 'POST', contentType: 'application/json', dataType: 'json', timeout: 30000,
        headers: { 'deenruv-token': 'pl-channel', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        data: JSON.stringify({ query, variables })
    });
    if (response.errors?.length || !response.data) {
        const error = new Error('Błąd odpowiedzi Magicznego Rynku.');
        if (response.errors?.some(item => ['UNAUTHENTICATED', 'FORBIDDEN'].includes(item.extensions?.code))) {
            error.status = 401;
            error.message = 'Sesja wygasła - zaloguj się ponownie.';
        }
        throw error;
    }
    return response.data;
}

function marketVariants(product, cardName) {
    if (product?.name?.toLowerCase() !== cardName.toLowerCase()) return [];
    return (product.variants || []).flatMap(variant => {
        const facets = variant.facetValues || [];
        const facet = code => facets.find(value => value.facet.code === code);
        const option = code => variant.options?.find(value => value.group.code === code);
        if (variant.currencyCode !== 'PLN' || facet('type')?.code !== 'Single' ||
            ['Token', 'Tip Card'].includes(facet('rarity')?.code) ||
            !Number.isFinite(Number(variant.stockLevel)) || Number(variant.stockLevel) <= 0 ||
            !Number.isInteger(variant.priceWithTax) || variant.priceWithTax < 0) return [];
        return [{ shop: 'market', variantId: String(variant.id), title: product.name, price: variant.priceWithTax / 100,
            stock: Number(variant.stockLevel), expansion_name: facet('expansion')?.name || '-',
            language: option('language')?.name || facet('language')?.code || '?',
            condition: option('condition')?.code || facet('condition')?.name || '-',
            is_foil: option('foil')?.code === 'foil' ? 1 : 0,
            is_signed: option('signed')?.code === 'signed' ? 1 : 0,
            is_altered: option('altered')?.code === 'altered' ? 1 : 0,
            image: variant.featuredAsset?.preview || product.featuredAsset?.preview,
            url: 'https://magicznyrynek.pl/products/' + encodeURIComponent(product.slug) + '/' + encodeURIComponent(variant.id) + '/' }];
    });
}

async function findMarketCards(cardName) {
    // The shop's full-text search breaks on apostrophes; keep exact matching below unchanged.
    const term = cardName.replace(/'/g, '');
    const slugs = new Set();
    for (let skip = 0; ; skip += 100) {
        const { search } = await marketQuery(`query($term: String!, $skip: Int!) {
            search(input: {term: $term, skip: $skip, take: 100, groupByProduct: true}) {
                totalItems items { productName slug }
            }
        }`, { term, skip });
        if (!Array.isArray(search?.items)) throw new Error('Invalid search response');
        search.items.filter(item => item.productName.toLowerCase() === cardName.toLowerCase())
            .forEach(item => slugs.add(item.slug));
        if (skip + 100 >= search.totalItems || search.items.length < 100) break;
    }
    const cards = [];
    const products = [...slugs];
    // The search index can have stale prices and stock; verify the product variants.
    for (let i = 0; i < products.length; i += 10) {
        const query = products.slice(i, i + 10).map((slug, index) =>
            `p${index}: product(slug: ${JSON.stringify(slug)}) {
                name slug featuredAsset { preview }
                variants { id stockLevel priceWithTax currencyCode featuredAsset { preview }
                    options { code name group { code } }
                    facetValues { code name facet { code } }
                }
            }`).join('\n');
        const data = await marketQuery('{ ' + query + ' }');
        Object.values(data).forEach(product => cards.push(...marketVariants(product, cardName)));
    }
    return cards;
}

function cardmarketId(card) {
    try {
        let image = new URL(card?.image);
        if (image.hostname === 'gateway.mtgspot.pl') image = new URL(atob(image.searchParams.get('key')));
        if (!['product-images.s3.cardmarket.com', 'cards.magicznyrynek.aexol.work'].includes(image.hostname)) return null;
        // Both stores include the exact Cardmarket product ID in the edition's image URL.
        const match = image.pathname.match(/\/(\d+)\/\1\.(?:jpg|png|webp)$/i);
        return match ? Number(match[1]) : null;
    } catch { return null; }
}

let referenceQueue = Promise.resolve();
const referenceCache = new Map();
function findReference(cardName, variant) {
    const id = cardmarketId(variant);
    if (!id) return Promise.resolve(null);
    const foil = Number(variant.is_foil) === 1;
    const key = id + ':' + foil;
    if (referenceCache.has(key)) return referenceCache.get(key);
    // Space Scryfall requests, including those started by parallel searches and variant changes.
    const request = referenceQueue.then(async () => {
        try {
            const card = await $.ajax({ url: 'https://api.scryfall.com/cards/cardmarket/' + id,
                dataType: 'json', timeout: 15000 });
            const price = card.prices?.[foil ? 'eur_foil' : 'eur'];
            if (card.cardmarket_id !== id || card.name?.toLowerCase() !== cardName.toLowerCase() ||
                price === null || price === undefined || String(price).trim() === '' ||
                !Number.isFinite(Number(price)) || Number(price) < 0) return null;
            return { price: Number(price), expansion: card.set_name, foil,
                url: 'https://www.cardmarket.com/en/Magic/Products?idProduct=' + id + '&isFoil=' + (foil ? 'Y' : 'N') };
        } catch (error) {
            referenceCache.delete(key);
            return error.status === 404 ? null : { error: true };
        }
    });
    referenceQueue = request.then(() => new Promise(resolve => setTimeout(resolve, 120)));
    referenceCache.set(key, request);
    return request;
}

async function fetchEuroRate() {
    try {
        const response = await $.ajax({
            url: 'https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json',
            dataType: 'json', timeout: 8000
        });
        const rate = response.rates?.[0];
        if (response.code !== 'EUR' || !Number.isFinite(rate?.mid) || rate.mid <= 0 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(rate.effectiveDate)) return null;
        return { value: rate.mid, date: rate.effectiveDate };
    } catch {
        return null;
    }
}

function defaultVariant(variants) {
    const english = card => ['eng', 'english', 'en'].includes(String(card.language || '').trim().toLowerCase());
    const spot = card => card.shop !== 'market';
    // Variants are already sorted by price; prefer MTG Spot, then English within each shop.
    return variants.find(card => spot(card) && english(card)) || variants.find(spot) ||
        variants.find(english) || variants[0];
}

function marketSearchError(error) {
    if (error.statusText === 'timeout') return 'przekroczono czas oczekiwania';
    if (error.status === 429) return 'limit zapytań sklepu';
    if (error.status === 0) return 'brak połączenia lub blokada przeglądarki';
    if (error.status) return 'błąd HTTP ' + error.status;
    return 'nieprawidłowa odpowiedź sklepu';
}

async function findCard(cardName, includeMarket) {
    const [spot, market] = await Promise.all([
        findSpotCard(cardName),
        includeMarket ? findMarketCards(cardName).then(cards => ({ cards }), error => ({ error: true, reason: marketSearchError(error) })) : { cards: [] }
    ]);
    const variants = [...(spot.variants || []), ...(market.cards || [])].sort((a, b) => Number(a.price) - Number(b.price));
    const errors = [spot.error && 'MTG Spot', market.error && 'Magiczny Rynek'].filter(Boolean);
    const data = defaultVariant(variants);
    const reference = await findReference(cardName, data);
    return { cardName, variants, data, error: errors.length > 0, errors, marketError: market.reason, reference };
}

function shopName(card) { return card.shop === 'market' ? 'Magiczny Rynek' : 'MTG Spot'; }

function selectedSpotBoxes() {
    return $('.add-to-basket:checked').toArray().filter(box => results[box.dataset.index].data.shop !== 'market');
}

async function searchSingles() {
    if (busy) return;
    const names = parseCards($('#cards').val());
    const includeMarket = $('#includeMarket').prop('checked');
    euroRate = null;
    referenceCache.clear();
    const searches = new Map();
    results = [];
    $('#resultBody').empty();
    $('#result').hide();
    $('#cartFeedback').prop('hidden', true);
    updateSelection();
    if (!names.length) {
        $('#status').text('Wpisz przynajmniej jedną nazwę karty.');
        return;
    }
    setBusy(true);
    const rateRequest = fetchEuroRate();
    try {
        for (let index = 0; index < names.length; index += 5) {
            results.push(...await Promise.all(names.slice(index, index + 5).map(name => {
                if (!searches.has(name)) searches.set(name, findCard(name, includeMarket));
                return searches.get(name).then(result => ({ ...result }));
            })));
            $('#status').text(`Sprawdzono ${results.length} z ${names.length} kart.`);
        }
        euroRate = await rateRequest;
        $('#referenceCurrency').text(euroRate ? 'PLN' : 'EUR');
        $('#exchangeRate').text(euroRate
            ? `Kurs średni NBP z ${euroRate.date}: 1 EUR = ${euroRate.value.toFixed(4)} PLN. Przeliczenie orientacyjne.`
            : 'Nie udało się pobrać kursu NBP - ceny Cardmarket pozostają w EUR.');
        renderResults();
        const errors = results.filter(result => result.error).length;
        $('#status').text(`Sprawdzono ${names.length} kart.` +
            (errors ? ` Niepełne wyniki dla ${errors} pozycji - sprawdź oznaczenia sklepów przy kartach.` : ''));
    } finally {
        setBusy(false);
    }
}

function externalLink(url, label) {
    return $('<a>', { href: url, target: '_blank', rel: 'noopener noreferrer' }).text(label);
}

function variantFields(card) {
    return [String(card.expansion_name ?? ''), Number(card.price).toFixed(2) + ' PLN',
        String(card.language ?? ''), card.condition || '-',
        [Number(card.is_foil) === 1 ? 'foil' : '', Number(card.is_signed) === 1 ? 'signed' : '',
            Number(card.is_altered) === 1 ? 'alter' : ''].filter(Boolean).join(', ') || '-',
        card.stock + ' szt.', shopName(card)];
}

function renderResult(result, index, checked = true) {
    const row = $('<tr>');
    const card = result.data;
    if (card) {
        const path = [card.expansion_name, card.id_expansion, card.title, card.id_product, card.id_article]
            .map(encodeURIComponent).join('/');
        const link = externalLink(card.shop === 'market' ? card.url : 'https://mtgspot.pl/single/' + path, card.title).addClass('tooltip');
        // Only HTTPS images are used; API data is never interpreted as HTML.
        if (typeof card.image === 'string' && card.image.startsWith('https://')) {
            link.append($('<span>').append($('<img>', { src: card.image, alt: '', loading: 'lazy' })));
        }
        const language = String(card.language ?? '').trim();
        row.append($('<td>').append(link, $('<small>', { class: 'shop-badge ' + (card.shop === 'market' ? 'shop-market' : 'shop-spot') }).text(shopName(card))), $('<td>').text(language)
            .toggleClass('other-language', !['english', 'eng', 'en'].includes(language.toLowerCase())));
        row.append($('<td>').append($('<i>', { class: 'foil-text' }).text(
            card.is_foil === true || Number(card.is_foil) === 1 ? 'foil' : '')));
        row.append($('<td>', { class: 'card-condition' }).text(card.condition || '-'));
        const edition = $('<td>');
        if (result.variants.length > 1) {
            const menuId = 'variants-' + index;
            const toggle = $('<button>', { type: 'button', class: 'card-variant',
                popovertarget: menuId, 'aria-controls': menuId, 'aria-expanded': 'false',
                'aria-label': 'Wersja karty: ' + result.cardName, title: variantFields(card).join(' / ') })
                .text(card.expansion_name + ' / ' + Number(card.price).toFixed(2) + ' PLN ▾');
            const menu = $('<div>', { id: menuId, class: 'variant-menu', popover: 'auto',
                'aria-label': 'Dostępne wersje: ' + result.cardName });
            const heading = $('<div>', { class: 'variant-heading', 'aria-hidden': 'true' });
            ['', 'Dodatek', 'Cena', 'Język', 'Stan', 'Wersja', 'Dostępność', 'Sklep'].forEach(text => heading.append($('<span>').text(text)));
            menu.append(heading);
            result.variants.forEach((variant, variantIndex) => {
                const option = $('<button>', { type: 'button', class: 'variant-option',
                    'data-index': index, 'data-variant': variantIndex, 'data-shop': variant.shop || 'spot', 'aria-pressed': String(variant === card) });
                const artwork = $('<span>', { class: 'variant-art', title: 'Brak podglądu tej edycji' }).text('-');
                if (typeof variant.image === 'string' && variant.image.startsWith('https://')) {
                    artwork.empty().attr('title', variant.title + ' / ' + variant.expansion_name).append(
                        $('<img>', { src: variant.image, alt: '', loading: 'lazy', width: 52, height: 73 })
                            .on('error', () => artwork.text('-').attr('title', 'Brak podglądu tej edycji')));
                }
                option.append(artwork);
                variantFields(variant).forEach(text => option.append($('<span>').text(text)));
                menu.append(option);
            });
            // The toggle event is asynchronous; keep the menu hidden until it is positioned.
            menu.on('beforetoggle', function() {
                this.style.visibility = 'hidden';
                hideVariantPreview();
            });
            menu.on('scroll', function() {
                const focused = this.querySelector('.variant-option:focus-visible');
                if (focused) showVariantPreview.call(focused);
                else hideVariantPreview();
            });
            menu.on('toggle', function(event) {
                const open = event.originalEvent.newState === 'open';
                toggle.attr('aria-expanded', String(open));
                if (!open) return;
                const rect = toggle[0].getBoundingClientRect();
                const previewWidth = Math.min(240, Math.floor(window.innerWidth * .28));
                menu.css('max-width', window.innerWidth - previewWidth - 36);
                menu.css({ left: Math.max(previewWidth + 24, Math.min(rect.left, window.innerWidth - this.offsetWidth - 8)),
                    top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - this.offsetHeight - 8)),
                    visibility: 'visible' });
                menu.find('[aria-pressed="true"]')[0]?.focus({ preventScroll: true });
            });
            edition.append(toggle, menu);
        } else {
            edition.text(card.expansion_name);
        }
        row.append(edition,
            $('<td>', { class: 'number' }).append($('<b>').text(Number(card.price).toFixed(2))),
            $('<td>', { class: 'number' }).append($('<input>', {
                type: 'checkbox', class: 'add-to-basket', 'data-index': index,
                'aria-label': 'Dodaj do koszyka: ' + card.title, checked
            })));
    } else {
        row.append($('<td>', { colspan: 7, class: 'not-found' })
            .text(result.cardName + (result.error ? ' - błąd pobierania' : '')));
    }
    if (result.errors?.length) row.children().first().append($('<small>', { class: 'shop-error' }).text('Nie pobrano ofert: ' + result.errors.join(', ') + (result.marketError ? ' (' + result.marketError + ')' : '') + '. Wyszukaj ponownie.'));
    row.append(renderReference(result.reference));
    const shops = $('<td>', { class: 'other-shops' });
    for (const [label, url] of [
        ['allegro.pl', 'https://allegro.pl/kategoria/kolekcjonerskie-magic-the-gathering-6066?string='],
        ['morigal.pl', 'https://morigal.pl/search?query=']
    ]) {
        shops.append(externalLink(url + encodeURIComponent(result.cardName), label), ' ');
    }
    return row.append(shops);
}

function renderReference(data) {
    const reference = $('<td>', { class: 'reference-price' });
    if (data && Number.isFinite(data.price)) {
        const eur = data.price.toFixed(2) + ' EUR';
        reference.append(externalLink(data.url, euroRate
            ? '≈ ' + (data.price * euroRate.value).toFixed(2) + ' PLN' : eur));
        if (euroRate) reference.append($('<small>').text(eur));
        reference.append($('<small>').text(data.expansion + (data.foil ? ' · foil' : ' · non-foil')));
    } else {
        reference.text(data?.loading ? 'Pobieranie…' : data?.error ? 'Błąd pobierania' : 'Brak wyceny tej wersji');
    }
    return reference;
}

function hideVariantPreview() {
    const preview = document.getElementById('variantPreview');
    if (preview.matches(':popover-open')) preview.hidePopover();
}

function showVariantPreview() {
    const option = $(this).closest('.variant-option');
    const image = option.find('.variant-art img')[0];
    const menu = option.closest('.variant-menu')[0];
    if (!image || !menu?.matches(':popover-open')) return hideVariantPreview();
    const rect = menu.getBoundingClientRect();
    const width = Math.min(240, rect.left - 24, (window.innerHeight - 16) / 1.4);
    const preview = $('#variantPreview');
    preview.find('img').attr('src', image.src);
    preview.css({ width, left: rect.left - width - 12,
        top: Math.max(8, Math.min(rect.top, window.innerHeight - width * 1.4 - 8)) });
    if (!preview[0].matches(':popover-open')) preview[0].showPopover();
}

function renderResults() {
    const body = $('#resultBody').empty();
    results.forEach((result, index) => body.append(renderResult(result, index)));
    $('#result').show();
    updateSelection();
}

function saveMarketSession(session) {
    marketSession = session;
    try {
        if (session) localStorage.setItem('marketSession', JSON.stringify(session));
        else localStorage.removeItem('marketSession');
    } catch { /* The session still works until the page is closed. */ }
}

async function loginMarket(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
        const request = $.ajax({ url: MARKET_API, type: 'POST', contentType: 'application/json',
            dataType: 'json', timeout: 30000, headers: { 'deenruv-token': 'pl-channel' },
            data: JSON.stringify({ query: `mutation($username: String!, $password: String!) {
                login(username: $username, password: $password, rememberMe: true) {
                    __typename ... on CurrentUser { identifier } ... on ErrorResult { message }
                }
            }`, variables: { username: $('#marketUsername').val().trim(), password: $('#marketPassword').val() } }) });
        const response = await request;
        const user = response.data?.login;
        const token = request.getResponseHeader('deenruv-auth-token');
        if (response.errors?.length || user?.__typename !== 'CurrentUser' || !token) {
            throw new Error(user?.message || 'Nie udało się zalogować.');
        }
        saveMarketSession({ token, login: user.identifier });
        $('#status').text('Zalogowano w Magicznym Rynku. W sklepie użyj tego samego konta.');
    } catch (error) {
        saveMarketSession(null);
        $('#status').text('Magiczny Rynek: ' + (error.message || 'Błąd logowania. Sprawdź dane i spróbuj ponownie.'));
    } finally {
        $('#marketPassword').val('');
        setBusy(false);
    }
}

function marketCartItems(selected) {
    const quantities = new Map();
    selected.forEach(box => {
        const card = results[box.dataset.index].data;
        if (card.shop !== 'market' || !card.variantId) throw new Error('Nieprawidłowa oferta Magicznego Rynku. Wyszukaj karty ponownie.');
        quantities.set(card.variantId, (quantities.get(card.variantId) || 0) + 1);
    });
    return [...quantities].map(([productVariantId, quantity]) => ({ productVariantId, quantity }));
}

function confirmedMarketItems(selected, before, after) {
    const quantities = order => {
        const map = new Map();
        for (const line of order?.lines || []) {
            const id = String(line.productVariant.id);
            map.set(id, (map.get(id) || 0) + line.quantity);
        }
        return map;
    };
    const previous = quantities(before), current = quantities(after);
    const added = new Map([...current].map(([id, count]) => [id, Math.max(0, count - (previous.get(id) || 0))]));
    let confirmed = 0;
    selected.forEach(box => {
        const id = results[box.dataset.index].data.variantId;
        if (added.get(id) > 0) {
            box.checked = false;
            added.set(id, added.get(id) - 1);
            confirmed++;
        }
    });
    return confirmed;
}

async function addToMarketBasket(event) {
    if (busy || !marketSession) return;
    const selected = $('.add-to-basket:checked').toArray().filter(box => results[box.dataset.index].data.shop === 'market');
    if (!selected.length) return;
    const token = marketSession.token;
    $('#status').empty();
    setBusy(true);
    const bar = $(event.currentTarget).closest('.cart-bar');
    const feedback = $('#cartFeedback').insertAfter(bar).prop('hidden', false).removeClass('cart-warning');
    const message = $('#cartMessage').text('Dodaję karty do Magicznego Rynku…');
    const link = $('#orderLink').attr('href', 'https://magicznyrynek.pl/').text('Otwórz Magiczny Rynek →').prop('hidden', true);
    let submitted = false;
    try {
        const input = marketCartItems(selected);
        const before = await marketQuery(`{ activeCustomer { emailAddress }
            activeOrder { lines { quantity productVariant { id } } } }`, {}, token);
        if (!before.activeCustomer || before.activeCustomer.emailAddress.toLowerCase() !== marketSession.login.toLowerCase()) {
            saveMarketSession(null);
            throw new Error('Sesja wygasła - zaloguj się ponownie.');
        }
        submitted = true;
        // One batch, no automatic retries. Stock errors can still partially change an order.
        const response = await marketQuery(`mutation($input: [AddItemsToOrderItemInput!]!) {
            addItemsToOrder(input: $input) { __typename
                ... on Order { lines { quantity productVariant { id } } }
                ... on ErrorResult { message }
                ... on InsufficientStockError { order { lines { quantity productVariant { id } } } }
            }
        }`, { input }, token);
        const result = response.addItemsToOrder;
        const after = result?.__typename === 'Order' ? result : result?.order;
        const added = confirmedMarketItems(selected, before.activeOrder, after);
        const complete = result?.__typename === 'Order' && added === selected.length;
        message.text(`Magiczny Rynek: dodano ${added} z ${selected.length} kart.` +
            (complete ? ' W sklepie zaloguj się na to samo konto i otwórz koszyk.' :
                ' ' + (result?.message || 'Nie potwierdzono wszystkich pozycji.') + ' Sprawdź koszyk przed ponowieniem.'));
        feedback.toggleClass('cart-warning', !complete);
    } catch (error) {
        if ([401, 403].includes(error.status)) saveMarketSession(null);
        feedback.addClass('cart-warning');
        message.text('Magiczny Rynek: ' + (error.message || 'Błąd połączenia.') +
            (submitted ? ' Koszyk mógł zostać zmieniony - sprawdź go przed ponowieniem.' : ''));
    } finally {
        link.prop('hidden', false);
        feedback[0].scrollIntoView({ block: 'nearest' });
        link[0].focus({ preventScroll: true });
        setBusy(false);
        updateSelection();
    }
}

async function addToBasket(event) {
    if (busy) return;
    const token = getCredentialsItem('access_token');
    const selected = selectedSpotBoxes();
    if (!token || !selected.length) {
        $('#status').text(token ? 'Zaznacz karty do dodania.' : 'Zaloguj się, aby dodać karty do koszyka.');
        updateLoginState();
        return;
    }
    setBusy(true);
    $('#status').empty();
    $('#orderLink').attr('href', 'https://mtgspot.pl/order').text('Otwórz koszyk MTG Spot →').prop('hidden', true);
    const bar = event?.currentTarget ? $(event.currentTarget).closest('.cart-bar') : $('.cart-bar').first();
    const feedback = $('#cartFeedback').insertAfter(bar).prop('hidden', false).removeClass('cart-warning');
    const message = $('#cartMessage').text(`Dodawanie kart: 0 z ${selected.length}…`);
    let added = 0;
    let completed = 0;
    let next = 0;
    let unauthorized = false;
    const failed = [];
    try {
        // Five workers keep requests moving; never automatically retry a cart POST.
        await Promise.all(Array.from({ length: Math.min(5, selected.length) }, async () => {
            while (next < selected.length && !unauthorized) {
                const checkbox = selected[next++];
                const card = results[checkbox.dataset.index].data;
                try {
                    await $.ajax({
                        url: SHOP_API + '/carts/single', type: 'POST', timeout: 30000,
                        data: { quantity: 1, id_article: card.id_article },
                        headers: { Authorization: 'Bearer ' + token, 'x-api-key': API_KEY }
                    });
                    checkbox.checked = false;
                    added++;
                } catch (error) {
                    failed.push(card.title);
                    if (error.status === 401) {
                        unauthorized = true;
                        clearCredentials();
                    }
                } finally {
                    message.text(`Dodawanie kart: ${++completed} z ${selected.length}…`);
                }
            }
        }));
        message.text(`Dodano ${added} z ${selected.length} kart.` + (failed.length
            ? ` Błąd: ${failed.join(', ')}. Sprawdź koszyk przed ponowieniem.` : '') +
            (unauthorized ? ' Sesja wygasła - zaloguj się ponownie. Pozostałe żądania zostały wstrzymane.' : ''));
        feedback.toggleClass('cart-warning', failed.length > 0);
        $('#orderLink').prop('hidden', false);
        feedback[0].scrollIntoView({ block: 'nearest', behavior: 'auto' });
        $('#orderLink')[0].focus({ preventScroll: true });
    } finally {
        setBusy(false);
        updateSelection();
    }
}

function updateSelection() {
    const all = $('.add-to-basket');
    const selected = all.filter(':checked');
    let cents = 0, marketCents = 0;
    selected.each(function() {
        const card = results[this.dataset.index].data;
        const price = Math.round(Number(card.price) * 100);
        cents += price;
        if (card.shop === 'market') marketCents += price;
    });
    $('.selection-breakdown').text('MTG Spot: ' + ((cents - marketCents) / 100).toFixed(2) + ' PLN' +
        (marketCents ? '\nMagiczny Rynek: ' + (marketCents / 100).toFixed(2) + ' PLN' : ''));
    $('#totalPrice, #selectedPrice').text((cents / 100).toFixed(2));
    $('.cart-bar').prop('hidden', results.length === 0);
    $('#selectAll').prop({ checked: all.length > 0 && selected.length === all.length,
        indeterminate: selected.length > 0 && selected.length < all.length });
    updateLoginState();
}

function setBusy(value) {
    busy = value;
    $('#marketLoginButton, #marketLogoutButton, #marketUsername, #marketPassword, #includeMarket, #searchButton, #loginButton, #logoutButton, #selectAll, .add-to-basket, .card-variant').prop('disabled', busy);
    $('#loadingOverlay').prop('hidden', !busy);
    $('#result').attr('aria-busy', String(busy));
    updateLoginState();
}

function updateLoginState() {
    const token = getCredentialsItem('access_token');
    $('#login-container').prop('hidden', Boolean(token));
    $('#logout-container').prop('hidden', !token);
    $('#logged-username').text(getCredentialsItem('login') || '');
    $('.add-to-basket-button').prop('disabled', busy || !token || !selectedSpotBoxes().length);
    $('#marketLoginForm').prop('hidden', Boolean(marketSession));
    $('#marketLoggedIn').prop('hidden', !marketSession);
    $('#marketLoggedUsername').text(marketSession?.login || '');
    $('.add-to-market-button').prop('disabled', busy || !marketSession || !$('.add-to-basket:checked').toArray().some(box => results[box.dataset.index].data.shop === 'market'));
}

function clearCredentials() {
    credentials = null;
    try { localStorage.removeItem('objToken'); } catch { /* Storage can be disabled. */ }
}

function getCredentialsItem(item) {
    if (!credentials) {
        try { credentials = JSON.parse(localStorage.getItem('objToken')); } catch { clearCredentials(); }
    }
    if (!credentials || !Number.isFinite(credentials.expiration) || Date.now() >= credentials.expiration) {
        clearCredentials();
        return null;
    }
    return credentials[item];
}

function setCredentials(response, login) {
    if (typeof response?.access_token !== 'string' || !response.access_token) throw new Error('Missing token');
    const lifetime = Number(response.expires_in);
    credentials = { access_token: response.access_token, login: response.login || login,
        expiration: Date.now() + (lifetime > 0 && Number.isFinite(lifetime) ? lifetime * 1000 : 6 * 86400000) };
    try {
        localStorage.setItem('objToken', JSON.stringify(credentials));
        return true;
    } catch {
        return false;
    }
}

$(function() {
    try {
        const session = JSON.parse(localStorage.getItem('marketSession'));
        if (typeof session?.token === 'string' && session.token && typeof session.login === 'string' && session.login) marketSession = session;
    } catch { /* Ignore missing or invalid saved sessions. */ }
    $('#marketLoginForm').on('submit', loginMarket);
    $('#marketLogoutButton').on('click', async function() {
        if (busy || !marketSession) return;
        const token = marketSession.token;
        saveMarketSession(null);
        setBusy(true);
        try { await marketQuery('mutation { logout { success } }', {}, token); }
        catch { $('#status').text('Wylogowano lokalnie. Nie udało się potwierdzić zakończenia sesji w sklepie.'); }
        finally { setBusy(false); }
    });
    $('.add-to-market-button').on('click', addToMarketBasket);
    $('#contact-email').text(atob('c2ViYXN0aWFuQG5vd2FrLm5pbmph'));
    try { $('#includeMarket').prop('checked', localStorage.getItem('includeMarket') !== 'false'); } catch { /* Use the default when storage is blocked. */ }
    $('#includeMarket').on('change', function() {
        try { localStorage.setItem('includeMarket', String(this.checked)); } catch { /* Search still works without storage. */ }
    });
    updateLoginState();
    $('#searchButton').on('click', searchSingles);
    $('.add-to-basket-button').on('click', addToBasket);
    $('#login-container').on('submit', async function(event) {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
            const login = $('#username').val().trim();
            const response = await $.ajax({
                url: SHOP_API + '/users/token', type: 'POST', dataType: 'json', timeout: 30000,
                data: { username: login, password: $('#password').val(), grant_type: 'password', client_id: 'MtgSpot' },
                headers: { 'x-api-key': API_KEY }
            });
            const saved = setCredentials(response, login);
            $('#status').text(saved ? 'Zalogowano.' : 'Zalogowano tylko na czas otwarcia strony - zapis w przeglądarce jest niedostępny.');
        } catch {
            $('#status').text('Wystąpił błąd podczas logowania. Sprawdź dane i spróbuj ponownie.');
        } finally {
            $('#password').val('');
            setBusy(false);
        }
    });
    $('#logoutButton').on('click', function() {
        if (busy) return;
        clearCredentials();
        updateLoginState();
        $('#status').text('Wylogowano.');
    });
    $('#selectAll').on('change', function() {
        $('.add-to-basket').prop('checked', this.checked);
        updateSelection();
    });
    $(document).on('change', '.add-to-basket', updateSelection);
    $(document).on('click', '.variant-option', async function() {
        if (busy) return;
        const index = Number(this.dataset.index);
        const result = results[index];
        const card = result?.variants[Number(this.dataset.variant)];
        if (!card) return;
        $(this).closest('.variant-menu')[0].hidePopover();
        result.data = card;
        result.reference = { loading: true };
        const row = $(this).closest('tr');
        const replacement = renderResult(result, index, row.find('.add-to-basket').prop('checked'));
        row.replaceWith(replacement);
        replacement.find('.card-variant').trigger('focus');
        updateSelection();
        const reference = await findReference(result.cardName, card);
        if (results[index] !== result || result.data !== card) return;
        result.reference = reference;
        $('#resultBody tr').eq(index).find('.reference-price').replaceWith(renderReference(reference));
    });
    $(document).on('mouseenter', '.variant-option', showVariantPreview);
    $(document).on('mouseleave', '.variant-option', hideVariantPreview);
    $(document).on('focusin', '.variant-option', showVariantPreview);
    $(document).on('focusout', '.variant-option', hideVariantPreview);
    $('#variantPreview img').on('error', hideVariantPreview);
    $(document).on('keydown', '.variant-option', function(event) {
        const options = $(this).siblings('.variant-option').addBack().toArray();
        const current = options.indexOf(this);
        const target = { ArrowDown: (current + 1) % options.length,
            ArrowUp: (current + options.length - 1) % options.length,
            Home: 0, End: options.length - 1 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        options[target].focus();
    });
    $(document).on('mousemove focusin', '.tooltip', function(event) {
        const tooltip = $(this).find('span');
        const rect = this.getBoundingClientRect();
        const x = event.clientX ?? rect.left;
        const y = event.clientY ?? rect.bottom;
        tooltip.css({
            left: Math.max(8, Math.min(x + 20, window.innerWidth - tooltip.outerWidth() - 8)),
            top: Math.max(8, Math.min(y + 20, window.innerHeight - tooltip.outerHeight() - 8))
        });
    });
    window.addEventListener('storage', function(event) {
        if (event.key === 'objToken' || event.key === null) {
            credentials = null;
            updateLoginState();
        }
    });
});
