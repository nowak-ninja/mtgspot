'use strict';

// Run before the stylesheet to avoid flashing the wrong theme on reload.
let theme = 'system';
try { theme = localStorage.getItem('theme') || 'system'; } catch { /* Use system default. */ }
if (!['system', 'light', 'dark'].includes(theme)) theme = 'system';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
    document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
}
applyTheme();
systemTheme.addEventListener('change', applyTheme);
document.addEventListener('DOMContentLoaded', function() {
    const select = document.getElementById('theme');
    select.value = theme;
    select.addEventListener('change', function() {
        theme = select.value;
        try { localStorage.setItem('theme', theme); } catch { /* Keep the choice for this page. */ }
        applyTheme();
    });
});
