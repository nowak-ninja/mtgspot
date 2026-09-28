// Run with: node test.cjs (no packages required).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
    const storage = new Map();
    const context = vm.createContext({
        $: () => {},
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
    assert.equal(run("cheapestCard(cards, 'Sol Ring').price"), '1.50');
    assert.equal(run("cheapestCard(cards, 'Missing')"), undefined);
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
    assert.equal((await run("findCard('Sol Ring')")).data.price, 1);
    assert.deepEqual(offsets, [0, 300]);
    context.$.ajax = async () => { throw new Error('offline'); };
    assert.equal((await run("findCard('Sol Ring')")).error, true);

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
    console.log('OK: parsing, cheapest card, pagination, failed requests, credentials, theme');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
