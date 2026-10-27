// x.com profile pages: chips for the lists of yours this account is in (× removes), plus an
// "Add to list" picker — the same row xlr.js puts in TweetDeck's profile popup. Lists and
// memberships live in the list store (src/lists.js), shared with TweetDeck on this origin.
(() => {
  const store = createListStore({
    request: XApi, storage: localStorage, me: () => document.cookie.match(/twid=u%3D(\d+)/)?.[1],
  });
  const isMember = (userId, listId) => !!store.memberOf(userId)?.has(listId);
  const toggle = (userId, listId) => isMember(userId, listId) ? store.remove(userId, listId) : store.add(userId, listId);

  const busy = (el, fn) => async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (el.classList.contains('xp-busy')) return;
    el.classList.add('xp-busy');
    try { await fn(); } finally { el.classList.remove('xp-busy'); }
  };

  const popover = document.createElement('div');
  popover.className = 'xp-popover';
  popover.setAttribute('popover', 'auto');
  document.documentElement.appendChild(popover);

  // Picker items re-sync from the store, which applies a toggle at once and rolls it back on failure.
  let syncPicker = null;
  function showPicker(btn, userId) {
    const items = (store.catalog() || []).map(list => {
      const item = document.createElement('button');
      item.className = 'xp-item';
      item.textContent = list.name;
      item.dataset.listId = list.id;
      item.onclick = busy(item, () => toggle(userId, list.id));
      return item;
    });
    syncPicker = () => items.forEach(item => item.classList.toggle('xp-on', isMember(userId, item.dataset.listId)));
    syncPicker();
    popover.replaceChildren(...items);
    const rect = btn.getBoundingClientRect();
    popover.style.background = getComputedStyle(document.body).backgroundColor;
    popover.style.left = rect.left + 'px';
    popover.style.top = rect.bottom + 6 + 'px';
    popover.showPopover();
  }

  function build(header, userId) {
    const row = document.createElement('div');
    row.className = 'xp-lists xp-loading';
    row.dataset.userId = userId;
    header.appendChild(row);

    const addBtn = document.createElement('button');
    addBtn.className = 'xp-add';
    addBtn.textContent = '+ Add to list';
    // Clicking the button while the picker is open should just close it (light dismiss already did).
    addBtn.onmousedown = () => { addBtn._wasOpen = popover.matches(':popover-open'); };
    addBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!addBtn._wasOpen) showPicker(addBtn, userId);
    };

    // Chips are kept by list id and only the changed ones touched, so an added chip animates in
    // (@starting-style) and a removed one fades out, without the rest re-animating.
    const chips = new Map();
    row.appendChild(addBtn);
    function render() {
      let next = addBtn;
      for (const list of [...store.catalog() || []].reverse()) {
        const member = isMember(userId, list.id);
        let chip = chips.get(list.id);
        if (member && !chip) {
          chip = document.createElement('span');
          chip.className = 'xp-chip';
          chip.textContent = list.name;
          const x = document.createElement('button');
          x.className = 'xp-chip-x';
          x.textContent = '×';
          x.title = `Remove from ${list.name}`;
          x.onclick = busy(chip, () => store.remove(userId, list.id));
          chip.appendChild(x);
          chips.set(list.id, chip);
          row.insertBefore(chip, next);
        } else if (!member && chip) {
          chips.delete(list.id);
          chip.classList.add('xp-leaving');
          chip.addEventListener('transitionend', () => chip.remove(), { once: true });
        }
        if (member) next = chip;
      }
    }

    // A known membership renders at once; the store refetches it once stale. Any change to this
    // user (here, in the picker, or a refetch) redraws the chips until the row leaves the page.
    const off = store.subscribe((id) => {
      if (!row.isConnected) return off();
      if (id === userId || id === null) { render(); syncPicker?.(); }
    });
    if (store.memberOf(userId)) { render(); row.classList.remove('xp-loading'); }
    store.ready.then(() => store.membership(userId)).finally(() => {
      render();
      row.classList.remove('xp-loading');
    });
  }

  // x.com is an SPA that reuses the header across profiles, so re-check on every DOM change.
  // The account's id rides on its Follow/Following button (absent on your own profile).
  let queued = false;
  const scan = () => {
    queued = false;
    const name = document.querySelector('[data-testid="primaryColumn"] [data-testid="UserName"]');
    let header = name?.parentElement;
    while (header && !header.querySelector('[data-testid="UserProfileHeader_Items"]')) header = header.parentElement;
    if (!header) return;
    const userId = header.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]')
      ?.dataset.testid.match(/^(\d+)-/)?.[1];
    const existing = header.querySelector(':scope > .xp-lists');
    if (existing?.dataset.userId === userId) return;
    existing?.remove();
    if (userId) build(header, userId);
  };
  new MutationObserver(() => {
    if (!queued) { queued = true; requestAnimationFrame(scan); }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
