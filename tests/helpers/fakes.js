'use strict';

/**
 * Doublures des objets que `actions/github-script` injecte dans un script.
 * Aucune dependance : le banc d'essai tourne avec le seul `node --test`.
 */

/** `core` : enregistre avertissements, erreurs, echec et resume. */
function createCore() {
  const calls = { warnings: [], errors: [], failed: [], summary: [] };
  const summary = {
    addHeading(text) {
      calls.summary.push({ heading: text });
      return summary;
    },
    addRaw(text) {
      calls.summary.push({ raw: text });
      return summary;
    },
    addTable(rows) {
      calls.summary.push({ table: rows });
      return summary;
    },
    async write() {
      calls.summary.push({ written: true });
      return summary;
    },
  };
  return {
    calls,
    summary,
    warning: (message) => calls.warnings.push(message),
    error: (message) => calls.errors.push(message),
    setFailed: (message) => calls.failed.push(message),
  };
}

/**
 * `github` : chaque appel GraphQL est aiguille vers le premier gestionnaire
 * dont le motif apparait dans la requete. Un appel non prevu fait echouer le
 * test, pour qu'aucun appel reseau ne passe inapercu.
 */
function createGithub({ graphql = [], paginate } = {}) {
  const calls = { graphql: [], paginate: [] };
  return {
    calls,
    rest: { issues: { listForRepo: 'issues.listForRepo' } },
    async graphql(query, variables) {
      calls.graphql.push({ query, variables });
      const handler = graphql.find(([pattern]) => query.includes(pattern));
      if (!handler) throw new Error(`Appel GraphQL non prevu:\n${query}`);
      return handler[1](variables, query);
    },
    async paginate(route, params) {
      calls.paginate.push({ route, params });
      if (!paginate) throw new Error('Appel paginate non prevu');
      return paginate(params, route);
    },
  };
}

/** Erreur telle qu'observee le 14/09/2026 sur les deux workflows. */
function graphqlRateLimitError() {
  const error = new Error(
    'Request failed due to following response errors:\n' +
      ' - API rate limit already exceeded for user ID 143822842.',
  );
  error.name = 'GraphqlResponseError';
  error.errors = [
    {
      type: 'RATE_LIMIT',
      code: 'graphql_rate_limit',
      message: 'API rate limit already exceeded for user ID 143822842.',
    },
  ];
  return error;
}

/** Page de projet au format de `node(id:) { ... on ProjectV2 { items } }`. */
function projectPage(nodes) {
  return {
    node: {
      items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

module.exports = { createCore, createGithub, graphqlRateLimitError, projectPage };
