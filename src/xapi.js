// One owner for talking to X's web API: bearer auth, ct0 CSRF and the operation registry
// (name → query id + features). Loaded in the TweetDeck page (injection.js) and on x.com
// (manifest content script), so callers say XApi.gql(op, variables) / XApi.rest(path, body)
// and never hold a token, cookie regex or query id of their own.
window.XApi = (() => {
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const OPS = {
    ListOwnerships: { qid: 'BBLgNbbUu6HXAX11lV_1Qw' },
    ListAddMember: { qid: 'vWPi0CTMoPFsjsL6W4IynQ', method: 'POST' },
    ListRemoveMember: { qid: 'cAGvZIu7SW0YlLYynz3VYA', method: 'POST' },
  };

  const csrf = () => document.cookie.match(/ct0=([^;]+)/)?.[1] || '';
  const headers = () => ({
    'authorization': `Bearer ${BEARER}`, 'content-type': 'application/json',
    'x-csrf-token': csrf(), 'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-client-language': 'en',
  });

  // Resolves to the fetch Response: GET ops carry variables/features in the query string,
  // POST ops (mutations) in the JSON body.
  const gql = (op, variables) => {
    const { qid, features = {}, method = 'GET' } = OPS[op];
    const url = new URL(`${location.origin}/i/api/graphql/${qid}/${op}`);
    if (method === 'POST') {
      return fetch(url, {
        method, headers: headers(), credentials: 'include',
        body: JSON.stringify({ variables, features, queryId: qid }),
      });
    }
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', JSON.stringify(features));
    return fetch(url, { headers: headers(), credentials: 'include' });
  };

  // Legacy v1.1 form-encoded POST, e.g. rest('/1.1/mutes/users/create.json', { user_id }).
  const rest = (path, body) =>
    fetch(`${location.origin}/i/api${path}`, {
      method: 'POST', credentials: 'include',
      headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams(body).toString(),
    });

  return { gql, rest };
})();
