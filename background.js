let capturedRequests = {};
let pollingTimers = {};
let autoPopupCount = {};
// Tabs where the user pressed Turn on. Nothing is ever on by default: each tab
// starts off and is turned on by hand. Kept in session storage so a service
// worker restart does not switch a tab off in the middle of a capture.
const enabledTabs = new Set();
const ENABLED_TABS_KEY = 'enabledTabs';

// A Drive file page, with or without the account part: …/file/d/ID/… or …/file/u/1/d/ID/…
const DRIVE_FILE_ID_RE = /^https:\/\/drive\.google\.com\/file\/(?:u\/\d+\/)?d\/([^/?#]+)/;
function saveEnabledTabs() {
    try { chrome.storage.session.set({ [ENABLED_TABS_KEY]: Array.from(enabledTabs) }); } catch (e) {}
}
let downloadProgress = {};
const pendingTabs = new Set();
const attachedTabs = new Set();

const MAX_CONCURRENT_DOWNLOADS = 3;

const STORAGE_KEY_REQUESTS = 'capturedRequests';
const STORAGE_KEY_PROGRESS = 'downloadProgress';

function isActiveStatus(st) {
    return st === 'starting' || st === 'downloading' || st === 'paused';
}

function countActiveDownloads() {
    let count = 0;
    for (const rid in downloadProgress) {
        const st = downloadProgress[rid] && downloadProgress[rid].status;
        if (isActiveStatus(st)) {
            count++;
        }
    }
    return count;
}

function startDocumentCapture(requestId) {
    const req = capturedRequests[requestId];
    downloadProgress[requestId] = {
        status: 'starting',
        completed: 0,
        total: 0,
        percent: 0,
        pages: 0,
        error: null,
        title: req.videoTitle,
        quality: req.quality || '',
        lastUpdated: Date.now()
    };
    persistState();

    chrome.scripting.executeScript({
        target: { tabId: req.tabId },
        func: docCaptureFn,
        args: [req.videoTitle, requestId]
    }).catch(err => {
        const p = downloadProgress[requestId] || {};
        p.status = 'error';
        p.error = (err && err.message) ? err.message : String(err);
        p.lastUpdated = Date.now();
        downloadProgress[requestId] = p;
        persistState();
    });
}

function persistState() {
    try {
        chrome.storage.local.set({
            [STORAGE_KEY_REQUESTS]: capturedRequests,
            [STORAGE_KEY_PROGRESS]: downloadProgress
        });
    } catch (e) {}
}

function loadPersistedState(callback) {
    chrome.storage.local.get([STORAGE_KEY_REQUESTS, STORAGE_KEY_PROGRESS], (result) => {
        if (result[STORAGE_KEY_REQUESTS]) {
            capturedRequests = result[STORAGE_KEY_REQUESTS];
        }
        if (result[STORAGE_KEY_PROGRESS]) {
            const now = Date.now();
            Object.keys(result[STORAGE_KEY_PROGRESS]).forEach(rid => {
                const p = result[STORAGE_KEY_PROGRESS][rid];
                if (p && (p.status === 'starting' || p.status === 'downloading' || p.status === 'paused')) {
                    if (p.lastUpdated && (now - p.lastUpdated) < 24 * 60 * 60 * 1000) {
                        p.status = 'interrupted';
                        p.error = 'Service worker restarted during download. Click Retry to restart.';
                    }
                }
                downloadProgress[rid] = p;
            });
        }

        dedupePersistedRequests();

        if (callback) callback();
    });
}

function dedupePersistedRequests() {
    const seen = {};
    const toDelete = [];
    for (const rid in capturedRequests) {
        const req = capturedRequests[rid];
        if (!req.videoTitle || !req.lastItagUrl) continue;
        const key = req.videoTitle + '||' + req.lastItagUrl;
        if (seen[key]) {
            const keepRid = seen[key];
            const keepProgress = downloadProgress[keepRid];
            const dropProgress = downloadProgress[rid];
            const keepActive = keepProgress && (
                keepProgress.status === 'starting' ||
                keepProgress.status === 'downloading' ||
                keepProgress.status === 'paused' ||
                keepProgress.status === 'completed'
            );
            if (keepActive) {
                toDelete.push(rid);
                if (dropProgress) delete downloadProgress[rid];
            } else if (dropProgress && !keepProgress) {
                downloadProgress[keepRid] = dropProgress;
                delete downloadProgress[rid];
                toDelete.push(rid);
            } else {
                toDelete.push(rid);
                if (dropProgress) delete downloadProgress[rid];
            }
        } else {
            seen[key] = rid;
        }
    }
    toDelete.forEach(rid => delete capturedRequests[rid]);
    if (toDelete.length > 0) {
        persistState();
    }
}

// The old global ON switch made every Drive tab start capturing on its own; drop it.
chrome.storage.local.remove('extensionEnabled');
loadPersistedState();
try {
    chrome.storage.session.get([ENABLED_TABS_KEY], (res) => {
        void chrome.runtime.lastError;
        ((res && res[ENABLED_TABS_KEY]) || []).forEach(id => enabledTabs.add(id));
    });
} catch (e) {}

// The toolbar icon shows / hides the sidebar on Drive and Docs pages. Tabs that
// were open before the extension loaded get the sidebar added on first click.
chrome.action.onClicked.addListener((tab) => {
    if (!tab || !tab.id || !/^https:\/\/(drive|docs)\.google\.com\//.test(tab.url || '')) return;
    chrome.tabs.sendMessage(tab.id, { type: 'toggleSidebar' }, () => {
        if (!chrome.runtime.lastError) return;
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['sidebar.js'] }).catch(() => {});
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "getTabEnabled") {
        const w = mediaWatch[message.tabId];
        sendResponse({
            enabled: enabledTabs.has(message.tabId),
            // Progress of the automatic refreshes while looking for a video.
            watch: w ? { tries: w.tries, maxTries: MEDIA_WATCH_MAX_TRIES, gaveUp: w.gaveUp } : null
        });
        return;
    }

    // Turn on / off applies to the one tab it was pressed in.
    if (message.type === "setEnabled") {
        if (message.enabled) enabledTabs.add(message.tabId);
        else enabledTabs.delete(message.tabId);
        saveEnabledTabs();
        if (message.enabled && message.watchMedia) startMediaWatch(message.tabId);
        else stopMediaWatch(message.tabId);

        if (message.enabled) {
            chrome.tabs.get(message.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    sendResponse({ success: false });
                    return;
                }
                if (tab.url && tab.url.includes("drive.google.com")) {
                    startAutoCaptureForTab(message.tabId);
                    pendingTabs.add(message.tabId);
                    sendResponse({ success: true, isDriveTab: true });
                } else {
                    sendResponse({ success: true, isDriveTab: false });
                }
            });
            return true;
        } else {
            delete autoPopupCount[message.tabId];
            pendingTabs.delete(message.tabId);
            cleanupTabDebugger(message.tabId);
            sendResponse({ success: true });
        }
        return true;
    }

    // The page sidebar asks which tab it is in, so its panel acts on that tab only.
    if (message.type === "getMyTab") {
        sendResponse({ tabId: sender.tab ? sender.tab.id : null });
        return;
    }

    if (message.type === "getRequests") {
        sendResponse({ requests: capturedRequests });
        return;
    }

    if (message.type === "getProgress") {
        sendResponse({ progress: downloadProgress });
        return;
    }

    // Adds the document open in this tab to the download list (capture starts
    // only when the user presses Download).
    if (message.type === "registerDocument") {
        chrome.tabs.get(message.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                sendResponse({ success: false });
                return;
            }
            const m = (tab.url || '').match(DRIVE_FILE_ID_RE);
            if (!m) {
                sendResponse({ success: false });
                return;
            }
            const requestId = 'doc-' + m[1];
            const title = (tab.title || 'document').replace(/\s+-\s+Google Drive\s*$/i, '').trim() || 'document';
            const extMatch = title.match(/\.([a-z0-9]{2,5})$/i);
            const existing = capturedRequests[requestId];
            capturedRequests[requestId] = Object.assign({}, existing, {
                kind: 'document',
                fileId: m[1],
                tabId: tab.id,
                videoTitle: title,
                quality: extMatch ? extMatch[1].toUpperCase() : 'DOC',
                capturedAt: existing ? existing.capturedAt : Date.now()
            });
            persistState();
            sendResponse({ success: true, requestId: requestId });
        });
        return true;
    }

    if (message.type === "startDownload") {
        const requestId = message.requestId;
        const req = capturedRequests[requestId];
        if (req && req.kind === 'document') {
            const existingDoc = downloadProgress[requestId];
            if (existingDoc && isActiveStatus(existingDoc.status)) {
                sendResponse({ success: false, error: 'This file is already being captured.' });
                return;
            }
            if (countActiveDownloads() >= MAX_CONCURRENT_DOWNLOADS) {
                sendResponse({
                    success: false,
                    error: 'Maximum ' + MAX_CONCURRENT_DOWNLOADS + ' concurrent downloads. Please wait for one to finish.',
                    limitReached: true
                });
                return;
            }
            // Pages are read from the open preview, so the file must still be open in a tab
            // (its URL may be …/file/d/ID/… or …/file/u/N/d/ID/…).
            chrome.tabs.query({ url: 'https://drive.google.com/*' }, (allTabs) => {
                const tabs = (allTabs || []).filter(t => {
                    const m = (t.url || '').match(DRIVE_FILE_ID_RE);
                    return m && m[1] === req.fileId;
                });
                if (chrome.runtime.lastError || tabs.length === 0) {
                    sendResponse({ success: false, error: 'Open this file on Google Drive, then try again.' });
                    return;
                }
                const same = tabs.find(t => t.id === req.tabId);
                req.tabId = (same || tabs[0]).id;
                startDocumentCapture(requestId);
                sendResponse({ success: true });
            });
            return true;
        }
        if (!req || !req.lastItagUrl) {
            sendResponse({ success: false, error: 'No URL captured for this request.' });
            return;
        }

        const existing = downloadProgress[requestId];
        if (existing && (existing.status === 'starting' || existing.status === 'downloading' || existing.status === 'paused')) {
            sendResponse({ success: false, error: 'Download already in progress.' });
            return;
        }

        const activeCount = countActiveDownloads();
        if (activeCount >= MAX_CONCURRENT_DOWNLOADS) {
            sendResponse({
                success: false,
                error: 'Maximum ' + MAX_CONCURRENT_DOWNLOADS + ' concurrent downloads. Please wait for one to finish.',
                limitReached: true
            });
            return;
        }

        downloadProgress[requestId] = {
            status: 'starting',
            completed: 0,
            total: 0,
            percent: 0,
            error: null,
            title: req.videoTitle,
            quality: req.quality || '',
            lastUpdated: Date.now()
        };
        persistState();

        const isAudio = req.quality === 'AUDIO';
        const wantMp3 = isAudio && /\.mp3$/i.test(req.videoTitle || '');
        // The MP3 encoder only gets loaded when an MP3 original may need converting.
        const loadEncoder = wantMp3
            ? chrome.scripting.executeScript({ target: { tabId: req.tabId }, files: ['lib/lame.min.js'] }).catch(() => {})
            : Promise.resolve();

        // Videos use the original downloader as-is; audio uses the variant that
        // names the file by its real format and can convert to MP3.
        loadEncoder.then(() => chrome.scripting.executeScript(isAudio ? {
            target: { tabId: req.tabId },
            func: audioDownloadFn,
            args: [req.lastItagUrl, req.videoTitle, requestId, isAudio, wantMp3]
        } : {
            target: { tabId: req.tabId },
            func: chunkedDownloadFn,
            args: [req.lastItagUrl, req.videoTitle, requestId]
        })).catch(err => {
            const p = downloadProgress[requestId] || {};
            p.status = 'error';
            p.error = (err && err.message) ? err.message : String(err);
            p.lastUpdated = Date.now();
            downloadProgress[requestId] = p;
            persistState();
        });

        sendResponse({ success: true });
        return;
    }

    if (message.type === 'pauseDownload' ||
        message.type === 'resumeDownload' ||
        message.type === 'cancelDownload') {

        const rid = message.requestId;
        const req = capturedRequests[rid];

        if (downloadProgress[rid]) {
            if (message.type === 'pauseDownload') {
                downloadProgress[rid].status = 'paused';
            } else if (message.type === 'resumeDownload') {
                downloadProgress[rid].status = 'downloading';
            } else if (message.type === 'cancelDownload') {
                downloadProgress[rid].status = 'cancelled';
            }
            downloadProgress[rid].lastUpdated = Date.now();
            persistState();
        }

        if (req && req.tabId) {
            try {
                chrome.tabs.sendMessage(req.tabId, {
                    type: message.type,
                    requestId: rid
                }, () => { void chrome.runtime.lastError; });
            } catch (e) {}
        }
        sendResponse({ success: true });
        return;
    }

    if (message.type === "clearHistory") {
        const activeRequestIds = new Set();
        Object.keys(downloadProgress).forEach(rid => {
            const st = downloadProgress[rid] && downloadProgress[rid].status;
            if (st === 'starting' || st === 'downloading' || st === 'paused') {
                activeRequestIds.add(rid);
            } else {
                delete downloadProgress[rid];
            }
        });

        Object.keys(capturedRequests).forEach(rid => {
            if (!activeRequestIds.has(rid)) {
                delete capturedRequests[rid];
            }
        });

        persistState();
        sendResponse({ success: true });
        return;
    }

    if (message.type === "downloadProgressUpdate") {
        const rid = message.requestId;
        if (!downloadProgress[rid]) {
            downloadProgress[rid] = { status: 'starting', completed: 0, total: 0, percent: 0, error: null };
        }
        if (message.status)  downloadProgress[rid].status    = message.status;
        if (typeof message.completed === 'number') downloadProgress[rid].completed = message.completed;
        if (typeof message.total     === 'number') downloadProgress[rid].total     = message.total;
        if (typeof message.percent   === 'number') downloadProgress[rid].percent   = message.percent;
        if (typeof message.pages     === 'number') downloadProgress[rid].pages     = message.pages;
        downloadProgress[rid].phase = message.phase || null;
        if (message.error !== undefined)            downloadProgress[rid].error     = message.error;
        downloadProgress[rid].lastUpdated = Date.now();
        persistState();
        return;
    }

    if (message.type === "showPopup") {
        safeOpenPopup();
        return;
    }
});

function safeOpenPopup() {
    try {
        const result = chrome.action.openPopup();
        if (result && typeof result.then === 'function') {
            result.catch(() => {});
        } else if (typeof result === 'undefined') {
            try {
                chrome.action.openPopup(() => {
                    void chrome.runtime.lastError;
                });
            } catch (e) {}
        }
    } catch (e) {}
}

function cleanupTabDebugger(tabId) {
    if (pollingTimers[tabId]) {
        clearInterval(pollingTimers[tabId]);
        delete pollingTimers[tabId];
    }
    const debuggee = { tabId: tabId };
    chrome.debugger.detach(debuggee, () => {
        if (chrome.runtime.lastError) return;
    });
    pendingTabs.delete(tabId);
    attachedTabs.delete(tabId);
}

function cleanupTabResources(tabId) {
    cleanupTabDebugger(tabId);
    const closedTabRequestIds = new Set();
    Object.keys(capturedRequests).forEach(requestId => {
        if (capturedRequests[requestId].tabId === tabId) {
            closedTabRequestIds.add(requestId);
            delete capturedRequests[requestId];
        }
    });
    Object.keys(downloadProgress).forEach(rid => {
        if (!closedTabRequestIds.has(rid)) return;
        const p = downloadProgress[rid];
        const st = p && p.status;
        if (st === 'starting' || st === 'downloading' || st === 'paused') {
            p.status = 'interrupted';
            p.error = 'Tab was closed during download. Click Retry to restart.';
            p.lastUpdated = Date.now();
        }
    });
    delete autoPopupCount[tabId];
    persistState();
}

function startAutoCaptureForTab(tabId) {
    cleanupTabDebugger(tabId);

    const debuggee = { tabId: tabId };
    chrome.debugger.attach(debuggee, "1.3", () => {
        if (chrome.runtime.lastError) return;
        attachedTabs.add(tabId);

        chrome.debugger.sendCommand(debuggee, "Network.enable", {}, () => {
            pollingTimers[tabId] = setInterval(() => {
                if (!attachedTabs.has(tabId)) return;

                let validRequests = [];
                for (const requestId in capturedRequests) {
                    const req = capturedRequests[requestId];
                    if (req.tabId === tabId && req.lastItagUrl && req.videoTitle) {
                        validRequests.push(req);
                    }
                }

                let currentCount = validRequests.length;
                if (!autoPopupCount[tabId]) autoPopupCount[tabId] = 0;

                if (currentCount > autoPopupCount[tabId]) {
                    autoPopupCount[tabId] = currentCount;
                    safeOpenPopup();
                }
            }, 1000);
        });
    });
}

// ---- Auto-refresh until the video is found ----
// After Turn on for a video, the page is refreshed if the video stream has
// not been seen yet (Drive can start the player before capture is ready).
// It stops as soon as the video is found, or after MEDIA_WATCH_MAX_TRIES.
const MEDIA_WATCH_DELAY_MS  = 8000;
const MEDIA_WATCH_MAX_TRIES = 4;
const MEDIA_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', '3gp', '3g2', 'mpg', 'mpeg',
    'mts', 'm2ts', 'ts', 'ogv', 'vob', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aif', 'aiff', 'amr']);
const mediaWatch = {}; // tabId -> { tries, timer, gaveUp }

function stopMediaWatch(tabId) {
    const w = mediaWatch[tabId];
    if (w && w.timer) clearTimeout(w.timer);
    delete mediaWatch[tabId];
}

function startMediaWatch(tabId) {
    stopMediaWatch(tabId);
    mediaWatch[tabId] = { tries: 0, timer: null, gaveUp: false };
    scheduleMediaCheck(tabId);
}

function tabHasActiveDownload(tabId) {
    for (const rid in downloadProgress) {
        const req = capturedRequests[rid];
        if (req && req.tabId === tabId && isActiveStatus(downloadProgress[rid] && downloadProgress[rid].status)) return true;
    }
    return false;
}

function scheduleMediaCheck(tabId) {
    const w = mediaWatch[tabId];
    if (!w || w.gaveUp) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
        const cur = mediaWatch[tabId];
        if (!cur) return;          // found (or turned off) in the meantime
        cur.timer = null;
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab || !mediaWatch[tabId]) return;
            // Only file pages that can hold a video; a PDF / document is never refreshed.
            const title = (tab.title || '').replace(/\s+-\s+Google Drive\s*$/i, '');
            const ext = (title.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
            if (!DRIVE_FILE_ID_RE.test(tab.url || '') || (ext && !MEDIA_EXTENSIONS.has(ext.toLowerCase()))) {
                stopMediaWatch(tabId);
                return;
            }
            if (tabHasActiveDownload(tabId)) return; // a reload would cut it off
            if (cur.tries >= MEDIA_WATCH_MAX_TRIES) {
                cur.gaveUp = true;
                return;
            }
            cur.tries++;
            chrome.tabs.reload(tabId, () => { void chrome.runtime.lastError; });
        });
    }, MEDIA_WATCH_DELAY_MS);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url && tab.url.startsWith("https://drive.google.com/")) {
        if (enabledTabs.has(tabId) || pendingTabs.has(tabId)) {
            if (!pollingTimers[tabId]) {
                startAutoCaptureForTab(tabId);
            }
            pendingTabs.delete(tabId);
        }
        if (mediaWatch[tabId]) scheduleMediaCheck(tabId);
    } else if (changeInfo.url && !changeInfo.url.startsWith("https://drive.google.com/")) {
        if (pollingTimers[tabId]) {
            cleanupTabDebugger(tabId);
        }
        // Leaving Drive / Docs turns the tab off; it never comes back on by itself.
        if (!changeInfo.url.startsWith("https://docs.google.com/") && enabledTabs.delete(tabId)) {
            saveEnabledTabs();
            stopMediaWatch(tabId);
        }
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupTabResources(tabId);
    stopMediaWatch(tabId);
    if (enabledTabs.delete(tabId)) saveEnabledTabs();
});

function findDuplicateRequest(videoTitle, lastItagUrl, excludeRequestId) {
    if (!videoTitle || !lastItagUrl) return null;
    for (const rid in capturedRequests) {
        if (rid === excludeRequestId) continue;
        const req = capturedRequests[rid];
        if (req.videoTitle === videoTitle && req.lastItagUrl === lastItagUrl) {
            return rid;
        }
    }
    return null;
}

function findDuplicateByTitle(videoTitle, excludeRequestId) {
    if (!videoTitle) return null;
    for (const rid in capturedRequests) {
        if (rid === excludeRequestId) continue;
        const req = capturedRequests[rid];
        if (req.kind === 'document') continue;
        if (req.videoTitle === videoTitle) {
            return rid;
        }
    }
    return null;
}

chrome.debugger.onEvent.addListener((debuggeeId, method, params) => {
    const tabId = debuggeeId.tabId;
    if (!enabledTabs.has(tabId) && !pendingTabs.has(tabId)) return;
    if (!attachedTabs.has(tabId)) return;

    if (method === "Network.requestWillBeSent") {
        if (params.request.url.startsWith("https://workspacevideo-pa.clients6.google.com")) {
            const requestId = params.requestId;
            capturedRequests[requestId] = {
                url: params.request.url,
                method: params.request.method,
                timestamp: params.timestamp,
                tabId: tabId,
                capturedAt: Date.now()
            };
            persistState();
        }
    } else if (method === "Network.responseReceived") {
        const requestId = params.requestId;
        if (capturedRequests[requestId]) {
            chrome.debugger.sendCommand(
                { tabId: tabId },
                "Network.getResponseBody",
                { requestId: requestId },
                (result) => {
                    if (chrome.runtime.lastError || !result || !result.body) return;
                    capturedRequests[requestId].responseBody = result.body;
                    capturedRequests[requestId].base64Encoded = result.base64Encoded;

                    let newTitle = null;
                    let newUrl = null;
                    let newQuality = null;
                    let newBitrate = null;

                    try {
                        const data = JSON.parse(result.body);
                        const fsd = data.mediaStreamingData && data.mediaStreamingData.formatStreamingData;
                        if (fsd && fsd.progressiveTranscodes && fsd.progressiveTranscodes.length > 0) {
                            const transcodes = fsd.progressiveTranscodes;
                            const last = transcodes[transcodes.length - 1];
                            newUrl = last.url;

                            const meta = last.transcodeMetadata || {};
                            const mimeType = meta.mimeType || '';
                            if (mimeType.startsWith('audio/')) {
                                newQuality = 'AUDIO';
                            } else if (meta.height) {
                                newQuality = meta.height + 'p';
                            } else if (meta.width) {
                                newQuality = meta.width + 'p';
                            } else {
                                newQuality = '';
                            }
                            if (meta.maxContainerBitrate) {
                                newBitrate = meta.maxContainerBitrate;
                            }
                        }
                        if (data.mediaMetadata && data.mediaMetadata.title) {
                            newTitle = data.mediaMetadata.title;
                        }
                    } catch (e) {}

                    // The video was found: no more automatic refreshes for this tab.
                    if (newTitle && newUrl) stopMediaWatch(tabId);

                    if (newTitle && newUrl) {
                        const dupId = findDuplicateRequest(newTitle, newUrl, requestId);
                        if (dupId) {
                            const oldReq = capturedRequests[dupId];
                            if (oldReq) {
                                oldReq.lastItagUrl = newUrl;
                                if (newQuality !== null) oldReq.quality = newQuality;
                                if (newBitrate) oldReq.bitrate = newBitrate;
                                oldReq.videoTitle = newTitle;
                            }
                            delete capturedRequests[requestId];
                            if (downloadProgress[requestId]) {
                                if (!downloadProgress[dupId]) {
                                    downloadProgress[dupId] = downloadProgress[requestId];
                                    downloadProgress[dupId].title = newTitle;
                                } else {
                                    const existingStatus = downloadProgress[dupId].status;
                                    const incomingStatus = downloadProgress[requestId].status;
                                    if (existingStatus === 'completed' && incomingStatus !== 'completed') {
                                    } else if (existingStatus !== 'starting' && existingStatus !== 'downloading' && existingStatus !== 'paused') {
                                        downloadProgress[dupId] = Object.assign(
                                            {},
                                            downloadProgress[dupId],
                                            downloadProgress[requestId],
                                            { title: newTitle }
                                        );
                                    }
                                }
                                delete downloadProgress[requestId];
                            }
                            persistState();
                            return;
                        }

                        const dupTitleId = findDuplicateByTitle(newTitle, requestId);
                        if (dupTitleId) {
                            const existingProgress = downloadProgress[dupTitleId];
                            const keepDupProgress = existingProgress && (
                                existingProgress.status === 'starting' ||
                                existingProgress.status === 'downloading' ||
                                existingProgress.status === 'paused' ||
                                existingProgress.status === 'completed'
                            );

                            if (keepDupProgress) {
                                const oldReq = capturedRequests[dupTitleId];
                                if (oldReq) {
                                    oldReq.lastItagUrl = newUrl;
                                    if (newQuality !== null) oldReq.quality = newQuality;
                                    if (newBitrate) oldReq.bitrate = newBitrate;
                                    oldReq.videoTitle = newTitle;
                                }
                                delete capturedRequests[requestId];
                                persistState();
                                return;
                            }

                            delete capturedRequests[dupTitleId];
                            if (downloadProgress[dupTitleId] && !downloadProgress[requestId]) {
                                downloadProgress[requestId] = downloadProgress[dupTitleId];
                                downloadProgress[requestId].title = newTitle;
                                delete downloadProgress[dupTitleId];
                            } else if (downloadProgress[dupTitleId]) {
                                delete downloadProgress[dupTitleId];
                            }
                        }
                    }

                    if (newUrl) capturedRequests[requestId].lastItagUrl = newUrl;
                    if (newQuality !== null) capturedRequests[requestId].quality = newQuality;
                    if (newBitrate) capturedRequests[requestId].bitrate = newBitrate;
                    if (newTitle) capturedRequests[requestId].videoTitle = newTitle;

                    persistState();
                }
            );
        }
    }
});

function audioDownloadFn(url, videoTitle, requestId, isAudio, wantMp3) {
    const CHUNK_SIZE  = 512 * 1024;
    const CONCURRENCY = 24;
    const MAX_RETRIES = 4;
    const MIN_RELIABLE_SIZE = 256 * 1024;
    const STREAMING_MAX_RETRIES = 3;

    let isPaused    = false;
    let isCancelled = false;
    let messageListener = null;

    const abortController = (typeof AbortController !== 'undefined')
        ? new AbortController() : null;

    const MEDIA_EXT_RE = /\.(mp4|m4v|mov|mkv|avi|wmv|flv|webm|3gp|mpe?g|mp3|m4a|aac|wav|ogg|oga|opus|flac|wma)$/i;

    const sanitizeTitle = (raw) => {
        let t = (raw || (isAudio ? 'audio' : 'video'))
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[\s.]+|[\s.]+$/g, '')
            .replace(MEDIA_EXT_RE, '');
        if (!t) t = isAudio ? 'audio' : 'video';
        if (t.length > 200) t = t.substring(0, 200);
        return t;
    };

    const baseName = sanitizeTitle(videoTitle);

    // Name the file after what the bytes really are, not what the original was
    // called: Drive may hand back a different format than the uploaded file.
    const detectExtension = async (blob) => {
        try {
            const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
            if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';               // ID3 tag
            if (b[0] === 0xFF && (b[1] & 0xE6) === 0xE2) return 'mp3';                       // MPEG audio frame
            if (b[0] === 0xFF && (b[1] & 0xF6) === 0xF0) return 'aac';                       // ADTS AAC
            if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {          // 'ftyp' (MP4 family)
                return isAudio ? 'm4a' : 'mp4';
            }
            if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return isAudio ? 'weba' : 'webm';
            if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg'; // 'OggS'
            if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav'; // 'RIFF'
            if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'flac';// 'fLaC'
        } catch (e) {}
        return isAudio ? 'm4a' : 'mp4';
    };

    const report = (status, completedBytes, totalBytes, percent, error, phase) => {
        try {
            chrome.runtime.sendMessage({
                type: 'downloadProgressUpdate',
                requestId: requestId,
                status: status,
                completed: completedBytes,
                total: totalBytes,
                percent: percent,
                error: error,
                phase: phase || null
            }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const waitIfPaused = async () => {
        while (isPaused && !isCancelled) {
            await sleep(100);
        }
    };

    messageListener = (msg) => {
        if (!msg || msg.requestId !== requestId) return;
        if (msg.type === 'pauseDownload') {
            isPaused = true;
        } else if (msg.type === 'resumeDownload') {
            isPaused = false;
        } else if (msg.type === 'cancelDownload') {
            isCancelled = true;
            isPaused = false;
            if (abortController) {
                try { abortController.abort(); } catch (e) {}
            }
        }
    };
    try {
        chrome.runtime.onMessage.addListener(messageListener);
    } catch (e) {}

    const beforeUnloadHandler = (event) => {
        event.preventDefault();
        event.returnValue = 'A video download is still in progress. Are you sure you want to leave?';
        try {
            chrome.runtime.sendMessage({
                type: 'showPopup',
                requestId: requestId
            }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
        return 'A video download is still in progress. Are you sure you want to leave?';
    };
    try {
        window.addEventListener('beforeunload', beforeUnloadHandler);
    } catch (e) {}

    const cleanup = () => {
        try {
            chrome.runtime.onMessage.removeListener(messageListener);
        } catch (e) {}
        try {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
        } catch (e) {}
    };

    const MP3_BITRATE_KBPS     = 192;
    const MP3_SAMPLE_RATE      = 44100;
    const MP3_MAX_SOURCE_BYTES = 80 * 1024 * 1024; // decoding bigger files needs too much memory

    // Re-encode audio to MP3 with lamejs (injected as lib/lame.min.js).
    // Returns null when conversion is not possible, so the caller keeps the original.
    const convertToMp3 = async (blob) => {
        if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) return null;
        if (blob.size > MP3_MAX_SOURCE_BYTES) return null;
        try {
            report('downloading', blob.size, blob.size, 0, null, 'converting');
            const ctx = new OfflineAudioContext(2, 1, MP3_SAMPLE_RATE);
            const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
            const channels = Math.min(2, audio.numberOfChannels);

            const toInt16 = (f32) => {
                const out = new Int16Array(f32.length);
                for (let i = 0; i < f32.length; i++) {
                    const s = Math.max(-1, Math.min(1, f32[i]));
                    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                return out;
            };
            const left  = toInt16(audio.getChannelData(0));
            const right = channels > 1 ? toInt16(audio.getChannelData(1)) : null;

            const encoder = new lamejs.Mp3Encoder(channels, MP3_SAMPLE_RATE, MP3_BITRATE_KBPS);
            const FRAME = 1152;
            const parts = [];
            let lastYield = Date.now();
            for (let i = 0; i < left.length; i += FRAME) {
                if (isCancelled) throw new Error('cancelled');
                const l = left.subarray(i, i + FRAME);
                const buf = right ? encoder.encodeBuffer(l, right.subarray(i, i + FRAME)) : encoder.encodeBuffer(l);
                if (buf.length) parts.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
                if (Date.now() - lastYield > 200) {
                    lastYield = Date.now();
                    report('downloading', blob.size, blob.size, Math.round((i / left.length) * 100), null, 'converting');
                    await sleep(0);
                }
            }
            const tail = encoder.flush();
            if (tail.length) parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length));
            return new Blob(parts, { type: 'audio/mpeg' });
        } catch (e) {
            if (isCancelled) throw e;
            return null;
        }
    };

    // Saves the file and returns the blob that was actually saved.
    const triggerDownload = async (blob) => {
        let ext = await detectExtension(blob);
        if (isAudio && wantMp3 && ext !== 'mp3') {
            const mp3 = await convertToMp3(blob);
            if (mp3) {
                blob = mp3;
                ext = 'mp3';
            }
        }
        const downloadURL = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadURL;
        a.download = baseName + '.' + ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(downloadURL); } catch (e) {} }, 60000);
        return blob;
    };

    const isUrlExpired = (response) => {
        if (!response) return false;
        if (response.status === 403) return true;
        if (response.status === 410) return true;
        return false;
    };

    const isAbortError = (e) => {
        if (!e) return false;
        if (e.name === 'AbortError') return true;
        if (e.name === 'TimeoutError') return false;
        const msg = (e.message || '').toLowerCase();
        return msg.includes('abort') || msg.includes('signal is aborted');
    };

    const makeChunkedRequest = async (chunkUrl, start, end) => {
        const localController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

        const pauseChecker = setInterval(() => {
            if (isCancelled) {
                try { localController.abort(); } catch (e) {}
            }
        }, 50);

        try {
            const response = await fetch(chunkUrl, {
                credentials: 'include',
                headers: {
                    Range: 'bytes=' + start + '-' + end,
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                signal: localController ? localController.signal : undefined
            });
            return { response, controller: localController };
        } finally {
            clearInterval(pauseChecker);
        }
    };

    (async () => {
        try {
            report('starting', 0, 0, 0, null);

            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            let totalSize = 0;
            let rangeSupported = false;

            try {
                const probe = await fetch(url, {
                    credentials: 'include',
                    headers: { Range: 'bytes=0-0' },
                    signal: abortController ? abortController.signal : undefined
                });

                if (isUrlExpired(probe)) {
                    report('error', 0, 0, 0, 'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                    cleanup();
                    return;
                }

                if (probe.status === 206 || probe.ok) {
                    if (probe.status === 206) rangeSupported = true;

                    const cr = probe.headers.get('Content-Range');
                    if (cr) {
                        const m = cr.match(/\/(\d+)/);
                        if (m) {
                            totalSize = parseInt(m[1], 10);
                            rangeSupported = true;
                        }
                    }

                    if (!totalSize) {
                        const cl = probe.headers.get('Content-Length');
                        if (cl) {
                            const clNum = parseInt(cl, 10);
                            if (clNum > 1) {
                                totalSize = clNum;
                                rangeSupported = false;
                            }
                        }
                    }
                }

                try { await probe.arrayBuffer(); } catch (e) {}
            } catch (probeErr) {
                if (isCancelled) {
                    report('cancelled', 0, 0, 0, null);
                    cleanup();
                    return;
                }
            }

            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            if (!totalSize || totalSize < MIN_RELIABLE_SIZE || !rangeSupported) {
                await streamingDownload();
                return;
            }

            await chunkedDownload(totalSize);
        } catch (err) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
            } else {
                report('error', 0, 0, 0, err && err.message ? err.message : String(err));
            }
            cleanup();
        }
    })();

    async function streamingDownload() {
        let lastErr = null;

        for (let attempt = 1; attempt <= STREAMING_MAX_RETRIES; attempt++) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            let response;
            try {
                response = await fetch(url, {
                    credentials: 'include',
                    signal: abortController ? abortController.signal : undefined
                });
            } catch (e) {
                lastErr = e;
                if (isCancelled) {
                    report('cancelled', 0, 0, 0, null);
                    cleanup();
                    return;
                }
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                break;
            }

            if (isUrlExpired(response)) {
                report('error', 0, 0, 0, 'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                cleanup();
                return;
            }

            if (!response.ok && response.status !== 206) {
                lastErr = new Error('HTTP ' + response.status);
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                break;
            }

            const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
            const reader = response.body ? response.body.getReader() : null;
            const chunks = [];
            let received = 0;

            if (!reader) {
                try {
                    const blob = await response.blob();
                    const saved = await triggerDownload(blob);
                    report('completed', saved.size, saved.size, 100, null);
                } catch (e) {
                    report('error', 0, 0, 0, e && e.message ? e.message : String(e));
                }
                cleanup();
                return;
            }

            try {
                while (true) {
                    if (isCancelled) {
                        try { reader.cancel(); } catch (e) {}
                        report('cancelled', received, contentLength, 0, null);
                        cleanup();
                        return;
                    }
                    if (isPaused) {
                        report('paused', received, contentLength,
                               contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                        await waitIfPaused();
                        if (isCancelled) {
                            try { reader.cancel(); } catch (e) {}
                            report('cancelled', received, contentLength, 0, null);
                            cleanup();
                            return;
                        }
                        report('downloading', received, contentLength,
                               contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                    }

                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.byteLength;

                    const percent = contentLength > 0
                        ? Math.min(100, Math.round((received / contentLength) * 100))
                        : 0;
                    report('downloading', received, contentLength, percent, null);
                }

                const blob = new Blob(chunks, { type: isAudio ? 'audio/mp4' : 'video/mp4' });
                const saved = await triggerDownload(blob);
                report('completed', saved.size, saved.size, 100, null);
                cleanup();
                return;
            } catch (e) {
                if (isCancelled) {
                    report('cancelled', received, contentLength, 0, null);
                    cleanup();
                    return;
                }
                if (isPaused) {
                    await waitIfPaused();
                    if (isCancelled) {
                        report('cancelled', received, contentLength, 0, null);
                        cleanup();
                        return;
                    }
                    report('downloading', received, contentLength,
                           contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                    continue;
                }
                if (isAbortError(e) && !isCancelled) {
                    continue;
                }
                lastErr = e;
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                report('error', received, contentLength, 0,
                       e && e.message ? e.message : String(e));
                cleanup();
                return;
            }
        }

        if (lastErr) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
            } else {
                report('error', 0, 0, 0, lastErr && lastErr.message ? lastErr.message : String(lastErr));
            }
        }
        cleanup();
    }

    async function chunkedDownload(totalSize) {
        const ranges = [];
        for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
            ranges.push({ start: start, end: end });
        }

        report('downloading', 0, totalSize, 0, null);

        const chunks = new Array(ranges.length);
        let nextIndex = 0;
        let bytesDownloaded = 0;
        let lastReportTime = 0;

        async function worker() {
            while (true) {
                if (isCancelled) return;

                if (isPaused) {
                    await waitIfPaused();
                    if (isCancelled) return;
                }

                const index = nextIndex++;
                if (index >= ranges.length) return;

                const { start, end } = ranges[index];
                let chunkComplete = false;
                let rangeIgnored = false;

                for (let attempt = 1; attempt <= MAX_RETRIES && !chunkComplete; attempt++) {
                    if (isCancelled) return;
                    if (isPaused) {
                        await waitIfPaused();
                        if (isCancelled) return;
                    }

                    let response = null;
                    try {
                        const chunkUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') +
                            'rn=' + index + '.' + attempt + '.' + Date.now();

                        const result = await makeChunkedRequest(chunkUrl, start, end);
                        response = result.response;

                        if (response.status === 200 && response.headers.get('Content-Range')) {
                            rangeIgnored = true;
                            break;
                        }
                        if (response.ok || response.status === 206) {
                            if (isUrlExpired(response)) {
                                report('error', bytesDownloaded, totalSize,
                                       Math.round((bytesDownloaded / totalSize) * 100),
                                       'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                                cleanup();
                                return;
                            }
                        } else {
                            if (isUrlExpired(response)) {
                                report('error', bytesDownloaded, totalSize,
                                       Math.round((bytesDownloaded / totalSize) * 100),
                                       'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                                cleanup();
                                return;
                            }
                            response = null;
                        }
                    } catch (e) {
                        if (isCancelled) return;
                        if (isPaused) {
                            await waitIfPaused();
                            if (isCancelled) return;
                            attempt--;
                            continue;
                        }
                        if (isAbortError(e) && !isCancelled) {
                            attempt--;
                            continue;
                        }
                        response = null;
                    }

                    if (rangeIgnored) break;

                    if (!response) {
                        if (attempt < MAX_RETRIES) {
                            const waitMs = 200 * attempt;
                            const steps = Math.max(1, Math.floor(waitMs / 50));
                            for (let i = 0; i < steps; i++) {
                                if (isCancelled) return;
                                if (isPaused) break;
                                await sleep(50);
                            }
                            continue;
                        }
                        throw new Error('Chunk ' + (index + 1) + ' failed after ' + MAX_RETRIES + ' retries');
                    }

                    let data;
                    try {
                        data = await response.arrayBuffer();
                    } catch (e) {
                        if (isCancelled) return;
                        if (isPaused) {
                            await waitIfPaused();
                            if (isCancelled) return;
                            attempt--;
                            continue;
                        }
                        if (isAbortError(e) && !isCancelled) {
                            attempt--;
                            continue;
                        }
                        if (attempt < MAX_RETRIES) {
                            const waitMs = 200 * attempt;
                            const steps = Math.max(1, Math.floor(waitMs / 50));
                            for (let i = 0; i < steps; i++) {
                                if (isCancelled) return;
                                await sleep(50);
                            }
                            continue;
                        }
                        throw e;
                    }

                    if (isCancelled) return;

                    const expected = end - start + 1;
                    if (data.byteLength < expected) {
                        if (attempt < MAX_RETRIES) {
                            await sleep(200 * attempt);
                            continue;
                        }
                        throw new Error('Chunk ' + (index + 1) + ' short read: ' + data.byteLength + '/' + expected);
                    }
                    chunks[index] = (data.byteLength > expected) ? data.slice(0, expected) : data;
                    bytesDownloaded += chunks[index].byteLength;
                    chunkComplete = true;

                    const now = Date.now();
                    if (now - lastReportTime > 100 || bytesDownloaded >= totalSize) {
                        lastReportTime = now;
                        const percent = Math.min(100, Math.round((bytesDownloaded / totalSize) * 100));
                        report('downloading', bytesDownloaded, totalSize, percent, null);
                    }
                }

                if (isCancelled) return;
                if (rangeIgnored) {
                    throw new Error('Server ignored Range header. Cannot safely download in chunks. Try again or use a different video.');
                }
                if (!chunkComplete) {
                    throw new Error('Chunk ' + (index + 1) + ' failed after ' + MAX_RETRIES + ' retries');
                }
            }
        }

        try {
            await Promise.all(
                Array.from(
                    { length: Math.min(CONCURRENCY, ranges.length) },
                    () => worker()
                )
            );

            if (isCancelled) {
                report('cancelled', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100), null);
                cleanup();
                return;
            }

            const blob = new Blob(chunks, { type: isAudio ? 'audio/mp4' : 'video/mp4' });
            if (blob.size !== totalSize) {
                throw new Error('Final size mismatch: ' + blob.size + '/' + totalSize);
            }

            const saved = await triggerDownload(blob);
            report('completed', saved.size, saved.size, 100, null);
        } catch (err) {
            if (isCancelled) {
                report('cancelled', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100), null);
            } else {
                report('error', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100),
                       err && err.message ? err.message : String(err));
            }
        } finally {
            cleanup();
        }
    }
}

// Video downloader: the original code, unchanged.
function chunkedDownloadFn(url, videoTitle, requestId) {
    const CHUNK_SIZE  = 512 * 1024;
    const CONCURRENCY = 24;
    const MAX_RETRIES = 4;
    const MIN_RELIABLE_SIZE = 256 * 1024;
    const STREAMING_MAX_RETRIES = 3;

    let isPaused    = false;
    let isCancelled = false;
    let messageListener = null;

    const abortController = (typeof AbortController !== 'undefined')
        ? new AbortController() : null;

    const sanitizeTitle = (raw) => {
        let t = (raw || 'video')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[\s.]+|[\s.]+$/g, '')
            .replace(/\.mp4$/i, '');
        if (t.length > 200) t = t.substring(0, 200);
        return t + '.mp4';
    };

    const safeTitle = sanitizeTitle(videoTitle);

    const report = (status, completedBytes, totalBytes, percent, error) => {
        try {
            chrome.runtime.sendMessage({
                type: 'downloadProgressUpdate',
                requestId: requestId,
                status: status,
                completed: completedBytes,
                total: totalBytes,
                percent: percent,
                error: error
            }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const waitIfPaused = async () => {
        while (isPaused && !isCancelled) {
            await sleep(100);
        }
    };

    messageListener = (msg) => {
        if (!msg || msg.requestId !== requestId) return;
        if (msg.type === 'pauseDownload') {
            isPaused = true;
        } else if (msg.type === 'resumeDownload') {
            isPaused = false;
        } else if (msg.type === 'cancelDownload') {
            isCancelled = true;
            isPaused = false;
            if (abortController) {
                try { abortController.abort(); } catch (e) {}
            }
        }
    };
    try {
        chrome.runtime.onMessage.addListener(messageListener);
    } catch (e) {}

    const beforeUnloadHandler = (event) => {
        event.preventDefault();
        event.returnValue = 'A video download is still in progress. Are you sure you want to leave?';
        try {
            chrome.runtime.sendMessage({
                type: 'showPopup',
                requestId: requestId
            }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
        return 'A video download is still in progress. Are you sure you want to leave?';
    };
    try {
        window.addEventListener('beforeunload', beforeUnloadHandler);
    } catch (e) {}

    const cleanup = () => {
        try {
            chrome.runtime.onMessage.removeListener(messageListener);
        } catch (e) {}
        try {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
        } catch (e) {}
    };

    const triggerDownload = (blob) => {
        const downloadURL = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadURL;
        a.download = safeTitle;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(downloadURL); } catch (e) {} }, 60000);
    };

    const isUrlExpired = (response) => {
        if (!response) return false;
        if (response.status === 403) return true;
        if (response.status === 410) return true;
        return false;
    };

    const isAbortError = (e) => {
        if (!e) return false;
        if (e.name === 'AbortError') return true;
        if (e.name === 'TimeoutError') return false;
        const msg = (e.message || '').toLowerCase();
        return msg.includes('abort') || msg.includes('signal is aborted');
    };

    const makeChunkedRequest = async (chunkUrl, start, end) => {
        const localController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

        const pauseChecker = setInterval(() => {
            if (isCancelled) {
                try { localController.abort(); } catch (e) {}
            }
        }, 50);

        try {
            const response = await fetch(chunkUrl, {
                credentials: 'include',
                headers: {
                    Range: 'bytes=' + start + '-' + end,
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                signal: localController ? localController.signal : undefined
            });
            return { response, controller: localController };
        } finally {
            clearInterval(pauseChecker);
        }
    };

    (async () => {
        try {
            report('starting', 0, 0, 0, null);

            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            let totalSize = 0;
            let rangeSupported = false;

            try {
                const probe = await fetch(url, {
                    credentials: 'include',
                    headers: { Range: 'bytes=0-0' },
                    signal: abortController ? abortController.signal : undefined
                });

                if (isUrlExpired(probe)) {
                    report('error', 0, 0, 0, 'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                    cleanup();
                    return;
                }

                if (probe.status === 206 || probe.ok) {
                    if (probe.status === 206) rangeSupported = true;

                    const cr = probe.headers.get('Content-Range');
                    if (cr) {
                        const m = cr.match(/\/(\d+)/);
                        if (m) {
                            totalSize = parseInt(m[1], 10);
                            rangeSupported = true;
                        }
                    }

                    if (!totalSize) {
                        const cl = probe.headers.get('Content-Length');
                        if (cl) {
                            const clNum = parseInt(cl, 10);
                            if (clNum > 1) {
                                totalSize = clNum;
                                rangeSupported = false;
                            }
                        }
                    }
                }

                try { await probe.arrayBuffer(); } catch (e) {}
            } catch (probeErr) {
                if (isCancelled) {
                    report('cancelled', 0, 0, 0, null);
                    cleanup();
                    return;
                }
            }

            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            if (!totalSize || totalSize < MIN_RELIABLE_SIZE || !rangeSupported) {
                await streamingDownload();
                return;
            }

            await chunkedDownload(totalSize);
        } catch (err) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
            } else {
                report('error', 0, 0, 0, err && err.message ? err.message : String(err));
            }
            cleanup();
        }
    })();

    async function streamingDownload() {
        let lastErr = null;

        for (let attempt = 1; attempt <= STREAMING_MAX_RETRIES; attempt++) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            let response;
            try {
                response = await fetch(url, {
                    credentials: 'include',
                    signal: abortController ? abortController.signal : undefined
                });
            } catch (e) {
                lastErr = e;
                if (isCancelled) {
                    report('cancelled', 0, 0, 0, null);
                    cleanup();
                    return;
                }
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                break;
            }

            if (isUrlExpired(response)) {
                report('error', 0, 0, 0, 'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                cleanup();
                return;
            }

            if (!response.ok && response.status !== 206) {
                lastErr = new Error('HTTP ' + response.status);
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                break;
            }

            const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
            const reader = response.body ? response.body.getReader() : null;
            const chunks = [];
            let received = 0;

            if (!reader) {
                try {
                    const blob = await response.blob();
                    triggerDownload(blob);
                    report('completed', blob.size, blob.size, 100, null);
                } catch (e) {
                    report('error', 0, 0, 0, e && e.message ? e.message : String(e));
                }
                cleanup();
                return;
            }

            try {
                while (true) {
                    if (isCancelled) {
                        try { reader.cancel(); } catch (e) {}
                        report('cancelled', received, contentLength, 0, null);
                        cleanup();
                        return;
                    }
                    if (isPaused) {
                        report('paused', received, contentLength,
                               contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                        await waitIfPaused();
                        if (isCancelled) {
                            try { reader.cancel(); } catch (e) {}
                            report('cancelled', received, contentLength, 0, null);
                            cleanup();
                            return;
                        }
                        report('downloading', received, contentLength,
                               contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                    }

                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.byteLength;

                    const percent = contentLength > 0
                        ? Math.min(100, Math.round((received / contentLength) * 100))
                        : 0;
                    report('downloading', received, contentLength, percent, null);
                }

                const blob = new Blob(chunks, { type: 'video/mp4' });
                triggerDownload(blob);
                report('completed', blob.size, blob.size, 100, null);
                cleanup();
                return;
            } catch (e) {
                if (isCancelled) {
                    report('cancelled', received, contentLength, 0, null);
                    cleanup();
                    return;
                }
                if (isPaused) {
                    await waitIfPaused();
                    if (isCancelled) {
                        report('cancelled', received, contentLength, 0, null);
                        cleanup();
                        return;
                    }
                    report('downloading', received, contentLength,
                           contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                    continue;
                }
                if (isAbortError(e) && !isCancelled) {
                    continue;
                }
                lastErr = e;
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                report('error', received, contentLength, 0,
                       e && e.message ? e.message : String(e));
                cleanup();
                return;
            }
        }

        if (lastErr) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
            } else {
                report('error', 0, 0, 0, lastErr && lastErr.message ? lastErr.message : String(lastErr));
            }
        }
        cleanup();
    }

    async function chunkedDownload(totalSize) {
        const ranges = [];
        for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
            ranges.push({ start: start, end: end });
        }

        report('downloading', 0, totalSize, 0, null);

        const chunks = new Array(ranges.length);
        let nextIndex = 0;
        let bytesDownloaded = 0;
        let lastReportTime = 0;

        async function worker() {
            while (true) {
                if (isCancelled) return;

                if (isPaused) {
                    await waitIfPaused();
                    if (isCancelled) return;
                }

                const index = nextIndex++;
                if (index >= ranges.length) return;

                const { start, end } = ranges[index];
                let chunkComplete = false;
                let rangeIgnored = false;

                for (let attempt = 1; attempt <= MAX_RETRIES && !chunkComplete; attempt++) {
                    if (isCancelled) return;
                    if (isPaused) {
                        await waitIfPaused();
                        if (isCancelled) return;
                    }

                    let response = null;
                    try {
                        const chunkUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') +
                            'rn=' + index + '.' + attempt + '.' + Date.now();

                        const result = await makeChunkedRequest(chunkUrl, start, end);
                        response = result.response;

                        if (response.status === 200 && response.headers.get('Content-Range')) {
                            rangeIgnored = true;
                            break;
                        }
                        if (response.ok || response.status === 206) {
                            if (isUrlExpired(response)) {
                                report('error', bytesDownloaded, totalSize,
                                       Math.round((bytesDownloaded / totalSize) * 100),
                                       'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                                cleanup();
                                return;
                            }
                        } else {
                            if (isUrlExpired(response)) {
                                report('error', bytesDownloaded, totalSize,
                                       Math.round((bytesDownloaded / totalSize) * 100),
                                       'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                                cleanup();
                                return;
                            }
                            response = null;
                        }
                    } catch (e) {
                        if (isCancelled) return;
                        if (isPaused) {
                            await waitIfPaused();
                            if (isCancelled) return;
                            attempt--;
                            continue;
                        }
                        if (isAbortError(e) && !isCancelled) {
                            attempt--;
                            continue;
                        }
                        response = null;
                    }

                    if (rangeIgnored) break;

                    if (!response) {
                        if (attempt < MAX_RETRIES) {
                            const waitMs = 200 * attempt;
                            const steps = Math.max(1, Math.floor(waitMs / 50));
                            for (let i = 0; i < steps; i++) {
                                if (isCancelled) return;
                                if (isPaused) break;
                                await sleep(50);
                            }
                            continue;
                        }
                        throw new Error('Chunk ' + (index + 1) + ' failed after ' + MAX_RETRIES + ' retries');
                    }

                    let data;
                    try {
                        data = await response.arrayBuffer();
                    } catch (e) {
                        if (isCancelled) return;
                        if (isPaused) {
                            await waitIfPaused();
                            if (isCancelled) return;
                            attempt--;
                            continue;
                        }
                        if (isAbortError(e) && !isCancelled) {
                            attempt--;
                            continue;
                        }
                        if (attempt < MAX_RETRIES) {
                            const waitMs = 200 * attempt;
                            const steps = Math.max(1, Math.floor(waitMs / 50));
                            for (let i = 0; i < steps; i++) {
                                if (isCancelled) return;
                                await sleep(50);
                            }
                            continue;
                        }
                        throw e;
                    }

                    if (isCancelled) return;

                    const expected = end - start + 1;
                    if (data.byteLength < expected) {
                        if (attempt < MAX_RETRIES) {
                            await sleep(200 * attempt);
                            continue;
                        }
                        throw new Error('Chunk ' + (index + 1) + ' short read: ' + data.byteLength + '/' + expected);
                    }
                    chunks[index] = (data.byteLength > expected) ? data.slice(0, expected) : data;
                    bytesDownloaded += chunks[index].byteLength;
                    chunkComplete = true;

                    const now = Date.now();
                    if (now - lastReportTime > 100 || bytesDownloaded >= totalSize) {
                        lastReportTime = now;
                        const percent = Math.min(100, Math.round((bytesDownloaded / totalSize) * 100));
                        report('downloading', bytesDownloaded, totalSize, percent, null);
                    }
                }

                if (isCancelled) return;
                if (rangeIgnored) {
                    throw new Error('Server ignored Range header. Cannot safely download in chunks. Try again or use a different video.');
                }
                if (!chunkComplete) {
                    throw new Error('Chunk ' + (index + 1) + ' failed after ' + MAX_RETRIES + ' retries');
                }
            }
        }

        try {
            await Promise.all(
                Array.from(
                    { length: Math.min(CONCURRENCY, ranges.length) },
                    () => worker()
                )
            );

            if (isCancelled) {
                report('cancelled', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100), null);
                cleanup();
                return;
            }

            const blob = new Blob(chunks, { type: 'video/mp4' });
            if (blob.size !== totalSize) {
                throw new Error('Final size mismatch: ' + blob.size + '/' + totalSize);
            }

            triggerDownload(blob);
            report('completed', blob.size, blob.size, 100, null);
        } catch (err) {
            if (isCancelled) {
                report('cancelled', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100), null);
            } else {
                report('error', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100),
                       err && err.message ? err.message : String(err));
            }
        } finally {
            cleanup();
        }
    }
}

// Runs inside the Drive preview tab. Scrolls through the viewer, grabs each
// rendered page image, and stitches them into an image-based PDF.
function docCaptureFn(docTitle, requestId) {
    const SCROLL_DELAY_MS = 700;
    const RECHECK_DELAY_MS = 300;
    const SETTLE_ROUNDS   = 4;
    const FIRST_PAGE_TIMEOUT_MS = 15000;
    const MIN_PAGE_WIDTH  = 150;
    const MAX_SCROLL_STEPS = 5000;
    const JPEG_QUALITY    = 0.92;
    const PDF_PAGE_WIDTH  = 595.28; // A4 width in points, fallback for unknown sizes
    // Standard paper sizes in points [width, height]. Drive renders the full
    // page (margins included), so matching the aspect ratio recovers the size.
    // A3/A4/A5 share one ratio, so A-series pages come out as A4.
    const PAPER_SIZES = [
        [595.28, 841.89],  // A4
        [612, 792],        // Letter
        [612, 1008],       // Legal
        [792, 1224],       // Tabloid
        [522, 756],        // Executive
        [960, 540],        // Slides 16:9
        [720, 540]         // Slides 4:3
    ];
    const PAPER_RATIO_TOLERANCE = 0.006;

    let isPaused    = false;
    let isCancelled = false;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const report = (status, pages, percent, error, bytes) => {
        try {
            chrome.runtime.sendMessage({
                type: 'downloadProgressUpdate',
                requestId: requestId,
                status: status,
                pages: pages,
                completed: bytes || 0,
                total: bytes || 0,
                percent: percent,
                error: error
            }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
    };

    const messageListener = (msg) => {
        if (!msg || msg.requestId !== requestId) return;
        if (msg.type === 'pauseDownload') isPaused = true;
        else if (msg.type === 'resumeDownload') isPaused = false;
        else if (msg.type === 'cancelDownload') { isCancelled = true; isPaused = false; }
    };
    try { chrome.runtime.onMessage.addListener(messageListener); } catch (e) {}

    const beforeUnloadHandler = (event) => {
        event.preventDefault();
        event.returnValue = 'A file capture is still in progress. Are you sure you want to leave?';
        return event.returnValue;
    };
    try { window.addEventListener('beforeunload', beforeUnloadHandler); } catch (e) {}

    const cleanup = () => {
        try { chrome.runtime.onMessage.removeListener(messageListener); } catch (e) {}
        try { window.removeEventListener('beforeunload', beforeUnloadHandler); } catch (e) {}
    };

    const fileName = (() => {
        let t = (docTitle || 'document')
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[\s.]+|[\s.]+$/g, '');
        if (!t) t = 'document';
        if (t.length > 200) t = t.substring(0, 200);
        return t + '.pdf';
    })();

    // Drive's older viewer shows pages as blob: images; the newer one
    // (drive-viewer) draws each page on a <canvas>. Accept both.
    const isOnScreen = (el) => {
        const r = el.getBoundingClientRect();
        return r.width >= MIN_PAGE_WIDTH && r.bottom > 0 && r.top < window.innerHeight;
    };
    const pageElements = () => {
        const out = [];
        for (const img of document.querySelectorAll('img')) {
            if (img.src && img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0 && isOnScreen(img)) out.push(img);
        }
        for (const cv of document.querySelectorAll('canvas')) {
            if (cv.width > 0 && cv.height > 0 && isOnScreen(cv)) out.push(cv);
        }
        return out;
    };
    const sizeOf = (el) => el.tagName === 'CANVAS' ? [el.width, el.height] : [el.naturalWidth, el.naturalHeight];

    const findScroller = (el) => {
        let n = el && el.parentElement;
        while (n && n !== document.body && n !== document.documentElement) {
            const oy = getComputedStyle(n).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 10) return n;
            n = n.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    };

    const captured = new Map(); // vertical position -> { w, h, bytes }

    const captureImage = (img, key) => new Promise((resolve) => {
        try {
            const [w, h] = sizeOf(img);
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob(async (blob) => {
                if (!blob) { resolve(); return; }
                const bytes = new Uint8Array(await blob.arrayBuffer());
                captured.set(key, { w: w, h: h, bytes: bytes });
                resolve();
            }, 'image/jpeg', JPEG_QUALITY);
        } catch (e) {
            resolve();
        }
    });

    // A page is saved the second time it is seen on screen, so a canvas that
    // was still drawing on the first pass is captured once it has finished.
    const seenCount = new Map();
    const captureVisible = async (scroller) => {
        const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
        for (const el of pageElements()) {
            const key = Math.round((el.getBoundingClientRect().top - base) / 10);
            if (captured.has(key)) continue;
            const seen = (seenCount.get(key) || 0) + 1;
            seenCount.set(key, seen);
            if (seen >= 2) await captureImage(el, key);
        }
    };

    const pageSizeFor = (w, h) => {
        const ratio = h / w;
        for (const [sw, sh] of PAPER_SIZES) {
            for (const [pw, ph] of [[sw, sh], [sh, sw]]) {
                const target = ph / pw;
                if (Math.abs(ratio - target) / target < PAPER_RATIO_TOLERANCE) return [pw, ph];
            }
        }
        return [PDF_PAGE_WIDTH, PDF_PAGE_WIDTH * ratio];
    };

    const buildPdf = (pages) => {
        const enc = new TextEncoder();
        const parts = [];
        const offsets = [];
        let offset = 0;
        const push = (d) => {
            const b = (typeof d === 'string') ? enc.encode(d) : d;
            parts.push(b);
            offset += b.length;
        };
        const obj = (num, writeBody) => {
            offsets[num] = offset;
            push(num + ' 0 obj\n');
            writeBody();
            push('\nendobj\n');
        };

        const n = pages.length;
        const totalObjs = 2 + n * 3;
        push('%PDF-1.4\n%âãÏÓ\n');
        obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
        const kids = pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
        obj(2, () => push('<< /Type /Pages /Kids [' + kids + '] /Count ' + n + ' >>'));

        pages.forEach((p, i) => {
            const pageNum = 3 + i * 3, contentNum = pageNum + 1, imgNum = pageNum + 2;
            const size = pageSizeFor(p.w, p.h);
            const pw = size[0].toFixed(2);
            const ph = size[1].toFixed(2);
            obj(pageNum, () => push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] ' +
                '/Resources << /XObject << /Im0 ' + imgNum + ' 0 R >> >> /Contents ' + contentNum + ' 0 R >>'));
            const content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
            obj(contentNum, () => push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'));
            obj(imgNum, () => {
                push('<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h +
                     ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.bytes.length + ' >>\nstream\n');
                push(p.bytes);
                push('\nendstream');
            });
        });

        const xrefOffset = offset;
        let xref = 'xref\n0 ' + (totalObjs + 1) + '\n0000000000 65535 f \n';
        for (let k = 1; k <= totalObjs; k++) {
            xref += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
        }
        push(xref);
        push('trailer\n<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n');
        return new Blob(parts, { type: 'application/pdf' });
    };

    const triggerDownload = (blob) => {
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(href); } catch (e) {} }, 60000);
    };

    (async () => {
        try {
            report('starting', 0, 0, null);

            const waitStart = Date.now();
            let first = pageElements()[0];
            while (!first && Date.now() - waitStart < FIRST_PAGE_TIMEOUT_MS) {
                if (isCancelled) { report('cancelled', 0, 0, null); return; }
                await sleep(300);
                first = pageElements()[0];
            }
            if (!first) {
                report('error', 0, 0, 'No document pages found. Wait for the first page to appear in the preview, then try again.');
                return;
            }

            const scroller = findScroller(first);
            scroller.scrollTop = 0;
            await sleep(SCROLL_DELAY_MS);

            let settled = 0;
            for (let step = 0; step < MAX_SCROLL_STEPS; step++) {
                if (isCancelled) { report('cancelled', captured.size, 0, null); return; }
                if (isPaused) {
                    report('paused', captured.size, 0, null);
                    while (isPaused && !isCancelled) await sleep(150);
                    continue;
                }

                // Two looks per step: the first marks what is on screen, the
                // second (after a short wait for drawing) saves it.
                await captureVisible(scroller);
                await sleep(RECHECK_DELAY_MS);
                await captureVisible(scroller);

                const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
                const percent = Math.min(90, Math.round((scroller.scrollTop / maxScroll) * 90));
                report('downloading', captured.size, percent, null);

                const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
                if (atBottom) {
                    settled++;
                    if (settled >= SETTLE_ROUNDS) break;
                } else {
                    settled = 0;
                    scroller.scrollTop += Math.max(200, Math.round(scroller.clientHeight * 0.7));
                }
                await sleep(SCROLL_DELAY_MS);
            }

            if (captured.size === 0) {
                report('error', 0, 0, 'Could not read any page images from this preview.');
                return;
            }

            const keys = Array.from(captured.keys()).sort((a, b) => a - b);
            const pdf = buildPdf(keys.map(k => captured.get(k)));
            triggerDownload(pdf);
            report('completed', keys.length, 100, null, pdf.size);
        } catch (err) {
            report(isCancelled ? 'cancelled' : 'error', captured.size, 0,
                   isCancelled ? null : (err && err.message ? err.message : String(err)));
        } finally {
            cleanup();
        }
    })();
}
