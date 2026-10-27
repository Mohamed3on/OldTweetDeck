// One owner for talking to X's web API: bearer auth, ct0 CSRF and the operation registry
// (name → query id + features). Loaded in the TweetDeck page (injection.js, ahead of
// interception) and on x.com (manifest content script). fetch callers say
// XApi.gql(op, vars) / XApi.get(path) / XApi.rest(path, body); interception's XHR proxy,
// which rewrites TweetDeck's own requests, builds them with XApi.url / XApi.body / XApi.headers.
window.XApi = (() => {
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  // Feature flag sets, each mirroring what x.com sends for that endpoint.
  const F = {
    // HomeLatestTimeline, UserTweetsAndReplies, SearchTimeline: populates grok_translated_post_with_availability.
    timeline: {"rweb_video_screen_enabled":false,"rweb_cashtags_enabled":true,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"rweb_cashtags_composer_attachment_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"rweb_conversational_replies_downvote_enabled":false,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":true,"responsive_web_enhance_cards_enabled":false},
    tweetDetail: {"rweb_lists_timeline_redesign_enabled":false,"blue_business_profile_image_shape_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"tweetypie_unmention_optimization_enabled":true,"vibe_api_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":false,"interactive_text_enabled":true,"responsive_web_text_conversations_enabled":false,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_enhance_cards_enabled":false},
    user: {"hidden_profile_subscriptions_enabled":true,"payments_enabled":false,"rweb_xchat_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"subscriptions_verification_info_is_identity_verified_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_twitter_article_notes_tab_enabled":true,"subscriptions_feature_can_gift_premium":true,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true},
    list: {"rweb_video_screen_enabled":false,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_grok_analysis_button_from_backend":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":false,"responsive_web_enhance_cards_enabled":false},
    bookmarks: {"graphql_timeline_v2_bookmark_timeline":true,"blue_business_profile_image_shape_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"tweetypie_unmention_optimization_enabled":true,"vibe_api_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":false,"interactive_text_enabled":true,"responsive_web_text_conversations_enabled":false,"longform_notetweets_rich_text_read_enabled":true,"responsive_web_enhance_cards_enabled":false},
    likes: {"dont_mention_me_view_api_enabled":true,"interactive_text_enabled":true,"responsive_web_uc_gql_enabled":false,"vibe_tweet_context_enabled":false,"responsive_web_edit_tweet_api_enabled":false,"standardized_nudges_misinfo":false,"responsive_web_enhance_cards_enabled":false},
    peopleSearch: {"rweb_lists_timeline_redesign_enabled":false,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"tweetypie_unmention_optimization_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":false,"tweet_awards_web_tipping_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_media_download_video_enabled":false,"responsive_web_enhance_cards_enabled":false},
    createTweet: {"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"tweetypie_unmention_optimization_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"articles_preview_enabled":true,"rweb_video_timestamps_enabled":true,"rweb_tipjar_consumption_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_enhance_cards_enabled":false},
    profile: {"rweb_video_screen_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_enhance_cards_enabled":false,"hidden_profile_likes_enabled":true,"verified_phone_label_enabled":false,"responsive_web_twitter_article_notes_tab_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"subscriptions_verification_info_is_identity_verified_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"hidden_profile_subscriptions_enabled":true,"responsive_web_grok_analysis_button_from_backend":true,"tweet_awards_web_tipping_enabled":false,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_jetfuel_frame":true,"rweb_tipjar_consumption_enabled":false,"responsive_web_grok_community_note_auto_translation_is_enabled":false,"premium_content_api_read_enabled":false,"responsive_web_profile_redirect_enabled":false,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"post_ctas_fetch_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_media_download_video_enabled":false,"tweetypie_unmention_optimization_enabled":true,"rweb_video_timestamps_enabled":true},
    quote: {"creator_subscriptions_tweet_preview_api_enabled":true,"tweetypie_unmention_optimization_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_enhance_cards_enabled":false,"rweb_video_timestamps_enabled":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"creator_subscriptions_quote_tweet_preview_enabled":false,"rweb_tipjar_consumption_enabled":true,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"articles_preview_enabled":true},
  };

  // GraphQL operations. `name` overrides the URL's operation name when two entries share one;
  // mutations without `features` send none.
  const OPS = {
    HomeLatestTimeline: { qid: 'n2m8OTpLdsM3Zhv33ljKoA', features: F.timeline, method: 'POST' },
    ListLatestTweetsTimeline: { qid: 'l411pL-GRg-AKo_a2rmYjg', features: F.list },
    UserTweetsAndReplies: { qid: 'Yhdsu6wWbof5lwXjYqxXEg', features: F.timeline },
    Bookmarks: { qid: '3OjEFzT2VjX-X7w4KYBJRg', features: F.bookmarks },
    Likes: { qid: 'vni8vUvtZvJoIsl49VPudg', features: F.likes },
    SearchTimeline: { qid: '099UqLkXma7fhT81Jv4n9g', features: F.timeline },
    // User search still runs on an older SearchTimeline query id with its own flags.
    PeopleSearch: { qid: 'nK1dw4oV3k4w5TdtcAdSww', name: 'SearchTimeline', features: F.peopleSearch },
    TweetDetail: { qid: 'KwGBbJZc6DBx8EKmyQSP7g', features: F.tweetDetail },
    TweetResultByRestId: { qid: '0hWvDhmW8YQ-S_ib3azIrw', features: F.quote },
    UserByScreenName: { qid: '2qvSHpkWTMS9i0zJAwDNiA', features: F.user },
    FollowersYouKnow: { qid: '85KIcL0KntSKE-fEbKEV3w', features: F.profile },
    ListOwnerships: { qid: 'BBLgNbbUu6HXAX11lV_1Qw', features: F.profile },
    ListAddMember: { qid: 'vWPi0CTMoPFsjsL6W4IynQ', features: {}, method: 'POST' },
    ListRemoveMember: { qid: 'cAGvZIu7SW0YlLYynz3VYA', features: {}, method: 'POST' },
    CreateTweet: { qid: 'oB-5XsHNAbjvARJEc8CZFw', features: F.createTweet, method: 'POST' },
    DeleteTweet: { qid: 'VaenaVgh5q5ih7kvyVjgtg', method: 'POST' },
    CreateRetweet: { qid: 'ojPdsZsimiJrUGLR1sjUtA', method: 'POST' },
    DeleteRetweet: { qid: 'iQtK4dl5hBmXewYZuEOKVw', method: 'POST' },
    FavoriteTweet: { qid: 'lI07N6Otwv1PhnEgXILM7A', method: 'POST' },
    CreateBookmark: { qid: 'aoDbu3RHznuiSkQ9aNM67Q', method: 'POST' },
    UnfavoriteTweet: { qid: 'ZYKSe-w7KEslx3JhSIk5LA', method: 'POST' },
  };

  const csrf = () => document.cookie.match(/ct0=([^;]+)/)?.[1] || '';
  const headers = (lang = 'en') => ({
    'authorization': `Bearer ${BEARER}`, 'content-type': 'application/json',
    'x-csrf-token': csrf(), 'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-client-language': lang,
  });

  // GET ops carry variables/features in the query string; POST ops go bare, see body().
  const url = (op, variables, fieldToggles) => {
    const { qid, name = op, features = {}, method } = OPS[op];
    const u = new URL(`${location.origin}/i/api/graphql/${qid}/${name}`);
    if (method !== 'POST') {
      u.searchParams.set('variables', JSON.stringify(variables));
      u.searchParams.set('features', JSON.stringify(features));
      if (fieldToggles) u.searchParams.set('fieldToggles', JSON.stringify(fieldToggles));
    }
    return u.href;
  };
  const body = (op, variables) => {
    const { qid, features } = OPS[op];
    return JSON.stringify(features ? { variables, features, queryId: qid } : { variables, queryId: qid });
  };

  // Signed with the x-client-transaction-id challenge whenever the solver is loaded (the
  // TweetDeck page), like interception's XHR proxy; x.com profile pages go without.
  const request = async (href, { method = 'GET', data, type } = {}) => {
    const h = headers();
    if (type) h['content-type'] = type;
    if (localStorage.device_id) h['x-client-uuid'] = localStorage.device_id;
    if (window.solveChallenge) {
      try { h['x-client-transaction-id'] = await solveChallenge(new URL(href).pathname, method); } catch {}
    }
    return fetch(href, { method, headers: h, body: data, credentials: 'include' });
  };
  // '/1.1/…' paths go to x.com's /i/api; full URLs (api.x.com) pass through.
  const api = (path) => path.startsWith('https://') ? path : `${location.origin}/i/api${path}`;

  // All resolve to the fetch Response.
  const gql = (op, variables, fieldToggles) => OPS[op].method === 'POST'
    ? request(url(op), { method: 'POST', data: body(op, variables) })
    : request(url(op, variables, fieldToggles));
  const get = (path) => request(api(path));
  // Legacy v1.1 form-encoded POST, e.g. rest('/1.1/mutes/users/create.json', { user_id }).
  const rest = (path, params) => request(api(path), {
    method: 'POST', data: new URLSearchParams(params).toString(),
    type: 'application/x-www-form-urlencoded; charset=UTF-8',
  });

  // x-rate-limit-* off a Response or an XHR: { remaining, reset (ms epoch), limit }, or null if absent.
  const rateLimit = (r) => {
    const h = (k) => r.headers ? r.headers.get(k) : r.getResponseHeader(k);
    const remaining = h('x-rate-limit-remaining');
    if (remaining == null || remaining === '') return null;
    return {
      remaining: parseInt(remaining),
      reset: (parseInt(h('x-rate-limit-reset')) || 0) * 1000,
      limit: parseInt(h('x-rate-limit-limit')) || null,
    };
  };

  return { gql, get, rest, url, body, headers, rateLimit };
})();
