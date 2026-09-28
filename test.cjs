// Run with: node test.cjs (no packages required).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
    const storage = new Map();
    const context = vm.createContext({
        $: () => {}, URL, atob,
        setTimeout: callback => setTimeout(callback, 0),
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        }
    });
    vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
    const run = source => vm.runInContext(source, context);
    assert.equal(JSON.stringify(context.parseCards(" 4 Sol Ring\r\n\nMana Crypt\n2 Black Lotus ")),
        JSON.stringify(['Sol Ring', 'Mana Crypt', 'Black Lotus']));
    assert.equal(context.parseCards(" \n\t").length, 0);
    // A number attached to a name is not a deck quantity.
    assert.equal(run("parseCards('7Dwarves')[0]"), '7Dwarves');
    context.cards = [
        { title: 'Sol Ring', stock: '0', price: 0 },
        { title: 'Sol Ring', stock: 1, price: null },
        { title: 'Sol Ring', stock: 1, price: '' },
        { title: 'Sol Ring', stock: 1, price: 'invalid' },
        { title: 'Sol Ring', stock: 1, price: -1 },
        { title: 'Sol Ring', stock: 1, price: 0, rarity: 'Token' },
        { title: 'Sol Ring', stock: 1, price: 0, rarity: 'Tip Card' },
        { title: 'Sol Ring Extended', stock: 1, price: 1 },
        { title: 'Sol Ring', stock: 1, price: '2.50' },
        { title: 'sol ring', stock: '1', price: '1.50' }
    ];
    assert.equal(run("availableCards(cards, 'Sol Ring')[0].price"), '1.50');
    assert.equal(run("availableCards(cards, 'Missing').length"), 0);
    assert.equal(run("availableCards(cards, 'Sol Ring').length"), 2);
    const fields = context.variantFields({ expansion_name: 'Short', language: 'English',
        condition: 'NM', price: 2.5, stock: 1, is_foil: 1 });
    assert.deepEqual(Array.from(fields), ['Short', '2.50 PLN', 'English', 'NM', 'foil', '1 szt.', 'MTG Spot']);
    storage.set('objToken', '{broken');
    assert.equal(run("getCredentialsItem('access_token')"), null);
    assert.equal(storage.has('objToken'), false);
    storage.set('objToken', JSON.stringify({ access_token: 'old', expiration: 1 }));
    assert.equal(run("getCredentialsItem('access_token')"), null);
    assert.throws(() => run("setCredentials({}, 'test')"), /Missing token/);
    run("setCredentials({ access_token: 'test', expires_in: 60 }, 'user')");
    assert.equal(run("getCredentialsItem('login')"), 'user');
    assert.ok(JSON.parse(storage.get('objToken')).expiration - Date.now() <= 60000);
    context.localStorage.setItem = () => { throw new Error('blocked'); };
    assert.equal(run("setCredentials({ access_token: 'session' }, 'user')"), false);
    assert.equal(run("getCredentialsItem('access_token')"), 'session');
    const offsets = [];
    context.$.ajax = async ({ data }) => {
        offsets.push(data.offset);
        return { count: 301, data: data.offset === 0
            ? Array.from({ length: 300 }, () => ({ title: 'Sol Ring', stock: 1, price: 5 }))
            : [{ title: 'Sol Ring', stock: 1, price: 1 }] };
    };
    const found = await run("findSpotCard('Sol Ring')");
    assert.equal(found.data.price, 1);
    assert.equal(found.variants.length, 301);
    assert.equal(found.variants[300].price, 5);
    assert.deepEqual(offsets, [0, 300]);
    context.$.ajax = async () => { throw new Error('offline'); };
    assert.equal((await run("findSpotCard('Sol Ring')")).error, true);

    const product = { name: 'Sol Ring', slug: 'sol-ring', variants: [{ id: '9', stockLevel: '2',
        priceWithTax: 549, currencyCode: 'PLN',
        facetValues: [{ code: 'Single', facet: { code: 'type' } },
            { name: 'Fallout', facet: { code: 'expansion' } }],
        options: [{ code: 'english', name: 'English', group: { code: 'language' } },
            { code: 'EX', group: { code: 'condition' } }, { code: 'foil', group: { code: 'foil' } }] }] };
    product.featuredAsset = { preview: 'https://example.test/edition.jpg' };
    assert.equal(context.marketVariants(product, 'Sol Ring')[0].image, product.featuredAsset.preview);
    product.variants[0].featuredAsset = { preview: 'https://example.test/variant.jpg' };
    const marketCard = context.marketVariants(product, 'Sol Ring')[0];
    assert.equal(marketCard.image, product.variants[0].featuredAsset.preview);
    assert.equal(marketCard.price, 5.49);
    assert.equal(marketCard.condition, 'EX');
    assert.equal(marketCard.is_foil, 1);
    assert.equal(marketCard.shop, 'market');
    assert.ok(marketCard.url.endsWith('/sol-ring/9/'));
    assert.equal(context.marketVariants(product, 'Sol Ring Extended').length, 0);
    for (const patch of [{ stockLevel: '0' }, { priceWithTax: null }, { currencyCode: 'EUR' }, { stockLevel: 'IN_STOCK' }]) {
        assert.equal(context.marketVariants({ ...product, variants: [{ ...product.variants[0], ...patch }] }, 'Sol Ring').length, 0);
    }
    let marketPages = 0;
    context.$.ajax = async ({ data }) => {
        const { query, variables } = JSON.parse(data);
        if (query.includes('search(')) {
            marketPages++;
            return { data: { search: { totalItems: 101, items: variables.skip === 0
                ? Array.from({ length: 100 }, () => ({ productName: 'Other', slug: 'other' }))
                : [{ productName: 'Sol Ring', slug: 'sol-ring' }] } } };
        }
        return { data: { p0: product } };
    };
    assert.equal((await context.findMarketCards('Sol Ring'))[0].price, 5.49);
    assert.equal(marketPages, 2);
    // Apostrophes must be removed only from the search term, never the exact-name filter.
    context.$.ajax = async ({ data }) => {
        const { query, variables } = JSON.parse(data);
        if (query.includes('search(')) {
            assert.equal(variables.term, 'Smugglers Copter');
            return { data: { search: { totalItems: 2, items: [
                { productName: "Smuggler's Copter", slug: 'exact' },
                { productName: 'Smugglers Copter', slug: 'wrong-card' }
            ] } } };
        }
        assert.ok(!query.includes('wrong-card'));
        return { data: { p0: { ...product, name: "Smuggler's Copter" } } };
    };
    assert.equal((await context.findMarketCards("Smuggler's Copter"))[0].title, "Smuggler's Copter");
    context.$.ajax = async () => ({ errors: [{ message: 'GraphQL failure' }] });
    await assert.rejects(context.findMarketCards('Sol Ring'));

    context.$.ajax = async () => ({ code: 'EUR', rates: [{ mid: 4.3769, effectiveDate: '2026-09-28' }] });
    const euroRate = await context.fetchEuroRate();
    assert.equal(euroRate.value, 4.3769);
    assert.equal(euroRate.date, '2026-09-28');
    assert.equal((0.81 * euroRate.value).toFixed(2), '3.55');
    for (const response of [{}, { code: 'USD', rates: [{ mid: 4, effectiveDate: '2026-09-28' }] },
        { code: 'EUR', rates: [{ mid: 0, effectiveDate: '2026-09-28' }] },
        { code: 'EUR', rates: [{ mid: 4, effectiveDate: 'invalid' }] }]) {
        context.$.ajax = async () => response;
        assert.equal(await context.fetchEuroRate(), null);
    }
    context.$.ajax = async () => { throw new Error('offline'); };
    assert.equal(await context.fetchEuroRate(), null);

    const edition = { image: 'https://cards.magicznyrynek.aexol.work/1/SET/123/123.jpg', is_foil: 0 };
    assert.equal(context.cardmarketId(edition), 123);
    assert.equal(context.cardmarketId({ image: 'https://gateway.mtgspot.pl/imagecache/single?key=' +
        btoa('https://product-images.s3.cardmarket.com/1/SET/123/123.jpg') }), 123);
    assert.equal(context.cardmarketId({ image: 'https://example.test/123/123.jpg' }), null);
    let priceRequests = 0;
    context.$.ajax = async () => { priceRequests++; return {cardmarket_id:123,name:'Sol Ring',set_name:'Fixture',prices:{eur:'1.23',eur_foil:'4.56'}}; };
    assert.equal((await context.findReference('Sol Ring', edition)).price, 1.23);
    assert.equal((await context.findReference('Sol Ring', edition)).price, 1.23);
    assert.equal(priceRequests, 1);
    assert.equal((await context.findReference('Sol Ring', { ...edition, is_foil: 1 })).price, 4.56);
    assert.equal(priceRequests, 2);
    run('referenceCache.clear()');
    context.$.ajax = async () => ({cardmarket_id:123,name:'Sol Ring',prices:{eur:'1.23',eur_foil:null}});
    assert.equal(await context.findReference('Sol Ring', { ...edition, is_foil: 1 }), null);

    // Store failures must not hide another store's offers; disabling the extra store makes no call.
    const combined = vm.createContext({ $: () => {}, setTimeout });
    vm.runInContext(fs.readFileSync('app.js', 'utf8'), combined);
    combined.findSpotCard = async () => ({ error: true });
    combined.findMarketCards = async () => [marketCard];
    combined.findReference = async () => null;
    const mixed = await combined.findCard('Sol Ring', true);
    assert.equal(mixed.data.shop, 'market');
    assert.equal(mixed.errors[0], 'MTG Spot');
    combined.findSpotCard = async () => ({ variants: [{ price: 8 }] });
    combined.findMarketCards = async () => { throw new Error('offline'); };
    assert.equal((await combined.findCard('Sol Ring', true)).errors[0], 'Magiczny Rynek');
    const spotOnly = await combined.findCard('Sol Ring', false);
    assert.equal(spotOnly.error, false);
    assert.equal(spotOnly.data.price, 8);

    const preferences = [
        { shop: 'market', language: 'English', price: 1 },
        { shop: 'spot', language: 'Japanese', price: 2 },
        { shop: 'spot', language: 'English', price: 3 },
        { shop: 'spot', language: 'Eng', price: 4 }
    ];
    assert.equal(context.defaultVariant(preferences), preferences[2]);
    assert.equal(context.defaultVariant(preferences.slice(0, 2)), preferences[1]);
    assert.equal(context.defaultVariant(preferences.slice(0, 1)), preferences[0]);
    assert.equal(context.defaultVariant([]), undefined);
    assert.equal(context.defaultVariant([{shop:'market',language:'Italian',price:1}, preferences[0]]), preferences[0]);
    assert.equal(context.marketSearchError({status:429}), 'limit zapytań sklepu');
    assert.equal(context.marketSearchError({statusText:'timeout'}), 'przekroczono czas oczekiwania');

    const marketBoxes = [0, 1, 2].map(index => ({ dataset: { index }, checked: true }));
    run("results = [{data:{shop:'market',variantId:'9'}},{data:{shop:'market',variantId:'9'}},{data:{shop:'market',variantId:'10'}}];");
    assert.equal(JSON.stringify(context.marketCartItems(marketBoxes)), JSON.stringify([
        { productVariantId: '9', quantity: 2 }, { productVariantId: '10', quantity: 1 }]));
    const previousOrder = { lines: [{ quantity: 3, productVariant: { id: '9' } }] };
    const partialOrder = { lines: [{ quantity: 4, productVariant: { id: '9' } }] };
    assert.equal(context.confirmedMarketItems(marketBoxes, previousOrder, partialOrder), 1);
    assert.equal(marketBoxes.filter(box => box.checked).length, 2);
    assert.equal(marketBoxes[2].checked, true);
    assert.equal(context.confirmedMarketItems(marketBoxes, previousOrder, null), 0);
    run("results[2].data.shop = 'spot'");
    assert.throws(() => context.marketCartItems(marketBoxes), /Nieprawidłowa oferta/);

    // Exercise the real cart queue with in-memory controls and delayed HTTP responses.
    const boxes = Array.from({ length: 12 }, (_, index) => ({ dataset: { index }, checked: true }));
    const control = { 0: { scrollIntoView() {}, focus() {} }, length: boxes.length,
        toArray: () => boxes.filter(box => box.checked) };
    for (const method of ['prop', 'attr', 'empty', 'closest', 'first', 'insertAfter', 'removeClass', 'addClass', 'toggleClass', 'text']) {
        control[method] = () => control;
    }
    context.$ = () => control;
    context.cartBoxes = boxes;
    run("results = cartBoxes.map((_, index) => ({ data: { id_article: index, title: 'Card ' + index, shop: index === 11 ? 'market' : 'spot' } }));");
    run("setBusy = value => { busy = value; }; updateSelection = () => {}; updateLoginState = () => {};");
    let active = 0, peak = 0, sent = 0;
    context.$.ajax = async ({ data }) => {
        sent++;
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        if (data.id_article === 3) throw { status: 500 };
    };
    await Promise.all([run('addToBasket()'), run('addToBasket()')]);
    assert.equal(peak, 5);
    assert.equal(sent, 11); // No duplicate writes and no Magiczny Rynek offers sent to MTG Spot.
    assert.equal(boxes.filter(box => box.checked).length, 2);
    assert.equal(boxes[11].checked, true);
    assert.equal(boxes[3].checked, true); // A failed POST is neither cleared nor retried.
    boxes.forEach(box => { box.checked = true; });
    sent = 0;
    context.$.ajax = async ({ data }) => {
        sent++;
        await new Promise(resolve => setTimeout(resolve, data.id_article === 0 ? 1 : 10));
        if (data.id_article === 0) throw { status: 401 };
    };
    await run('addToBasket()');
    assert.equal(sent, 5); // Let in-flight writes settle but stop dispatch after a 401.
    assert.equal(run("getCredentialsItem('access_token')"), null);

    let change, loaded, selectChange;
    const select = { value: '', addEventListener: (_, callback) => { selectChange = callback; } };
    const system = { matches: true, addEventListener: (_, callback) => { change = callback; } };
    const document = { documentElement: { dataset: {} },
        addEventListener: (_, callback) => { loaded = callback; }, getElementById: () => select };
    const themeContext = vm.createContext({ document, window: { matchMedia: () => system }, localStorage: context.localStorage });
    vm.runInContext(fs.readFileSync('theme.js', 'utf8'), themeContext);
    assert.equal(document.documentElement.dataset.theme, 'dark');
    loaded();
    select.value = 'light';
    selectChange(); // blocked storage must not prevent switching
    assert.equal(document.documentElement.dataset.theme, 'light');
    change();
    assert.equal(document.documentElement.dataset.theme, 'light');
    select.value = 'system';
    selectChange();
    system.matches = false;
    change();
    assert.equal(document.documentElement.dataset.theme, 'light');
    system.matches = true;
    change();
    assert.equal(document.documentElement.dataset.theme, 'dark');
    console.log('OK: parsing, available variants, pagination, failed requests, credentials, multi-shop offers, reference prices, cart isolation/concurrency, theme');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
