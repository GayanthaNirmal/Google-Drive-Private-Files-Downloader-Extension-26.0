// Puts the downloader panel in a fixed sidebar on the right of Drive / Docs pages.
// The panel itself is popup.html, loaded in an iframe so it keeps its own
// styles and extension APIs; a shadow root keeps Drive's CSS away from it.
(() => {
    if (window.top !== window) return;
    if (document.getElementById('ddl-sidebar-host')) return;

    const WIDTH = 340;
    // Hidden / shown with the toolbar icon. (New key: a state saved by the old
    // edge handle must not leave the sidebar hidden with no way to open it.)
    const STORAGE_KEY = 'sidebarHidden';

    let wrap = null;

    function setCollapsed(collapsed) {
        if (!wrap) return;
        wrap.classList.toggle('collapsed', collapsed);
    }

    function toggle() {
        const collapsed = !wrap.classList.contains('collapsed');
        setCollapsed(collapsed);
        try { chrome.storage.local.set({ [STORAGE_KEY]: collapsed }); } catch (e) {}
    }

    // Built with DOM calls only (no innerHTML): Google pages enforce Trusted
    // Types, which rejects HTML strings.
    const CSS = `
                :host { all: initial; }
                .wrap {
                    position: fixed;
                    top: 0;
                    right: 0;
                    width: ${WIDTH}px;
                    height: 100vh;
                    z-index: 2147483647;
                    background: #ffffff;
                    box-shadow: -2px 0 14px rgba(0, 0, 0, 0.14);
                    transition: transform 0.2s ease;
                }
                .wrap.collapsed { transform: translateX(${WIDTH}px); }
                iframe {
                    display: block;
                    width: 100%;
                    height: 100%;
                    border: 0;
                }`;

    function build(tabId) {
        if (document.getElementById('ddl-sidebar-host')) return;
        const host = document.createElement('div');
        host.id = 'ddl-sidebar-host';
        const shadow = host.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = CSS;

        wrap = document.createElement('div');
        wrap.className = 'wrap';

        const frame = document.createElement('iframe');
        frame.title = 'Drive Downloader';
        frame.src = chrome.runtime.getURL('popup.html') + '?embedded=1&tabId=' + encodeURIComponent(tabId);

        wrap.append(frame);
        shadow.append(style, wrap);

        (document.body || document.documentElement).appendChild(host);

        try {
            chrome.storage.local.get([STORAGE_KEY], (res) => {
                void chrome.runtime.lastError;
                setCollapsed(!!(res && res[STORAGE_KEY]));
            });
        } catch (e) {}
    }

    // The toolbar icon shows / hides the sidebar on this tab.
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'toggleSidebar' && wrap) toggle();
    });

    // The panel needs to know which tab it belongs to; only the background
    // script can tell a content script its own tab id.
    chrome.runtime.sendMessage({ type: 'getMyTab' }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.tabId != null) build(resp.tabId);
    });
})();
