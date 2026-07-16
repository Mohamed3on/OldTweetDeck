window.addEventListener('message', async e => {
    if(e.data === 'extensionId') {
        let extId = chrome.runtime.getURL('/injection.js').split("/")[2];
        window.postMessage({ extensionId: extId }, '*');
    } else if(e.data === 'cookie') {
        chrome.runtime.sendMessage({ action: "getcookie" }, cookie => {
            window.postMessage({ cookie }, '*');
        });
    } else if(e.data?.action === 'setotdtoken') {
        chrome.storage.local.set({ otd_token: e.data.token });
    } else if(e.data === 'getotdtoken') {
        chrome.storage.local.get('otd_token', token => {
            window.postMessage({ token: token.otd_token }, '*');
        });
    } else if(e.data?.action === 'otdSaveBackup') {
        // Layout backup kept in extension storage, which page-side clears can't reach.
        chrome.storage.local.set({ otd_state_backup: e.data.state });
    } else if(e.data === 'otdGetBackup') {
        chrome.storage.local.get('otd_state_backup', r => {
            window.postMessage({ otdBackup: r.otd_state_backup ?? null }, '*');
        });
    }
});