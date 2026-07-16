let extId;
let isFirefox = navigator.userAgent.indexOf('Firefox') > -1;
let cookie = null;
let otdtoken = null;

if(!window.chrome) window.chrome = {};
if(!window.chrome.runtime) window.chrome.runtime = {};
window.chrome.runtime.getURL = url => {
    if(!url.startsWith('/')) url = `/${url}`;
    return `${isFirefox ? 'moz-extension://' : 'chrome-extension://'}${extId}${url}`;   
}
window.addEventListener('message', e => {
    if(e.data.extensionId) {
        console.log("got extensionId", e.data.extensionId);
        extId = e.data.extensionId;
        main();
    } else if(e.data.cookie) {
        cookie = e.data.cookie;
    } else if(e.data.token) {
        console.log("got otdtoken");
        otdtoken = e.data.token;
    }
});
window.postMessage('extensionId', '*');
window.postMessage('cookie', '*');
window.postMessage('getotdtoken', '*');

// The layout lives in page localStorage, which twitter's own boot path can clear before any
// OTD code runs (see destroyer.js) — so the backup lives in extension storage, out of reach
// of a page-side clear. Load it once, before interception.js reads localStorage: a deck that
// got wiped comes back on its own, and window.__OTDbackup then backs restoreState() and the
// once-a-day freshness check without either of them needing to go async.
async function loadBackup() {
    window.__OTDbackup = await new Promise(resolve => {
        const done = backup => {
            window.removeEventListener('message', onMsg);
            clearTimeout(timer);
            resolve(backup);
        };
        const onMsg = e => {
            if(e.data && typeof e.data === 'object' && 'otdBackup' in e.data) done(e.data.otdBackup);
        };
        const timer = setTimeout(() => done(null), 3000);
        window.addEventListener('message', onMsg);
        window.postMessage('otdGetBackup', '*');
    });

    let intact = false;
    try {
        intact = Object.keys(JSON.parse(localStorage.OTDcolumns)).length > 0 &&
                 JSON.parse(localStorage.OTDcolumnIds).length > 0;
    } catch(e) {} // missing or corrupt — treat as wiped

    const backup = window.__OTDbackup;
    if(intact || !backup?.columnIds?.length) return;

    localStorage.OTDfeeds = JSON.stringify(backup.feeds);
    localStorage.OTDcolumns = JSON.stringify(backup.columns);
    localStorage.OTDsettings = JSON.stringify(backup.settings);
    localStorage.OTDcolumnIds = JSON.stringify(backup.columnIds);
    console.log(`OTD: layout was missing — restored ${backup.columnIds.length} columns from backup saved ${new Date(backup.savedAt).toLocaleString()}`);
}

async function main() {
    localStorage.OTDenableAutoExpand ??= "1";

    let html = await fetch(chrome.runtime.getURL('/files/index.html')).then(r => r.text());
    document.documentElement.innerHTML = html;

    let [challenge_js, interception_js, vendor_js, bundle_js, bundle_css, twitter_text, xlr_js, xlr_css] =
        await Promise.allSettled([
            fetch(chrome.runtime.getURL("/src/challenge.js")).then(r => r.text()),
            fetch(chrome.runtime.getURL("/src/interception.js")).then(r => r.text()),
            fetch(chrome.runtime.getURL("/files/vendor.js")).then(r => r.text()),
            fetch(chrome.runtime.getURL("/files/bundle.js")).then(r => r.text()),
            fetch(chrome.runtime.getURL("/files/bundle.css")).then(r => r.text()),
            fetch(chrome.runtime.getURL("/files/twitter-text.js")).then(r => r.text()),
            fetch(chrome.runtime.getURL("/src/xlr.js")).then(r => r.text()),
            fetch(chrome.runtime.getURL("/src/xlr.css")).then(r => r.text()),
        ]);
    if (localStorage.OTDalwaysUseLocalFiles === "0") {
        const [
            remote_challenge_js_req,
            remote_interception_js_req,
            remote_vendor_js_req,
            remote_bundle_js_req,
            remote_bundle_css_req,
            remote_twitter_text_req,
        ] = await Promise.allSettled([
            fetch("https://raw.githubusercontent.com/dimdenGD/OldTweetDeck/main/src/challenge.js"),
            fetch("https://raw.githubusercontent.com/dimdenGD/OldTweetDeck/main/src/interception.js"),
            fetch("https://raw.githubusercontent.com/dimdenGD/OldTweetDeck/main/files/vendor.js"),
            fetch("https://raw.githubusercontent.com/dimdenGD/OldTweetDeck/main/files/bundle.js"),
            fetch("https://raw.githubusercontent.com/dimdenGD/OldTweetDeck/main/files/bundle.css"),
            fetch("https://raw.githubusercontent.com/dimdenGD/OldTweetDeck/main/files/twitter-text.js"),
        ]);
        
        if(
            (remote_challenge_js_req.value && remote_challenge_js_req.value.ok) ||
            (remote_interception_js_req.value && remote_interception_js_req.value.ok) || 
            (remote_vendor_js_req.value && remote_vendor_js_req.value.ok) ||
            (remote_bundle_js_req.value && remote_bundle_js_req.value.ok) ||
            (remote_bundle_css_req.value && remote_bundle_css_req.value.ok) ||
            (remote_twitter_text_req.value && remote_twitter_text_req.value.ok)
        ) {
            const [
                remote_challenge_js,
                remote_interception_js,
                remote_vendor_js,
                remote_bundle_js,
                remote_bundle_css,
                remote_twitter_text,
            ] = await Promise.allSettled([
                remote_challenge_js_req.value.text(),
                remote_interception_js_req.value.text(),
                remote_vendor_js_req.value.text(),
                remote_bundle_js_req.value.text(),
                remote_bundle_css_req.value.text(),
                remote_twitter_text_req.value.text(),
            ]);

            if (
                remote_challenge_js_req.value &&
                remote_challenge_js_req.value.ok &&
                remote_challenge_js.status === "fulfilled" &&
                remote_challenge_js.value.length > 30
            ) {
                challenge_js = remote_challenge_js;
                console.log("Using remote challenge.js");
            }

            if (
                remote_interception_js_req.value &&
                remote_interception_js_req.value.ok &&
                remote_interception_js.status === "fulfilled" &&
                remote_interception_js.value.length > 30
            ) {
                interception_js = remote_interception_js;
                console.log("Using remote interception.js");
            }
            if (
                remote_vendor_js_req.value &&
                remote_vendor_js_req.value.ok &&
                remote_vendor_js.status === "fulfilled" &&
                remote_vendor_js.value.length > 30
            ) {
                vendor_js = remote_vendor_js;
                console.log("Using remote vendor.js");
            }
            if (
                remote_bundle_js_req.value &&
                remote_bundle_js_req.value.ok &&
                remote_bundle_js.status === "fulfilled" &&
                remote_bundle_js.value.length > 30
            ) {
                bundle_js = remote_bundle_js;
                console.log("Using remote bundle.js");
            }
            if (
                remote_bundle_css_req.value &&
                remote_bundle_css_req.value.ok &&
                remote_bundle_css.status === "fulfilled" &&
                remote_bundle_css.value.length > 30
            ) {
                bundle_css = remote_bundle_css;
                console.log("Using remote bundle.css");
            }
            if (
                remote_twitter_text_req.value &&
                remote_twitter_text_req.value.ok &&
                remote_twitter_text.status === "fulfilled" &&
                remote_twitter_text.value.length > 30
            ) {
                twitter_text = remote_twitter_text;
                console.log("Using remote twitter-text.js");
            }
        }
    }

    let challenge_js_script = document.createElement("script");
    challenge_js_script.innerHTML = challenge_js.value.replaceAll('SOLVER_URL', chrome.runtime.getURL("solver.html"));
    document.head.appendChild(challenge_js_script);

    // Must land before interception.js: it reads the layout out of localStorage on load.
    await loadBackup();

    let interception_js_script = document.createElement("script");
    interception_js_script.innerHTML = interception_js.value;
    document.head.appendChild(interception_js_script);

    let bundle_css_style = document.createElement("style");
    bundle_css_style.innerHTML = bundle_css.value;
    document.head.appendChild(bundle_css_style);

    // Expose jQuery globally (remove noGlobal flag) so additional scripts can use $
    vendor_js.value = vendor_js.value.replace('i(r, !0)', 'i(r)');

    let vendor_js_script = document.createElement("script");
    vendor_js_script.innerHTML = vendor_js.value;
    document.head.appendChild(vendor_js_script);

    // Classic TweetDeck only renders a quote card when the tweet has no media of its
    // own ({{^hasMedia}}); X now allows media + quote. Drop that guard so both show.
    // Detail view already renders media above the quote, so just unwrap it there.
    bundle_js.value = bundle_js.value.replaceAll(
        "{{^hasMedia}} {{#quotedTweet}} {{{ renderQuoted }}} {{/quotedTweet}} {{/hasMedia}}",
        "{{#quotedTweet}} {{{ renderQuoted }}} {{/quotedTweet}}"
    );
    // Column view renders media (tweet_media_wrapper) after the quote, so move the
    // quote below the media wrapper too — matches x.com (own media, then the quote).
    bundle_js.value = bundle_js.value.replaceAll(
        '{{^hasMedia}} {{#quotedTweet}} {{{ renderQuoted }}} {{/quotedTweet}} {{#isInThread}} <div class="margin-b--5"></div> {{/isInThread}} {{/hasMedia}} {{#quotedTweetMissing}} {{>status/quoted_tweet_missing}} {{/quotedTweetMissing}} {{#translation}}{{>status/tweet_translation}}{{/translation}} {{>status/tweet_media_wrapper}}',
        '{{^hasMedia}} {{#isInThread}} <div class="margin-b--5"></div> {{/isInThread}} {{/hasMedia}} {{#quotedTweetMissing}} {{>status/quoted_tweet_missing}} {{/quotedTweetMissing}} {{#translation}}{{>status/tweet_translation}}{{/translation}} {{>status/tweet_media_wrapper}} {{#quotedTweet}} {{{ renderQuoted }}} {{/quotedTweet}}'
    );

    // Upstream left a debug console.error in logTweetProcessingError. It fires for every
    // tweet shape TweetDeck can't build — already handled (caught, tweet skipped), so the
    // log is pure noise.
    bundle_js.value = bundle_js.value.replaceAll(
        "console.error('logTweetProcessingError', arguments);",
        ""
    );

    let bundle_js_script = document.createElement("script");
    bundle_js_script.innerHTML = bundle_js.value;
    document.head.appendChild(bundle_js_script);

    // OTD has taken over: destroyer.js can stop suppressing twitter's bundles now.
    window.__OTDready = true;

    let twitter_text_script = document.createElement("script");
    twitter_text_script.innerHTML = twitter_text.value;
    document.head.appendChild(twitter_text_script);

    if (xlr_css.value) {
        let xlr_css_style = document.createElement("style");
        xlr_css_style.textContent = xlr_css.value;
        document.head.appendChild(xlr_css_style);
    }
    if (xlr_js.value) {
        let xlr_js_script = document.createElement("script");
        xlr_js_script.textContent = xlr_js.value;
        document.head.appendChild(xlr_js_script);
    }

    (async () => {
        try {
            const additionalScripts = await fetch("https://oldtd.org/api/scripts", {
                headers: otdtoken ? {
                    Authorization: `Bearer ${otdtoken}`
                } : undefined
            }).then(r => r.json());
            for(let script of additionalScripts) {
                let scriptSource = await fetch(`https://oldtd.org/api/scripts/${script}`, {
                    headers: otdtoken ? {
                        Authorization: `Bearer ${otdtoken}`
                    } : undefined
                }).then(r => r.text());
                let scriptElement = document.createElement("script");
                scriptElement.innerHTML = scriptSource;
                document.head.appendChild(scriptElement);
            }
        } catch(e) {
            console.error(e);
        }
    })();

    let int = setTimeout(function() {
        let badBody = document.querySelector('body:not(#injected-body)');
        if (badBody) {
            let badHead = document.querySelector('head:not(#injected-head)');
            clearInterval(int);
            if(badHead) badHead.remove();
            badBody.remove(); 
        }
    }, 200);
    setTimeout(() => clearInterval(int), 10000);

    let injInt;
    function injectAccount() {
        if(!document.querySelector('a[data-title="Accounts"]')) return;
        clearInterval(injInt);

        let accountsBtn = document.querySelector('a[data-title="Accounts"]');
        accountsBtn.addEventListener("click", function() {
            console.log("setting account cookie");
            chrome.runtime.sendMessage({ action: "setcookie" }); 
        });
    }
    setInterval(injectAccount, 1000);
};