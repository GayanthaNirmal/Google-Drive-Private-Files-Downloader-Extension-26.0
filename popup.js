document.addEventListener("DOMContentLoaded", () => {
    const MAX_CONCURRENT = 3;

    const header           = document.getElementById('header');
    const downloadContainer = document.getElementById('downloadContainer');
    const statusMessage    = document.getElementById('statusMessage');
    const statusDot        = document.getElementById('statusDot');
    const btnOn            = document.getElementById('btnOn');
    const btnOff           = document.getElementById('btnOff');
    const reloadBtn        = document.getElementById('reloadBtn');
    const clearHistoryBtn  = document.getElementById('clearHistoryBtn');
    const downloadAlert    = document.getElementById('downloadAlert');
    const alertText        = document.getElementById('alertText');
    const heroTitle        = document.getElementById('heroTitle');
    const heroSub          = document.getElementById('heroSub');
    const tabUrl           = document.getElementById('tabUrl');

    // Shows the open Drive link in the pill. Anywhere else, shows what a
    // Drive file link looks like so the user knows which page to open.
    function showTabUrl(tab) {
        tabUrl.textContent = '';
        tabUrl.classList.remove('example');
        const scheme = document.createElement('span');
        scheme.className = 'scheme';
        scheme.textContent = 'https://';
        if (tab && tab.url && (tab.url.startsWith('https://drive.google.com/') || DOCS_EDITOR_RE.test(tab.url))) {
            tabUrl.appendChild(scheme);
            tabUrl.appendChild(document.createTextNode(tab.url.slice('https://'.length)));
            tabUrl.title = tab.url;
            return;
        }
        tabUrl.classList.add('example');
        const eg = document.createElement('span');
        eg.className = 'eg';
        eg.textContent = 'e.g. ';
        tabUrl.appendChild(eg);
        tabUrl.appendChild(document.createTextNode('drive.google.com/file/d/…/view'));
        tabUrl.title = 'Open a Google Drive file link like this one';
    }

    // Drive and Docs put the signed-in account in the path when there is more
    // than one (…/file/u/1/d/…), so the /u/N/ part is optional everywhere.
    const DRIVE_FILE_RE = /^https:\/\/drive\.google\.com\/file\/(?:u\/\d+\/)?d\//;
    // Files opened in the Docs/Sheets/Slides editor; their Drive preview is captured instead.
    const DOCS_EDITOR_RE = /^https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/;

    // Drive preview link for a file opened from a Docs link. Keeps the Google
    // account the link was opened with (a file shared to one email is only
    // visible from that account) and the link's resource key; without them
    // Drive can answer "You need access".
    function driveLinkFor(docsUrl, fileId) {
        let parsed = null;
        try { parsed = new URL(docsUrl); } catch (e) {}
        const pathUser = docsUrl.match(/\/u\/(\d+)\//);
        const authuser = (parsed && parsed.searchParams.get('authuser')) || (pathUser && pathUser[1]);
        const resourceKey = parsed && parsed.searchParams.get('resourcekey');
        const params = new URLSearchParams();
        if (resourceKey) params.set('resourcekey', resourceKey);
        if (authuser) params.set('authuser', authuser);
        const query = params.toString();
        return 'https://drive.google.com/file/d/' + fileId + '/view' + (query ? '?' + query : '');
    }
    const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', '3gp', '3g2',
                               'mpg', 'mpeg', 'mts', 'm2ts', 'ts', 'ogv', 'vob']);
    const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aif', 'aiff', 'amr']);
    // Drive shows no preview for these, so there is nothing to capture.
    const NO_PREVIEW_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'exe', 'msi', 'apk', 'iso', 'dmg', 'bin', 'jar']);

    // What the user sees in the top card, per file type and on/off state.
    const HERO_TEXT = {
        video:       { off: 'Turn on, then play the video.',          on: 'Play the video. It will appear below.' },
        audio:       { off: 'Turn on, then play the audio.',          on: 'Play the audio. It will appear below.' },
        document:    { off: 'Turn on to save this file as a PDF.',    on: 'Press Download below to save it as a PDF.' },
        unknown:     { off: 'Turn on, then open the file preview.',   on: 'If it\'s a video or audio file, play it.' },
        unsupported: { off: 'This file type can\'t be downloaded.',   on: 'This file type can\'t be downloaded.' },
        docslink:    { off: 'Turn on to open this file in Drive preview.', on: 'Opening this file in Drive preview…' },
        docsblocked: { off: 'Drive preview isn\'t available for this file.', on: 'Drive preview isn\'t available for this file.' },
        drive:       { off: 'Open the video, then turn on.',          on: 'Open the video on this page. It will be picked up.' },
        none:        { off: 'Open a file on Google Drive first.',     on: 'Open a file on Google Drive first.' }
    };
    const EMPTY_TEXT = {
        video:    'Nothing yet. Play the video on the Drive page.',
        audio:    'Nothing yet. Play the audio on the Drive page.',
        document: 'Getting the file ready…'
    };

    let currentTab  = null;
    let currentType = 'none';

    function fileTypeOf(tab) {
        if (tab && tab.url && DOCS_EDITOR_RE.test(tab.url)) return 'docslink';
        if (!tab || !tab.url || !tab.url.startsWith('https://drive.google.com/')) return 'none';
        if (!DRIVE_FILE_RE.test(tab.url)) return 'drive';
        const title = (tab.title || '').replace(/\s+-\s+Google Drive\s*$/i, '').trim();
        const m = title.match(/\.([a-z0-9]{1,5})$/i);
        if (!m) return 'unknown';
        const ext = m[1].toLowerCase();
        if (VIDEO_EXT.has(ext)) return 'video';
        if (AUDIO_EXT.has(ext)) return 'audio';
        if (NO_PREVIEW_EXT.has(ext)) return 'unsupported';
        return 'document';
    }

    function registerCurrentDocument() {
        if (!extensionEnabledCached || currentType !== 'document' || !currentTab) return;
        chrome.runtime.sendMessage({ type: 'registerDocument', tabId: currentTab.id }, () => {
            void chrome.runtime.lastError;
        });
    }

    // Inside the page sidebar the panel belongs to one tab (passed in the URL by
    // sidebar.js) and must only ever act on that tab. Opened on its own, it
    // follows the active tab instead.
    const pageParams   = new URLSearchParams(location.search);
    const EMBEDDED     = pageParams.get('embedded') === '1';
    const EMBED_TAB_ID = Number(pageParams.get('tabId'));

    function getTargetTab(cb) {
        if (EMBEDDED && EMBED_TAB_ID) {
            chrome.tabs.get(EMBED_TAB_ID, (tab) => {
                void chrome.runtime.lastError;
                cb(tab || null);
            });
        } else {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => cb(tabs[0] || null));
        }
    }

    // A private link opened in the Docs/Sheets/Slides editor is reopened in the
    // same tab as its Drive preview, where the pages can be captured.
    // Each file is redirected once: if Drive sends the tab back to the editor
    // (files made in Google Docs itself), it is not redirected again. The
    // record is kept in storage because the sidebar reloads with the page.
    const DOCS_REDIRECT_KEY = 'docsRedirects';
    const DOCS_REDIRECT_WINDOW_MS = 60000;

    function openDocsLinkInDrive() {
        const m = currentTab && currentTab.url && currentTab.url.match(DOCS_EDITOR_RE);
        if (!m) return;
        const fileId = m[1];
        const tabId = currentTab.id;
        const target = driveLinkFor(currentTab.url, fileId);
        chrome.storage.local.get([DOCS_REDIRECT_KEY], (res) => {
            const map = (res && res[DOCS_REDIRECT_KEY]) || {};
            const now = Date.now();
            for (const k in map) {
                if (now - map[k] > DOCS_REDIRECT_WINDOW_MS) delete map[k];
            }
            if (map[fileId]) {
                currentType = 'docsblocked';
                updateToggleUI(extensionEnabledCached);
                chrome.storage.local.set({ [DOCS_REDIRECT_KEY]: map });
                return;
            }
            map[fileId] = now;
            chrome.storage.local.set({ [DOCS_REDIRECT_KEY]: map }, () => {
                chrome.tabs.update(tabId, { url: target });
            });
        });
    }

    // Re-reads the target tab, since its page can navigate while the panel is open.
    function refreshCurrentTab() {
        getTargetTab((tab) => {
            currentTab  = tab;
            currentType = fileTypeOf(currentTab);
            const apply = () => {
                showTabUrl(currentTab);
                updateToggleUI(extensionEnabledCached);
                hideEmptyState();
                if (extensionEnabledCached) {
                    if (renderedItems.size === 0) showEmptyState();
                    if (currentType === 'docslink') openDocsLinkInDrive();
                    else registerCurrentDocument();
                }
            };
            // ON is per tab and only ever set by pressing Turn on.
            if (!tab) {
                extensionEnabledCached = false;
                apply();
                return;
            }
            chrome.runtime.sendMessage({ type: 'getTabEnabled', tabId: tab.id }, (resp) => {
                void chrome.runtime.lastError;
                extensionEnabledCached = !!(resp && resp.enabled);
                mediaWatchState = (resp && resp.watch) || null;
                apply();
            });
        });
    }

    let refreshTimer = null;
    function scheduleRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshCurrentTab, 200);
    }

    function badgeLabel(req) {
        if (req.kind === 'document') return 'PDF';
        if (req.quality === 'AUDIO') return 'Audio';
        return req.quality || 'Video';
    }

    let extensionEnabledCached = false;
    let pollIntervalId = null;
    const renderedItems = new Map();
    let downloadProgressCache = {};
    let capturedRequestsCache = {};
    let statusTimeoutId = null;

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let val = bytes;
        let i = 0;
        while (val >= 1024 && i < units.length - 1) {
            val /= 1024;
            i++;
        }
        const decimals = (i === 0) ? 0 : (i === 1 ? 1 : 2);
        return val.toFixed(decimals) + ' ' + units[i];
    }

    // "PDF", "document", "presentation"… for the open file, from its name.
    function documentKind() {
        const title = ((currentTab && currentTab.title) || '').replace(/\s+-\s+Google Drive\s*$/i, '');
        const ext = ((title.match(/\.([a-z0-9]{1,5})$/i) || [])[1] || '').toLowerCase();
        if (ext === 'pdf') return 'PDF';
        if (['doc', 'docx', 'odt', 'rtf', 'txt', 'pages'].includes(ext)) return 'document';
        if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'presentation';
        if (['xls', 'xlsx', 'ods', 'csv', 'numbers'].includes(ext)) return 'spreadsheet';
        return 'file';
    }

    function updateToggleUI(isEnabled) {
        btnOn.disabled  = isEnabled;
        btnOff.disabled = !isEnabled;
        const onDocsEditor = currentType === 'docslink' || currentType === 'docsblocked';
        reloadBtn.classList.toggle('hidden', currentType === 'none' || onDocsEditor);
        statusDot.classList.toggle('active', isEnabled);
        heroTitle.textContent = isEnabled ? 'Capturing is on' : 'Capturing is off';
        heroSub.textContent = HERO_TEXT[currentType][isEnabled ? 'on' : 'off'];
        // Documents are saved from the pages the preview has loaded, so the
        // whole file has to finish loading before capturing starts.
        if (!isEnabled && currentType === 'document') {
            heroSub.textContent = 'Wait until the whole ' + documentKind() + ' has loaded, then turn on.';
        }
        // While the page is being refreshed to find the video, say so.
        if (isEnabled && mediaWatchState) {
            if (mediaWatchState.gaveUp) {
                heroSub.textContent = 'Couldn\'t find the video. Play it, then press ↻.';
            } else if (mediaWatchState.tries > 0) {
                heroSub.textContent = 'Looking for the video… refreshed ' + mediaWatchState.tries + ' of ' + mediaWatchState.maxTries;
            } else {
                heroSub.textContent = 'Looking for the video…';
            }
        }
    }

    // Auto-refresh progress for this tab, as reported by the background.
    let mediaWatchState = null;
    function pollTabState() {
        if (!currentTab) return;
        chrome.runtime.sendMessage({ type: 'getTabEnabled', tabId: currentTab.id }, (resp) => {
            if (chrome.runtime.lastError || !resp) return;
            const before = JSON.stringify([extensionEnabledCached, mediaWatchState]);
            extensionEnabledCached = !!resp.enabled;
            mediaWatchState = resp.watch || null;
            if (JSON.stringify([extensionEnabledCached, mediaWatchState]) !== before) updateToggleUI(extensionEnabledCached);
        });
    }

    // On a Drive folder / home page a clicked video opens in a preview popup and
    // the address stays the same. Finds that file's id so it can be opened on
    // its own page (like Drive's "Open in new window"), where it can be captured.
    function previewedFileIdFn() {
        const LONG_ID = /^[A-Za-z0-9_-]{25,}$/;
        const idFromUrl = (s) => {
            if (!s) return null;
            const m = s.match(/\/(?:file|document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{25,})/) ||
                      s.match(/[?&#](?:docid|id)=([A-Za-z0-9_-]{25,})/);
            return m ? m[1] : null;
        };
        // 1. The preview's own player / viewer frame.
        for (const f of document.querySelectorAll('iframe')) {
            const id = idFromUrl(f.src);
            if (id) return id;
        }
        // 2. Links or item ids inside the open preview dialog.
        for (const dlg of document.querySelectorAll('[role="dialog"]')) {
            for (const a of dlg.querySelectorAll('a[href]')) {
                const id = idFromUrl(a.href);
                if (id) return id;
            }
            const el = dlg.querySelector('[data-id]');
            if (el && LONG_ID.test(el.getAttribute('data-id'))) return el.getAttribute('data-id');
        }
        // 3. The file the user clicked stays selected in the file list.
        for (const sel of document.querySelectorAll('[aria-selected="true"]')) {
            const holder = sel.closest('[data-id]') || sel.querySelector('[data-id]');
            const id = holder && holder.getAttribute('data-id');
            if (id && LONG_ID.test(id)) return id;
        }
        return null;
    }

    function findPreviewedFileId(tabId, cb) {
        chrome.scripting.executeScript({ target: { tabId: tabId }, func: previewedFileIdFn })
            .then((res) => cb((res && res[0] && res[0].result) || null))
            .catch(() => cb(null));
    }

    function setStatus(text, isError, durationMs) {
        if (statusTimeoutId) {
            clearTimeout(statusTimeoutId);
            statusTimeoutId = null;
        }
        if (!text) {
            statusMessage.classList.add('hidden');
            statusMessage.textContent = '';
            return;
        }
        statusMessage.classList.remove('hidden');
        statusMessage.textContent = text;
        statusMessage.style.color = isError ? '#b91c1c' : '';
        if (durationMs) {
            statusTimeoutId = setTimeout(() => {
                statusMessage.classList.add('hidden');
                statusMessage.textContent = '';
                statusTimeoutId = null;
            }, durationMs);
        }
    }

    function clearStatus() {
        if (statusTimeoutId) {
            clearTimeout(statusTimeoutId);
            statusTimeoutId = null;
        }
        statusMessage.classList.add('hidden');
        statusMessage.textContent = '';
    }

    function showEmptyState() {
        if (document.getElementById('emptyState')) return;
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.id = 'emptyState';
        empty.textContent = EMPTY_TEXT[currentType] || 'Nothing yet.';
        downloadContainer.appendChild(empty);
    }

    function hideEmptyState() {
        const e = document.getElementById('emptyState');
        if (e) e.remove();
    }

    function createVideoItem(req) {
        const item = document.createElement('div');
        item.className = 'video-item';
        item.dataset.requestId = req.requestId;

        const row = document.createElement('div');
        row.className = 'video-row';

        const info = document.createElement('div');
        info.className = 'video-info';

        const title = document.createElement('div');
        title.className = 'video-title';
        title.textContent = req.videoTitle || 'Untitled';
        title.title = req.videoTitle || '';

        const meta = document.createElement('div');
        meta.className = 'video-meta';
        const badge = document.createElement('span');
        badge.className = 'quality-badge';
        badge.textContent = badgeLabel(req);
        meta.appendChild(badge);

        info.appendChild(title);
        info.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'video-actions';

        const dlBtn = document.createElement('button');
        dlBtn.className = 'download-btn';
        dlBtn.textContent = 'Download ↓';
        dlBtn.setAttribute('aria-label', 'Download ' + (req.videoTitle || 'video'));
        dlBtn.addEventListener('click', () => {
            if (dlBtn.disabled) return;
            chrome.runtime.sendMessage({
                type: 'startDownload',
                requestId: req.requestId
            }, (resp) => {
                if (chrome.runtime.lastError) return;
                if (resp && !resp.success) {
                    if (resp.limitReached) {
                        setStatus('Max 3 downloads at once. Wait for one to finish.', false, 4000);
                    } else {
                        setStatus(resp.error || 'Could not start download.', true, 4000);
                    }
                }
            });
        });

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'ctrl-btn pause-btn hidden';
        pauseBtn.title = 'Pause';
        pauseBtn.textContent = '⏸';
        pauseBtn.setAttribute('aria-label', 'Pause download');
        pauseBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'pauseDownload',
                requestId: req.requestId
            }, () => { void chrome.runtime.lastError; });
        });

        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'ctrl-btn resume-btn hidden';
        resumeBtn.title = 'Resume';
        resumeBtn.textContent = '▶';
        resumeBtn.setAttribute('aria-label', 'Resume download');
        resumeBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'resumeDownload',
                requestId: req.requestId
            }, () => { void chrome.runtime.lastError; });
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'ctrl-btn cancel-btn hidden';
        cancelBtn.title = 'Cancel';
        cancelBtn.textContent = '✕';
        cancelBtn.setAttribute('aria-label', 'Cancel download');
        cancelBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'cancelDownload',
                requestId: req.requestId
            }, () => { void chrome.runtime.lastError; });
        });

        actions.appendChild(dlBtn);
        actions.appendChild(pauseBtn);
        actions.appendChild(resumeBtn);
        actions.appendChild(cancelBtn);

        row.appendChild(info);
        row.appendChild(actions);

        const progressWrap = document.createElement('div');
        progressWrap.className = 'progress-wrap hidden';

        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        const progressFill = document.createElement('div');
        progressFill.className = 'progress-fill';
        progressBar.appendChild(progressFill);

        const progressText = document.createElement('div');
        progressText.className = 'progress-text';
        const pp = document.createElement('span');
        pp.className = 'pp';
        pp.textContent = '0%';
        const ps = document.createElement('span');
        ps.className = 'ps';
        ps.textContent = 'Starting...';
        progressText.appendChild(pp);
        progressText.appendChild(ps);

        progressWrap.appendChild(progressBar);
        progressWrap.appendChild(progressText);

        item.appendChild(row);
        item.appendChild(progressWrap);

        return item;
    }

    function applyProgress(item, prog) {
        if (!prog) return;

        const progressWrap = item.querySelector('.progress-wrap');
        const progressFill = item.querySelector('.progress-fill');
        const dlBtn        = item.querySelector('.download-btn');
        const pauseBtn     = item.querySelector('.pause-btn');
        const resumeBtn    = item.querySelector('.resume-btn');
        const cancelBtn    = item.querySelector('.cancel-btn');
        const pp           = item.querySelector('.pp');
        const ps           = item.querySelector('.ps');

        const percent = Math.max(0, Math.min(100, prog.percent || 0));
        progressFill.style.width = percent + '%';
        pp.textContent = percent + '%';

        const doneStr = formatBytes(prog.completed || 0);
        const totStr  = formatBytes(prog.total || 0);
        const isDoc = typeof prog.pages === 'number';
        let progressLabel = (!prog.total || prog.total === 0)
            ? doneStr + ' / calculating...'
            : doneStr + ' / ' + totStr;
        if (isDoc) {
            progressLabel = prog.pages + (prog.pages === 1 ? ' page' : ' pages') + ' captured';
        } else if (prog.phase === 'converting') {
            progressLabel = 'Converting to MP3...';
        }

        const st = prog.status;
        if (st === 'starting') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill';
            progressFill.style.width = '0%';
            pp.textContent = '0%';
            ps.textContent = 'Starting...';
            dlBtn.classList.add('hidden');
            pauseBtn.classList.remove('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.remove('hidden');
            item.classList.add('is-active');
        } else if (st === 'downloading') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill';
            ps.textContent = progressLabel;
            dlBtn.classList.add('hidden');
            pauseBtn.classList.remove('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.remove('hidden');
            item.classList.add('is-active');
        } else if (st === 'paused') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill';
            ps.textContent = 'Paused at ' + progressLabel;
            dlBtn.classList.add('hidden');
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.remove('hidden');
            cancelBtn.classList.remove('hidden');
            item.classList.add('is-active');
        } else if (st === 'completed') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill completed';
            ps.textContent = isDoc
                ? 'Saved · ' + prog.pages + ' pages'
                : 'Saved · ' + doneStr;
            dlBtn.classList.remove('hidden');
            dlBtn.textContent = 'Again ↓';
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        } else if (st === 'cancelled') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill error';
            ps.textContent = 'Cancelled' + (prog.completed ? ' at ' + doneStr : '');
            dlBtn.classList.remove('hidden');
            dlBtn.textContent = 'Retry';
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        } else if (st === 'interrupted') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill error';
            ps.textContent = 'Interrupted: ' + (prog.error || 'Tab or worker was closed');
            dlBtn.classList.remove('hidden');
            dlBtn.textContent = 'Retry';
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        } else if (st === 'error') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill error';
            ps.textContent = 'Error: ' + (prog.error || 'Failed');
            dlBtn.classList.remove('hidden');
            dlBtn.textContent = 'Retry';
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        }
    }

    function syncList(requests, progress) {
        const matching = [];
        for (const requestId in requests) {
            const req = requests[requestId];
            if (!req.videoTitle) continue;
            if (req.kind !== 'document' && !req.lastItagUrl) continue;
            matching.push(Object.assign({ requestId: requestId }, req));
        }

        matching.sort((a, b) => {
            const ta = a.capturedAt || a.timestamp || 0;
            const tb = b.capturedAt || b.timestamp || 0;
            return tb - ta;
        });

        if (matching.length === 0) {
            if (extensionEnabledCached && renderedItems.size === 0) {
                showEmptyState();
            }
        } else {
            hideEmptyState();
        }

        const seenIds = new Set();
        matching.forEach((req, idx) => {
            seenIds.add(req.requestId);
            let item = renderedItems.get(req.requestId);

            if (!item) {
                item = createVideoItem(req);
                renderedItems.set(req.requestId, item);
            } else {
                const titleEl = item.querySelector('.video-title');
                if (titleEl.textContent !== (req.videoTitle || 'Untitled')) {
                    titleEl.textContent = req.videoTitle || 'Untitled';
                    titleEl.title = req.videoTitle || '';
                }
                const badge = item.querySelector('.quality-badge');
                if (badge && badge.textContent !== badgeLabel(req)) {
                    badge.textContent = badgeLabel(req);
                }
            }

            const currentChildren = Array.from(downloadContainer.children);
            const expectedIndex = idx;
            if (currentChildren[expectedIndex] !== item) {
                if (expectedIndex === 0) {
                    downloadContainer.insertBefore(item, downloadContainer.firstChild);
                } else {
                    const prev = currentChildren[expectedIndex - 1];
                    if (prev.nextSibling) {
                        downloadContainer.insertBefore(item, prev.nextSibling);
                    } else {
                        downloadContainer.appendChild(item);
                    }
                }
            }

            if (progress && progress[req.requestId]) {
                applyProgress(item, progress[req.requestId]);
            }
        });

        for (const [rid, el] of renderedItems.entries()) {
            if (!seenIds.has(rid)) {
                el.remove();
                renderedItems.delete(rid);
            }
        }

        // The banner tip depends on what is downloading: page capture needs the
        // tab visible and unscrolled, a media download only needs it open.
        let activeDoc = false;
        let activeMedia = false;
        if (progress) {
            for (const rid in progress) {
                const st = progress[rid] && progress[rid].status;
                if (st === 'starting' || st === 'downloading' || st === 'paused') {
                    const r = requests[rid];
                    if (r && r.kind === 'document') activeDoc = true;
                    else activeMedia = true;
                }
            }
        }
        if (activeDoc) {
            alertText.textContent = 'Keep the Drive tab visible. Don\'t scroll it.';
        } else if (activeMedia) {
            alertText.textContent = 'Keep the Drive tab open';
        }
        downloadAlert.classList.toggle('hidden', !activeDoc && !activeMedia);

        applyConcurrencyLimit();
    }

    function countActiveDownloads() {
        let count = 0;
        for (const rid in downloadProgressCache) {
            const st = downloadProgressCache[rid] && downloadProgressCache[rid].status;
            if (st === 'starting' || st === 'downloading' || st === 'paused') {
                count++;
            }
        }
        return count;
    }

    function isItemDownloading(rid) {
        const st = downloadProgressCache[rid] && downloadProgressCache[rid].status;
        return st === 'starting' || st === 'downloading' || st === 'paused';
    }

    function applyConcurrencyLimit() {
        const activeCount = countActiveDownloads();
        const limitReached = activeCount >= MAX_CONCURRENT;

        renderedItems.forEach((item, rid) => {
            if (isItemDownloading(rid)) return;

            const dlBtn = item.querySelector('.download-btn');
            if (!dlBtn) return;

            const ps = item.querySelector('.ps');
            const progressWrap = item.querySelector('.progress-wrap');

            if (limitReached) {
                dlBtn.disabled = true;
                dlBtn.classList.add('disabled-limit');
                if (!dlBtn.dataset.originalText) {
                    dlBtn.dataset.originalText = dlBtn.textContent;
                    dlBtn.textContent = 'Wait…';
                    dlBtn.title = 'Maximum ' + MAX_CONCURRENT + ' concurrent downloads. Waiting for one to finish.';
                }
            } else {
                dlBtn.disabled = false;
                dlBtn.classList.remove('disabled-limit');
                if (dlBtn.dataset.originalText) {
                    dlBtn.textContent = dlBtn.dataset.originalText;
                    delete dlBtn.dataset.originalText;
                }
                dlBtn.title = '';
            }
        });
    }

    function hasActiveDownloadOnTab(tabId) {
        for (const rid in downloadProgressCache) {
            const p = downloadProgressCache[rid];
            const st = p && p.status;
            const isSameTab = (capturedRequestsCache[rid] && capturedRequestsCache[rid].tabId === tabId);
            if (isSameTab && (st === 'starting' || st === 'downloading' || st === 'paused')) {
                return true;
            }
        }
        return false;
    }

    // Turn on / off for this tab only. The background is told first; only then
    // does the page reload or move to Drive preview, because that navigation
    // also reloads this sidebar.
    function handleStateChange(newState) {
        getTargetTab((tab) => {
            if (!tab) return;
            const isMediaPage = currentType === 'video' || currentType === 'audio' || currentType === 'unknown';

            const apply = (previewId) => {
                chrome.runtime.sendMessage({
                    type: "setEnabled",
                    enabled: newState,
                    tabId: tab.id,
                    url: tab.url,
                    // Keep refreshing the page until the video shows up.
                    watchMedia: newState && (isMediaPage || !!previewId)
                }, (response) => {
                    void chrome.runtime.lastError;
                    extensionEnabledCached = newState;
                    updateToggleUI(newState);
                    clearStatus();
                    pollTabState();
                    if (!newState) return;
                    if (renderedItems.size === 0) showEmptyState();
                    if (currentType === 'docslink') {
                        openDocsLinkInDrive();
                        return;
                    }
                    if (currentType === 'drive') {
                        // A video open in Drive's preview popup: open it on its own page.
                        if (previewId) chrome.tabs.update(tab.id, { url: driveLinkFor(tab.url, previewId) });
                        return;
                    }
                    registerCurrentDocument();
                    if (!response || !response.success || response.isDriveTab === false) return;
                    // Media streams are only seen when the page loads, so reload for those.
                    // Documents are read from the open preview and need no reload.
                    if (isMediaPage && !hasActiveDownloadOnTab(tab.id)) {
                        chrome.tabs.reload(tab.id);
                    }
                });
            };

            // Turning on starts work on a new file, so the previous file's items
            // are cleared from the list first (downloads still running stay).
            const start = (previewId) => {
                if (newState) clearHistoryNow(() => apply(previewId));
                else apply(previewId);
            };

            if (newState && currentType === 'drive') findPreviewedFileId(tab.id, start);
            else start(null);
        });
    }

    btnOn.addEventListener('click',  () => handleStateChange(true));
    btnOff.addEventListener('click', () => handleStateChange(false));

    reloadBtn.addEventListener('click', () => {
        getTargetTab((tab) => {
            if (!tab || !tab.id) return;
            if (!tab.url || !tab.url.startsWith('https://drive.google.com/')) {
                setStatus('Open a Google Drive page first.', true, 3000);
                return;
            }
            if (hasActiveDownloadOnTab(tab.id)) {
                setStatus('A download is running on this tab. Cancel it first.', true, 5000);
                return;
            }
            chrome.tabs.reload(tab.id);
            const toRemove = [];
            for (const [rid, el] of renderedItems.entries()) {
                const req = capturedRequestsCache[rid];
                if (req && req.tabId === tab.id) {
                    toRemove.push([rid, el]);
                }
            }
            toRemove.forEach(([rid, el]) => {
                el.remove();
                renderedItems.delete(rid);
            });
            if (renderedItems.size === 0) {
                showEmptyState();
            }
        });
    });

    // Clears finished / captured items (running downloads stay).
    function clearHistoryNow(done) {
        chrome.runtime.sendMessage({ type: "clearHistory" }, () => {
            void chrome.runtime.lastError;
            renderedItems.forEach((el, rid) => {
                const st = (downloadProgressCache[rid] || {}).status;
                if (st !== 'starting' && st !== 'downloading' && st !== 'paused') {
                    el.remove();
                    renderedItems.delete(rid);
                }
            });
            if (renderedItems.size === 0) {
                showEmptyState();
            }
            if (done) done();
        });
    }

    clearHistoryBtn.addEventListener('click', () => {
        clearHistoryNow(() => setStatus('History cleared.', false, 2000));
    });

    function startPolling() {
        if (pollIntervalId) clearInterval(pollIntervalId);
        pollIntervalId = setInterval(() => {
            pollTabState();
            chrome.runtime.sendMessage({ type: "getRequests" }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.requests) return;
                capturedRequestsCache = resp.requests;
                chrome.runtime.sendMessage({ type: "getProgress" }, (progResp) => {
                    if (chrome.runtime.lastError) return;
                    downloadProgressCache = (progResp && progResp.progress) || {};
                    syncList(capturedRequestsCache, downloadProgressCache);
                });
            });
        }, 500);
    }

    function initialSync() {
        chrome.runtime.sendMessage({ type: "getRequests" }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.requests) {
                startPolling();
                return;
            }
            capturedRequestsCache = resp.requests;
            chrome.runtime.sendMessage({ type: "getProgress" }, (progResp) => {
                if (chrome.runtime.lastError) {
                    startPolling();
                    return;
                }
                downloadProgressCache = (progResp && progResp.progress) || {};
                syncList(capturedRequestsCache, downloadProgressCache);
                startPolling();
            });
        });
    }

    header.classList.remove('hidden');

    refreshCurrentTab();
    initialSync();

    // Keep the panel in step with its tab (in the sidebar), or with whatever
    // tab the user switches to (when opened on its own).
    if (!EMBEDDED) chrome.tabs.onActivated.addListener(scheduleRefresh);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (!currentTab || tabId !== currentTab.id) return;
        if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') scheduleRefresh();
    });
});
