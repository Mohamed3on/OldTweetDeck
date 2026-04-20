(() => {
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const QID = {
    USER_BY_SCREEN_NAME: 'NimuplG1OB7Fd2btCLdBOw',
    LIST_OWNERSHIPS: 'BBLgNbbUu6HXAX11lV_1Qw',
    LIST_ADD_MEMBER: 'vWPi0CTMoPFsjsL6W4IynQ',
    LIST_REMOVE_MEMBER: 'cAGvZIu7SW0YlLYynz3VYA',
  };
  const FEATURES = {
    rweb_video_screen_enabled: false, profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true, communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true, articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true, longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true, responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_grok_share_attachment_enabled: true, responsive_web_grok_annotations_enabled: true,
    responsive_web_grok_image_annotation_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false, hidden_profile_likes_enabled: true, verified_phone_label_enabled: false,
    responsive_web_twitter_article_notes_tab_enabled: true, subscriptions_verification_info_verified_since_enabled: true,
    subscriptions_verification_info_is_identity_verified_enabled: true, highlights_tweets_tab_ui_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true, hidden_profile_subscriptions_enabled: true,
    responsive_web_grok_analysis_button_from_backend: true, tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false, responsive_web_jetfuel_frame: true,
    rweb_tipjar_consumption_enabled: false, responsive_web_grok_community_note_auto_translation_is_enabled: false,
    premium_content_api_read_enabled: false, responsive_web_profile_redirect_enabled: false,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false, post_ctas_fetch_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true, responsive_web_media_download_video_enabled: false,
    tweetypie_unmention_optimization_enabled: true, rweb_video_timestamps_enabled: true,
  };

  const csrf = () => document.cookie.match(/ct0=([^;]+)/)?.[1] || '';
  const myId = () => document.cookie.match(/twid=u%3D(\d+)/)?.[1];
  const hdrs = () => ({
    'authorization': `Bearer ${BEARER}`, 'content-type': 'application/json',
    'x-csrf-token': csrf(), 'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-client-language': 'en',
  });

  const gql = async (qid, op, variables) => {
    const url = new URL(`${location.origin}/i/api/graphql/${qid}/${op}`);
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', JSON.stringify(FEATURES));
    return (await fetch(url, { headers: hdrs(), credentials: 'include' })).json();
  };

  const gqlPost = (qid, op, variables) =>
    fetch(`${location.origin}/i/api/graphql/${qid}/${op}`, {
      method: 'POST', headers: hdrs(), credentials: 'include',
      body: JSON.stringify({ variables, features: FEATURES, queryId: qid }),
    });

  let lists = null, listsByName = null;
  const buildByName = (ls) => Object.fromEntries(ls.map(l => [l.name.toLowerCase(), l.id]));

  const LIST_CACHE_TTL = 1000 * 60 * 60 * 24;
  let userIds = {};

  const listsReady = (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem('xlrLists_v2'));
      if (cached && Date.now() - cached.ts < LIST_CACHE_TTL) {
        lists = cached.lists;
        listsByName = buildByName(lists);
        return;
      }
    } catch {}
    const res = await fetch(
      `https://api.${location.hostname}/1.1/lists/ownerships.json?count=1000`,
      { headers: hdrs(), credentials: 'include' },
    );
    const data = await res.json();
    lists = (data.lists || []).map(l => ({ name: l.name, id: l.id_str }));
    listsByName = buildByName(lists);
    if (lists.length) localStorage.setItem('xlrLists_v2', JSON.stringify({ lists, ts: Date.now() }));
  })();

  try { userIds = JSON.parse(localStorage.getItem('xlrUserIds')) || {}; } catch {}
  const persistUserIds = () => localStorage.setItem('xlrUserIds', JSON.stringify(userIds));

  const userIdInflight = {};
  const resolveUser = async (name) => {
    if (userIds[name]) return userIds[name];
    if (userIdInflight[name]) return userIdInflight[name];
    userIdInflight[name] = (async () => {
      try {
        const d = await gql(QID.USER_BY_SCREEN_NAME, 'UserByScreenName', { screen_name: name });
        const id = d?.data?.user?.result?.rest_id;
        if (id) { userIds[name] = id; persistUserIds(); }
        return id;
      } finally {
        delete userIdInflight[name];
      }
    })();
    return userIdInflight[name];
  };

  const membershipCache = {};
  const membershipInflight = {};

  async function fetchMembership(username) {
    if (membershipCache[username]) return membershipCache[username];
    if (membershipInflight[username]) return membershipInflight[username];
    membershipInflight[username] = (async () => {
      try {
        const userId = await resolveUser(username);
        if (!userId) return new Set();
        const data = await gql(QID.LIST_OWNERSHIPS, 'ListOwnerships', {
          userId: myId(), isListMemberTargetUserId: userId, count: 100, includePromotedContent: false,
        });
        const memberOf = new Set();
        for (const inst of data?.data?.user?.result?.timeline?.timeline?.instructions || []) {
          if (inst.type !== 'TimelineAddEntries') continue;
          for (const entry of inst.entries) {
            const l = entry?.content?.itemContent?.list;
            if (l?.is_member) memberOf.add(l.id_str || l.rest_id);
          }
        }
        return (membershipCache[username] = memberOf);
      } finally {
        delete membershipInflight[username];
      }
    })();
    return membershipInflight[username];
  }

  const updateMembership = (username, listId, added) => {
    const cache = membershipCache[username];
    if (cache) added ? cache.add(listId) : cache.delete(listId);
  };

  const EDIT_BOX = '.column-title-edit-box';
  const AT_RE = /(?:^|\s)@(\S+)/;
  const FROM_RE = /from:(\S+)/;
  const FROM_TOKEN_RE = /from:\S+\s*/;

  const setFilterInput = (input, newValue) => {
    if (newValue === input.value) return;
    $(input).val(newValue).trigger('uiInputSubmit');
  };

  const getUsername = (article) => {
    const link = article.querySelector('.account-summary .account-link, .tweet-header .account-link');
    return link?.getAttribute('href')?.match(/\/([^/]+)$/)?.[1] || null;
  };

  function getListId(col) {
    if (!col) return null;
    if (col.querySelector('.column-type-icon.icon-list')) {
      const heading = col.querySelector('.column-heading');
      if (heading) return listsByName?.[heading.textContent.trim().toLowerCase()] || null;
    }
    return col.querySelector(EDIT_BOX)?.value?.match(/list:(\d+)/)?.[1] || null;
  }

  const mkSvg = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18');
    svg.setAttribute('height', '18'); svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); svg.appendChild(path); return svg;
  };
  const removeSvg = mkSvg('M10 4c-1.105 0-2 .9-2 2s.895 2 2 2 2-.9 2-2-.895-2-2-2zM6 6c0-2.21 1.791-4 4-4s4 1.79 4 4-1.791 4-4 4-4-1.79-4-4zm13 4v3h-2v-3h-3V8h3V5h2v3h3v2h-3zM3.651 19.113C4.414 16.742 7.005 15 10 15c.395 0 .783.028 1.162.082l-1.67 1.67c-.55.549-.95 1.238-1.142 1.999L4 18.752V19h5.275l.622 2H4c-.553 0-1.163-.448-1.261-.996-.066-.372-.002-.594.26-1.075l.652-.816zm13.627-1.835l1.414-1.414 1.591 1.591 1.591-1.591 1.414 1.414-1.591 1.591 1.591 1.591-1.414 1.414-1.591-1.591-1.591 1.591-1.414-1.414 1.591-1.591-1.591-1.591z');
  const checkSvg = mkSvg('M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z');
  const addListSvg = mkSvg('M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z');
  const muteSvg = mkSvg('M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z');
  const filterSvg = mkSvg('M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.824 5.262l4.781 4.781-1.414 1.414-4.781-4.781c-1.447 1.142-3.276 1.824-5.262 1.824-4.694 0-8.5-3.806-8.5-8.5z');
  const userSearchSvg = mkSvg('M17.863 13.44c1.477 1.58 2.366 3.8 2.632 6.46l.11 1.1H3.395l.11-1.1c.266-2.66 1.155-4.88 2.632-6.46C7.627 11.85 9.648 11 12 11s4.373.85 5.863 2.44zM5.887 19h12.226c-.283-1.737-.944-3.06-1.928-4.11C14.965 13.73 13.615 13 12 13s-2.965.73-4.185 1.89c-.984 1.05-1.645 2.373-1.928 4.11zM12 4c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0-2C9.24 2 7 4.24 7 7s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5z');

  const mkBtn = (cls, title, svg) => {
    const btn = document.createElement('button');
    btn.className = cls;
    btn.title = title;
    btn.appendChild(svg.cloneNode(true));
    return btn;
  };

  const withBusy = (btn, cls, fn) => async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (btn.classList.contains(cls)) return;
    btn.classList.add(cls);
    try { await fn(); } finally { btn.classList.remove(cls); }
  };

  const clearFromFilter = (article) => {
    const input = article.closest('.column-panel')?.querySelector(EDIT_BOX);
    if (input) setFilterInput(input, input.value.replace(FROM_TOKEN_RE, '').trim());
  };

  const markDone = (btn, title, article) => {
    btn.classList.add('xlr-done');
    btn.replaceChildren(checkSvg.cloneNode(true));
    btn.title = title;
    article.style.transition = 'opacity .4s';
    article.style.opacity = '0.3';
    clearFromFilter(article);
  };

  const restPost = (path, body) =>
    fetch(`${location.origin}/i/api${path}`, {
      method: 'POST', credentials: 'include',
      headers: { ...hdrs(), 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams(body).toString(),
    });

  const muteUser = async (username) => {
    const userId = await resolveUser(username);
    if (!userId) return false;
    const r = await restPost('/1.1/mutes/users/create.json', { user_id: userId });
    if (!r.ok) return false;
    const memberOf = await fetchMembership(username);
    await Promise.all([...memberOf].map(listId =>
      gqlPost(QID.LIST_REMOVE_MEMBER, 'ListRemoveMember', { listId, userId })
        .then(r => { if (r.ok) updateMembership(username, listId, false); })
    ));
    return true;
  };

  let popover = document.createElement('div');
  popover.className = 'xlr-popover';
  popover.setAttribute('popover', 'auto');
  document.body.appendChild(popover);

  let popoverAnchor = null;

  function setItemState(item, name, isMember) {
    item.classList.toggle('xlr-dropdown-done', isMember);
    item.textContent = isMember ? `\u2713 ${name}` : name;
  }

  function renderItem(name, id, username) {
    const item = document.createElement('button');
    item.className = 'xlr-dropdown-item';
    item.textContent = name;
    item.onclick = withBusy(item, 'xlr-inflight', async () => {
      const removing = item.classList.contains('xlr-dropdown-done');
      setItemState(item, name, !removing);
      const userId = await resolveUser(username);
      const r = await gqlPost(
        removing ? QID.LIST_REMOVE_MEMBER : QID.LIST_ADD_MEMBER,
        removing ? 'ListRemoveMember' : 'ListAddMember',
        { listId: id, userId },
      );
      if (r.ok) updateMembership(username, id, !removing);
      else setItemState(item, name, removing);
    });
    return item;
  }

  async function showPopover(addBtn, username) {
    if (popoverAnchor === addBtn && popover.matches(':popover-open')) {
      popover.hidePopover();
      return;
    }
    popoverAnchor = addBtn;

    popover.replaceChildren();
    const items = lists.map(({ name, id }) => {
      const item = renderItem(name, id, username);
      popover.appendChild(item);
      return item;
    });

    const rect = addBtn.getBoundingClientRect();
    Object.assign(popover.style, {
      position: 'fixed',
      bottom: (window.innerHeight - rect.top + 4) + 'px',
      right: (window.innerWidth - rect.right) + 'px',
      top: 'auto',
      left: 'auto',
    });
    popover.showPopover();

    const memberOf = await fetchMembership(username);
    items.forEach((item, i) => setItemState(item, lists[i].name, memberOf.has(lists[i].id)));
  }

  const seen = new WeakSet();

  function process(article) {
    if (seen.has(article) || !lists) return;
    seen.add(article);

    const actionBar = article.querySelector('ul.tweet-actions, ul.tweet-detail-actions');
    if (!actionBar) return;
    const username = getUsername(article);
    if (!username) return;

    const col = article.closest('.column-panel');
    const listId = getListId(col);
    if (listId && article.querySelector('.tweet-context .icon-retweet-filled')) {
      article.style.display = 'none';
      return;
    }

    const isDetail = actionBar.classList.contains('tweet-detail-actions');
    const moreItem = actionBar.querySelector('[rel="actionsMenu"]')?.closest('li');
    const appendToBar = (btn) => {
      const li = document.createElement('li');
      li.className = isDetail ? 'tweet-detail-action-item' : 'tweet-action-item pull-left margin-r--10';
      li.appendChild(btn);
      if (moreItem) actionBar.insertBefore(li, moreItem);
      else actionBar.appendChild(li);
    };

    const userLower = username.toLowerCase();

    const userSearchBtn = mkBtn('xlr-user-search-btn', `Search @${username} in user column`, userSearchSvg);
    userSearchBtn.dataset.xlrUsername = userLower;
    userSearchBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      for (const input of document.querySelectorAll(EDIT_BOX)) {
        const val = input.value.trim();
        const m = val.match(AT_RE);
        if (!m) continue;
        if (m[1].toLowerCase() === userLower) return;
        const rest = val.replace(AT_RE, '').trim();
        setFilterInput(input, rest ? `${rest} @${username}` : `@${username}`);
        return;
      }
    };
    appendToBar(userSearchBtn);

    if (listId && col?.querySelector(EDIT_BOX)) {
      const filterBtn = mkBtn('xlr-filter-btn', `Filter by @${username}`, filterSvg);
      filterBtn.dataset.xlrUsername = userLower;
      filterBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        // Re-query: TweetDeck may re-render the header between clicks
        const input = col.querySelector(EDIT_BOX);
        if (!input) return;
        const current = input.value.trim();
        const fromMatch = current.match(FROM_RE);
        let newValue;
        if (fromMatch?.[1].toLowerCase() === userLower) newValue = current.replace(FROM_TOKEN_RE, '').trim();
        else if (fromMatch) newValue = current.replace(FROM_RE, `from:${username}`);
        else newValue = `from:${username} ${current}`;
        setFilterInput(input, newValue);
      };
      appendToBar(filterBtn);
    }

    if (listId) {
      const removeBtn = mkBtn('xlr-remove-btn', 'Remove from list', removeSvg);
      removeBtn.onclick = withBusy(removeBtn, 'xlr-removing', async () => {
        const userId = await resolveUser(username);
        if (!userId) return;
        const r = await gqlPost(QID.LIST_REMOVE_MEMBER, 'ListRemoveMember', { listId, userId });
        if (r.ok) {
          markDone(removeBtn, `Removed @${username}`, article);
          updateMembership(username, listId, false);
        }
      });
      appendToBar(removeBtn);
    } else {
      const addBtn = mkBtn('xlr-add-btn', 'Add to list', addListSvg);
      addBtn.onmouseenter = () => fetchMembership(username);
      addBtn.onmousedown = () => { addBtn._wasOpen = popover.matches(':popover-open'); };
      addBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!addBtn._wasOpen) showPopover(addBtn, username);
      };
      appendToBar(addBtn);
    }

    const muteBtn = mkBtn('xlr-mute-btn', 'Mute & remove from lists', muteSvg);
    muteBtn.onclick = withBusy(muteBtn, 'xlr-removing', async () => {
      const ok = await muteUser(username);
      if (ok) markDone(muteBtn, `Muted @${username}`, article);
    });
    if (moreItem) moreItem.replaceChildren(muteBtn);
    else appendToBar(muteBtn);
  }

  function updateButtonStates() {
    let atUser = null;
    for (const col of document.querySelectorAll('.column-panel')) {
      const val = col.querySelector(EDIT_BOX)?.value;
      if (!val) continue;
      if (atUser == null) atUser = val.trim().match(AT_RE)?.[1].toLowerCase() ?? null;
      const fromUser = val.match(FROM_RE)?.[1].toLowerCase() ?? null;
      for (const btn of col.querySelectorAll('.xlr-filter-btn')) {
        btn.classList.toggle('xlr-active', btn.dataset.xlrUsername === fromUser);
      }
    }
    for (const btn of document.querySelectorAll('.xlr-user-search-btn')) {
      btn.classList.toggle('xlr-active', btn.dataset.xlrUsername === atUser);
    }
  }

  let scanQueued = false;
  const scan = () => {
    document.querySelectorAll('article.stream-item').forEach(process);
    updateButtonStates();
    scanQueued = false;
  };

  const observer = new MutationObserver(() => {
    if (!scanQueued) { scanQueued = true; requestAnimationFrame(scan); }
  });

  document.addEventListener('input', (e) => {
    if (e.target.matches?.(EDIT_BOX)) updateButtonStates();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  listsReady.then(scan);
})();
