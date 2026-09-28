'use strict';

const API_KEY = 'b3d39321-5dc4-4298-98c6-0399432a948b';
const SHOP_API = 'https://gateway.mtgspot.pl/api/shop';
let results = [];
let busy = false;
let credentials = null;

function parseCards(text) {
    // Quantities in deck exports are ignored: one line still means one copy.
    return text.split(/\r?\n/).map(line => line.trim().replace(/^\d+\s+/, '').trim()).filter(Boolean);
}

function cheapestCard(cards, name) {
    return cards.filter(card => card && Number(card.stock) > 0 &&
        !['Tip Card', 'Token'].includes(card.rarity) &&
        typeof card.title === 'string' && card.title.toLowerCase() === name.toLowerCase() &&
        card.price !== null && String(card.price).trim() !== '' &&
        Number.isFinite(Number(card.price)) && Number(card.price) >= 0)
        .sort((a, b) => Number(a.price) - Number(b.price))[0];
}

async function findCard(cardName) {
    try {
        let best;
        for (let offset = 0; ; offset += 300) {
            const response = await $.ajax({
                url: 'https://mtgspot.cn-panel.pl/products',
                data: { s_title: cardName, limit: 300, offset, order_by: 'title', sort_by: 'asc' },
                dataType: 'json', timeout: 30000
            });
            if (!Array.isArray(response?.data)) throw new Error('Invalid product response');
            best = cheapestCard([...response.data, ...(best ? [best] : [])], cardName);
            if (response.data.length < 300 || offset + 300 >= Number(response.count)) break;
        }
        return { cardName, data: best };
    } catch {
        return { cardName, error: true };
    }
}

async function searchSingles() {
    if (busy) return;
    const names = parseCards($('#cards').val());
    results = [];
    $('#resultBody').empty();
    $('#result').hide();
    $('#orderLink').prop('hidden', true);
    updateSelection();
    if (!names.length) {
        $('#status').text('Wpisz przynajmniej jedną nazwę karty.');
        return;
    }
    setBusy(true);
    try {
        for (let index = 0; index < names.length; index += 5) {
            results.push(...await Promise.all(names.slice(index, index + 5).map(findCard)));
            $('#status').text(`Sprawdzono ${results.length} z ${names.length} kart.`);
        }
        renderResults();
        const errors = results.filter(result => result.error).length;
        $('#status').text(`Sprawdzono ${names.length} kart.` +
            (errors ? ` Błąd pobierania ${errors} pozycji - spróbuj ponownie.` : ''));
    } finally {
        setBusy(false);
    }
}

function externalLink(url, label) {
    return $('<a>', { href: url, target: '_blank', rel: 'noopener noreferrer' }).text(label);
}

function renderResults() {
    const body = $('#resultBody').empty();
    results.forEach((result, index) => {
        const row = $('<tr>');
        const card = result.data;
        if (card) {
            const path = [card.expansion_name, card.id_expansion, card.title, card.id_product, card.id_article]
                .map(encodeURIComponent).join('/');
            const link = externalLink('https://mtgspot.pl/single/' + path, card.title).addClass('tooltip');
            // Only HTTPS images are used; API data is never interpreted as HTML.
            if (typeof card.image === 'string' && card.image.startsWith('https://')) {
                link.append($('<span>').append($('<img>', { src: card.image, alt: '', loading: 'lazy' })));
            }
            row.append($('<td>').append(link), $('<td>').text(String(card.language ?? '').slice(0, 3)));
            for (const [key, label, className] of [
                ['is_foil', 'foil', 'foil-text'], ['is_signed', 'signed', 'signed'], ['is_altered', 'alt', 'altered']
            ]) {
                row.append($('<td>').append($('<i>', { class: className }).text(
                    card[key] === true || Number(card[key]) === 1 ? label : '')));
            }
            row.append($('<td>').text(card.expansion_name),
                $('<td>', { class: 'number' }).append($('<b>').text(Number(card.price).toFixed(2))),
                $('<td>', { class: 'number' }).append($('<input>', {
                    type: 'checkbox', class: 'add-to-basket', 'data-index': index,
                    'aria-label': 'Dodaj do koszyka: ' + card.title, checked: true
                })));
        } else {
            row.append($('<td>', { colspan: 8, class: 'not-found' })
                .text(result.cardName + (result.error ? ' - błąd pobierania' : ' - brak na stanie')));
        }
        const shops = $('<td>', { class: 'other-shops' });
        for (const [label, url] of [
            ['allegro.pl', 'https://allegro.pl/kategoria/kolekcjonerskie-magic-the-gathering-6066?string='],
            ['morigal.pl', 'https://morigal.pl/search?query='],
            ['magicznyrynek.pl', 'https://magicznyrynek.pl/search/?term=']
        ]) {
            shops.append(externalLink(url + encodeURIComponent(result.cardName), label), ' ');
        }
        body.append(row.append(shops));
    });
    $('#result').show();
    updateSelection();
}

async function addToBasket() {
    if (busy) return;
    const token = getCredentialsItem('access_token');
    const selected = $('.add-to-basket:checked').toArray();
    if (!token || !selected.length) {
        $('#status').text(token ? 'Zaznacz karty do dodania.' : 'Zaloguj się, aby dodać karty do koszyka.');
        updateLoginState();
        return;
    }
    setBusy(true);
    $('#orderLink').prop('hidden', true);
    let added = 0;
    const failed = [];
    try {
        // Cart writes are sequential; never retry a POST automatically after a timeout.
        for (const checkbox of selected) {
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
                    clearCredentials();
                    break;
                }
            }
        }
        $('#status').text(`Dodano ${added} z ${selected.length} kart.` + (failed.length
            ? ` Błąd: ${failed.join(', ')}. Sprawdź koszyk przed ponowieniem; niezaznaczone pozycje zostały dodane. Przy wygasłej sesji zaloguj się ponownie.`
            : ' Otwórz koszyk MTG Spot.'));
        $('#orderLink').prop('hidden', false);
    } finally {
        setBusy(false);
        updateSelection();
    }
}

function updateSelection() {
    const all = $('.add-to-basket');
    const selected = all.filter(':checked');
    let cents = 0;
    selected.each(function() { cents += Math.round(Number(results[this.dataset.index].data.price) * 100); });
    $('#totalPrice').text((cents / 100).toFixed(2));
    $('#selectAll').prop({ checked: all.length > 0 && selected.length === all.length,
        indeterminate: selected.length > 0 && selected.length < all.length });
    updateLoginState();
}

function setBusy(value) {
    busy = value;
    $('#searchButton, #loginButton, #logoutButton, #selectAll, .add-to-basket').prop('disabled', busy);
    $('#loadingOverlay').prop('hidden', !busy);
    $('#result').attr('aria-busy', String(busy));
    updateLoginState();
}

function updateLoginState() {
    const token = getCredentialsItem('access_token');
    $('#login-container').prop('hidden', Boolean(token));
    $('#logout-container').prop('hidden', !token);
    $('#logged-username').text(getCredentialsItem('login') || '');
    $('#addToBasketButton').prop('disabled', busy || !token || !$('.add-to-basket:checked').length);
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
    updateLoginState();
    $('#searchButton').on('click', searchSingles);
    $('#addToBasketButton').on('click', addToBasket);
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
