// x.com profile pages: chips for the lists of yours this account is in (× removes), plus an
// "Add to list" picker — the same row xlr.js puts in TweetDeck's profile popup.
(() => {
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const QID = {
    LIST_OWNERSHIPS: 'BBLgNbbUu6HXAX11lV_1Qw',
    LIST_ADD_MEMBER: 'vWPi0CTMoPFsjsL6W4IynQ',
    LIST_REMOVE_MEMBER: 'cAGvZIu7SW0YlLYynz3VYA',
  };

  const myId = () => document.cookie.match(/twid=u%3D(\d+)/)?.[1];
  const hdrs = () => ({
    'authorization': `Bearer ${BEARER}`, 'content-type': 'application/json',
    'x-csrf-token': document.cookie.match(/ct0=([^;]+)/)?.[1] || '', 'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-client-language': 'en',
  });
  const gqlUrl = (qid, op) => `${location.origin}/i/api/graphql/${qid}/${op}`;

  // One call returns every list you own, its size, and whether this account is in it.
  async function fetchLists(userId) {
    const url = new URL(gqlUrl(QID.LIST_OWNERSHIPS, 'ListOwnerships'));
    url.searchParams.set('variables', JSON.stringify({
      userId: myId(), isListMemberTargetUserId: userId, count: 100, includePromotedContent: false,
    }));
    url.searchParams.set('features', '{}');
    const data = await (await fetch(url, { headers: hdrs(), credentials: 'include' })).json();
    const lists = [];
    for (const inst of data?.data?.user?.result?.timeline?.timeline?.instructions || []) {
      for (const entry of inst.entries || []) {
        const l = entry?.content?.itemContent?.list;
        if (l) lists.push({ id: l.id_str, name: l.name, size: l.member_count, member: !!l.is_member });
      }
    }
    // Biggest lists first, like the TweetDeck picker.
    return lists.sort((a, b) => b.size - a.size);
  }

  const setMember = async (list, userId, member) => {
    const [qid, op] = member ? [QID.LIST_ADD_MEMBER, 'ListAddMember'] : [QID.LIST_REMOVE_MEMBER, 'ListRemoveMember'];
    const r = await fetch(gqlUrl(qid, op), {
      method: 'POST', headers: hdrs(), credentials: 'include',
      body: JSON.stringify({ variables: { listId: list.id, userId }, features: {}, queryId: qid }),
    });
    if (r.ok) list.member = member;
    return r.ok;
  };

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

  function showPicker(btn, lists, userId, onChange) {
    popover.replaceChildren(...lists.map(list => {
      const item = document.createElement('button');
      item.className = 'xp-item';
      item.textContent = list.name;
      const sync = () => item.classList.toggle('xp-on', list.member);
      sync();
      item.onclick = busy(item, async () => {
        if (await setMember(list, userId, !list.member)) { sync(); onChange(); }
      });
      return item;
    }));
    const rect = btn.getBoundingClientRect();
    popover.style.background = getComputedStyle(document.body).backgroundColor;
    popover.style.left = rect.left + 'px';
    popover.style.top = rect.bottom + 6 + 'px';
    popover.showPopover();
  }

  const cache = new Map();

  function build(header, userId) {
    const row = document.createElement('div');
    row.className = 'xp-lists xp-loading';
    row.dataset.userId = userId;
    header.appendChild(row);

    let lists = [];
    const addBtn = document.createElement('button');
    addBtn.className = 'xp-add';
    addBtn.textContent = '+ Add to list';
    // Clicking the button while the picker is open should just close it (light dismiss already did).
    addBtn.onmousedown = () => { addBtn._wasOpen = popover.matches(':popover-open'); };
    addBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!addBtn._wasOpen) showPicker(addBtn, lists, userId, render);
    };

    // Chips are kept by list id and only the changed ones touched, so an added chip animates in
    // (@starting-style) and a removed one fades out, without the rest re-animating.
    const chips = new Map();
    row.appendChild(addBtn);
    function render() {
      let next = addBtn;
      for (const list of [...lists].reverse()) {
        let chip = chips.get(list.id);
        if (list.member && !chip) {
          chip = document.createElement('span');
          chip.className = 'xp-chip';
          chip.textContent = list.name;
          const x = document.createElement('button');
          x.className = 'xp-chip-x';
          x.textContent = '×';
          x.title = `Remove from ${list.name}`;
          x.onclick = busy(chip, async () => { if (await setMember(list, userId, false)) render(); });
          chip.appendChild(x);
          chips.set(list.id, chip);
          row.insertBefore(chip, next);
        } else if (!list.member && chip) {
          chips.delete(list.id);
          chip.classList.add('xp-leaving');
          chip.addEventListener('transitionend', () => chip.remove(), { once: true });
        }
        if (list.member) next = chip;
      }
    }

    // Cached per page load (toggles patch the same objects), so React re-mounting the header
    // or flipping back to a profile doesn't refetch.
    if (!cache.has(userId)) cache.set(userId, fetchLists(userId));
    cache.get(userId).then(ls => {
      lists = ls;
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
