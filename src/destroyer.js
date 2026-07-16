// Step 0: protect our state before anything else can run.
// If twitter's own bundles win the race below (this file only holds them off for ~5s,
// while injection.js awaits 8 fetches before interception.js loads), they boot into a
// hijacked DOM, throw, and hit a session-reset path that clears localStorage — taking
// every OTD* key with it: columns, feeds, settings, and the daily backup itself.
// This is the earliest MAIN-world code in the manifest, so the patch lands before any
// page script can call clear(). Nothing in OTD ever removes its own keys, so a foreign
// clear/removeItem touching OTD* is always a bug: preserve them and log who tried.
(() => {
    const _clear = Storage.prototype.clear;
    const _removeItem = Storage.prototype.removeItem;
    const trace = (what, n) =>
        console.warn(`OTD: blocked ${what} of ${n} OTD key(s)\n`, new Error().stack);

    Storage.prototype.clear = function () {
        const saved = [];
        for (let i = 0; i < this.length; i++) {
            const k = this.key(i);
            if (k && k.startsWith("OTD")) saved.push([k, this.getItem(k)]);
        }
        _clear.call(this);
        for (const [k, v] of saved) this.setItem(k, v);
        if (saved.length) trace("storage clear", saved.length);
    };

    Storage.prototype.removeItem = function (k) {
        if (typeof k === "string" && k.startsWith("OTD")) return trace("removeItem", 1);
        return _removeItem.call(this, k);
    };
})();

// Step 1: fool twitter into thinking scripts loaded
window.__SCRIPTS_LOADED__ = Object.freeze({
    main: true,
    vendor: true,
    runtime: false
});

// Step 2: continously wreck havoc
let _destroyerInt = setInterval(() => {
    delete window.webpackChunk_twitter_responsive_web;
    window.__SCRIPTS_LOADED__ = Object.freeze({
        main: true,
        vendor: true,
        runtime: false
    });
    if(document.getElementById('ScriptLoadFailure')) {
        document.getElementById('ScriptLoadFailure').remove();
    }
});

// Step 3: destroy twitter critical modules
let _originalPush = Array.prototype.push;
Array.prototype.push = function() {
    try {
        if(arguments[0]?.[0]?.[0] === "vendor" || arguments[0]?.[0]?.[0] === "main") {
            throw "Twitter killing magic killed Twitter https://lune.dimden.dev/f016efffcd3d.png (thats fine)";
        }
    } catch(e) {
        Array.prototype.push = _originalPush;
    } finally {
        return _originalPush.apply(this, arguments);
    }
}

// Step 4: prevent twitter from reporting it
let _originalTest = RegExp.prototype.test;
RegExp.prototype.test = function() {
    try {
        if(this.toString() === '/[?&]failedScript=/') {
            RegExp.prototype.test = _originalTest;
            throw "hehe";
        };
    } catch(e) {
        RegExp.prototype.test = _originalTest;
    } finally {
        return _originalTest.apply(this, arguments);
    }
}

// Step 5: self destruct. The prototype patches are invasive globals, so they still come off
// on the original timer. The chunk-registry deletion is cheap and touches nothing OTD uses
// (tweetdeck's bundle registers under webpackJsonp), so keep that running until OTD has
// actually taken over instead: injection.js can still be fetching at 5s, and a twitter
// bundle that registers in that window boots into the hijacked DOM, throws, and hits the
// session-reset that clears our storage (see Step 0).
setTimeout(() => {
    Array.prototype.push = _originalPush;
    RegExp.prototype.test = _originalTest;
}, 5000);

let _readyInt = setInterval(() => {
    if(!window.__OTDready && performance.now() < 60000) return;
    clearInterval(_readyInt);
    clearInterval(_destroyerInt);
}, 200);

// Step 6: Live OTD reaction: https://lune.dimden.dev/6743b45eb1de.png