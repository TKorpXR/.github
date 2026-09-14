'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reconcile = require('../scripts/reconcile-pulse-issues');
const {
  createCore,
  createGithub,
  graphqlRateLimitError,
  projectPage,
} = require('./helpers/fakes');

const { ROUTES, REPOSITORIES, STATUS_FIELD_ID, ENTITY_FIELD_ID, QUALIFY_STATUS_ID } =
  reconcile.constants;
const NOW = Date.parse('2026-09-14T12:00:00Z');

function projectItem(id, contentId, values) {
  return {
    id,
    content: { id: contentId },
    fieldValues: {
      nodes: Object.entries(values).map(([fieldId, optionId]) => ({
        optionId,
        field: { id: fieldId },
      })),
    },
  };
}

function issue(number, fields = {}) {
  return {
    number,
    node_id: `ISSUE_${number}`,
    html_url: `https://github.com/TKorpXR/pulse-web-interface/issues/${number}`,
    body: '',
    ...fields,
  };
}

/** Faux GitHub : `issuesByRepo` alimente `paginate`, `items` le projet. */
function fakeGithub({ issuesByRepo = {}, items = [], onMutation } = {}) {
  return createGithub({
    graphql: [
      ['items(first: 100', () => projectPage(items)],
      [
        'mutation',
        (variables, query) => {
          if (onMutation) return onMutation(variables, query);
          if (query.includes('addProjectV2ItemById')) {
            return { addProjectV2ItemById: { item: { id: `NEW_${variables.contentId}` } } };
          }
          return { ok: true };
        },
      ],
    ],
    paginate: ({ repo }) => issuesByRepo[repo] ?? [],
  });
}

test('extractProduct lit le champ du formulaire de ticket', () => {
  assert.equal(
    reconcile.extractProduct('### Produit concerné\n\nMDM Android\n\n### Description\n...'),
    'MDM Android',
  );
  assert.equal(reconcile.extractProduct('### Produit concerné\r\n\r\nWeb\r\n'), 'Web');
  assert.equal(reconcile.extractProduct('pas de formulaire'), undefined);
  assert.equal(reconcile.extractProduct(null), undefined);
});

test('resolveRoute prefere le produit declare au depot d origine', () => {
  assert.equal(
    reconcile.resolveRoute('pulse-web-interface', '### Produit concerné\n\nDesktop').repository,
    'pulse-desktop',
  );
  assert.equal(reconcile.resolveRoute('pulse-web-interface', '').repository, 'pulse-web-interface');
  assert.equal(reconcile.resolveRoute('.github', ''), null);
  assert.equal(reconcile.resolveRoute('.github', '### Produit concerné\n\nInconnu'), null);
});

test('planIssue : un ticket en regle ne demande rien', () => {
  const existingItem = {
    id: 'I1',
    values: new Map([
      [STATUS_FIELD_ID, 'f75ad846'],
      [ENTITY_FIELD_ID, ROUTES.Web.entityOptionId],
    ]),
  };
  const plan = reconcile.planIssue({
    repository: 'pulse-web-interface',
    route: ROUTES.Web,
    existingItem,
  });
  assert.equal(plan.upToDate, true);
});

test("planIssue : un statut deja pose n'est jamais reecrit, seule l'entite manquante l'est", () => {
  const existingItem = { id: 'I1', values: new Map([[STATUS_FIELD_ID, 'd6a4195b']]) };
  const plan = reconcile.planIssue({
    repository: 'pulse-web-interface',
    route: ROUTES.Web,
    existingItem,
  });
  assert.deepEqual(
    { ...plan },
    {
      needsTransfer: false,
      needsProject: false,
      needsEntity: true,
      needsStatus: false,
      upToDate: false,
    },
  );
});

test('planIssue : ticket hors projet dans le mauvais depot', () => {
  const plan = reconcile.planIssue({
    repository: 'pulse-web-interface',
    route: ROUTES.Desktop,
    existingItem: undefined,
  });
  assert.equal(plan.needsTransfer, true);
  assert.equal(plan.needsProject, true);
  assert.equal(plan.needsStatus, true);
});

test('run ne lit que les tickets ouverts, sur tous les depots, dans la fenetre demandee', async () => {
  const github = fakeGithub();
  const core = createCore();

  await reconcile({
    github,
    core,
    env: { RECONCILE_MODE: 'dry-run', LOOKBACK_DAYS: '14' },
    now: NOW,
  });

  assert.deepEqual(
    github.calls.paginate.map(({ params }) => params.repo),
    REPOSITORIES,
  );
  for (const { params } of github.calls.paginate) {
    assert.equal(params.state, 'open');
    assert.equal(params.since, '2026-08-31T12:00:00.000Z');
  }
  assert.equal(core.calls.failed.length, 0);
});

test('run en dry-run liste sans ecrire, et ignore les PR', async () => {
  const github = fakeGithub({
    issuesByRepo: {
      'pulse-web-interface': [
        issue(1),
        issue(2, { pull_request: { url: 'x' } }),
        issue(3, { body: '### Produit concerné\n\nProduit fantaisie' }),
      ],
    },
  });
  const core = createCore();

  const { results } = await reconcile({
    github,
    core,
    env: { RECONCILE_MODE: 'dry-run', LOOKBACK_DAYS: '14' },
    now: NOW,
  });

  assert.deepEqual(
    results.map(({ result, source }) => [result, source.split('/').pop()]),
    [
      ['Prévisualisation', '1'],
      ['Ignoré: produit absent ou inconnu', '3'],
    ],
  );
  assert.equal(
    github.calls.graphql.filter(({ query }) => query.includes('mutation')).length,
    0,
  );
});

test('run en execute ajoute un ticket absent, en « a classifier », avec son entite', async () => {
  const mutations = [];
  const github = fakeGithub({
    issuesByRepo: { 'pulse-web-interface': [issue(5)] },
    onMutation: (variables, query) => {
      if (query.includes('addProjectV2ItemById')) {
        mutations.push({ add: variables.contentId });
        return { addProjectV2ItemById: { item: { id: 'NEW_5' } } };
      }
      mutations.push({ fieldId: variables.fieldId, optionId: variables.optionId });
      return { ok: true };
    },
  });
  const core = createCore();

  await reconcile({
    github,
    core,
    env: { RECONCILE_MODE: 'execute', LOOKBACK_DAYS: '14' },
    now: NOW,
  });

  assert.deepEqual(mutations, [
    { add: 'ISSUE_5' },
    { fieldId: STATUS_FIELD_ID, optionId: QUALIFY_STATUS_ID },
    { fieldId: ENTITY_FIELD_ID, optionId: ROUTES.Web.entityOptionId },
  ]);
  assert.equal(core.calls.failed.length, 0);
});

test('parametres invalides : echec explicite, aucun appel', async () => {
  for (const env of [
    { RECONCILE_MODE: 'yolo', LOOKBACK_DAYS: '14' },
    { RECONCILE_MODE: 'dry-run', LOOKBACK_DAYS: '0' },
    { RECONCILE_MODE: 'dry-run', LOOKBACK_DAYS: 'abc' },
  ]) {
    const github = fakeGithub();
    const core = createCore();
    await reconcile({ github, core, env, now: NOW });
    assert.equal(core.calls.failed.length, 1);
    assert.equal(github.calls.graphql.length + github.calls.paginate.length, 0);
  }
});

test('incident du 14/09 : limite atteinte au chargement du projet, run non echoue', async () => {
  const github = createGithub({
    graphql: [
      [
        'items(first: 100',
        () => {
          throw graphqlRateLimitError();
        },
      ],
    ],
  });
  const core = createCore();

  const result = await reconcile({
    github,
    core,
    env: { RECONCILE_MODE: 'execute', LOOKBACK_DAYS: '14' },
    now: NOW,
  });

  assert.deepEqual(result, { rateLimited: true });
  assert.equal(core.calls.failed.length, 0);
  assert.equal(core.calls.warnings.length, 1);
});

test('une limite REST pendant la lecture des tickets interrompt le passage sans echec', async () => {
  const github = createGithub({
    graphql: [['items(first: 100', () => projectPage([])]],
    paginate: () => {
      throw Object.assign(new Error('You have exceeded a secondary rate limit.'), {
        status: 403,
        response: { headers: {} },
      });
    },
  });
  const core = createCore();

  const result = await reconcile({
    github,
    core,
    env: { RECONCILE_MODE: 'execute', LOOKBACK_DAYS: '14' },
    now: NOW,
  });

  assert.deepEqual(result, { rateLimited: true });
  assert.equal(github.calls.paginate.length, 1);
  assert.equal(core.calls.failed.length, 0);
});

test('une limite sur un ticket arrete le passage au lieu de faire echouer chaque ticket suivant', async () => {
  let attempts = 0;
  const github = fakeGithub({
    issuesByRepo: { 'pulse-web-interface': [issue(1), issue(2), issue(3)] },
    onMutation: () => {
      attempts += 1;
      throw graphqlRateLimitError();
    },
  });
  const core = createCore();

  const result = await reconcile({
    github,
    core,
    env: { RECONCILE_MODE: 'execute', LOOKBACK_DAYS: '14' },
    now: NOW,
  });

  assert.deepEqual(result, { rateLimited: true });
  assert.equal(attempts, 1);
  assert.equal(core.calls.errors.length, 0);
  assert.equal(core.calls.failed.length, 0);
});

test("une vraie erreur sur un ticket reste un echec, sans bloquer les tickets suivants", async () => {
  const touched = [];
  const github = fakeGithub({
    issuesByRepo: { 'pulse-web-interface': [issue(1), issue(2)] },
    onMutation: (variables, query) => {
      if (query.includes('addProjectV2ItemById')) {
        touched.push(variables.contentId);
        if (variables.contentId === 'ISSUE_1') throw new Error('Could not resolve to a node');
        return { addProjectV2ItemById: { item: { id: `NEW_${variables.contentId}` } } };
      }
      return { ok: true };
    },
  });
  const core = createCore();

  const { errors } = await reconcile({
    github,
    core,
    env: { RECONCILE_MODE: 'execute', LOOKBACK_DAYS: '14' },
    now: NOW,
  });

  assert.deepEqual(touched, ['ISSUE_1', 'ISSUE_2']);
  assert.equal(errors.length, 1);
  assert.deepEqual(core.calls.failed, ['1 ticket(s) en erreur.']);
});
