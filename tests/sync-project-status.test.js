'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('../scripts/sync-project-status');
const {
  createCore,
  createGithub,
  graphqlRateLimitError,
  projectPage,
} = require('./helpers/fakes');

const { START_AT, REPOSITORIES, EN_COURS, A_FUSIONNER, TO_BUILD } = sync.constants;
const STATUS_FIELD_ID = 'PVTSSF_lADOCnLJI84AkpBozgc0WBA';
const RECENT = new Date(START_AT + 24 * 60 * 60 * 1000).toISOString();
const OLD = new Date(START_AT - 24 * 60 * 60 * 1000).toISOString();

const OPTION = {
  qualifier: '443ad84f',
  aFaire: 'f75ad846',
  enCours: EN_COURS,
  aFusionner: A_FUSIONNER,
  toBuild: TO_BUILD,
  aTester: 'e7841e11',
  testOk: 'b06935b3',
  termine: 'd6a4195b',
  suspendu: 'aed015ee',
  versionUlterieure: '04ee2d3b',
};

function item(id, repository, number, optionId, label = optionId) {
  return {
    id,
    content: { number, repository: { name: repository } },
    fieldValues: {
      nodes: optionId ? [{ optionId, name: label, field: { id: STATUS_FIELD_ID } }] : [],
    },
  };
}

/**
 * Faux GitHub pour un passage complet : `refs` et `prs` ne concernent que
 * pulse-web-interface, les autres depots sont vides.
 */
function fakeGithub({ refs = [], open = [], merged = [], items = [], onMutation } = {}) {
  return createGithub({
    graphql: [
      [
        'refs(',
        ({ name }) => ({
          repository: {
            refs: {
              nodes: name === 'pulse-web-interface' ? refs : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ],
      [
        'pullRequests(',
        ({ name }) => ({
          repository:
            name === 'pulse-web-interface'
              ? { open: { nodes: open }, merged: { nodes: merged } }
              : { open: { nodes: [] }, merged: { nodes: [] } },
        }),
      ],
      ['items(first: 100', () => projectPage(items)],
      [
        'updateProjectV2ItemFieldValue',
        (variables) => (onMutation ? onMutation(variables) : { ok: true }),
      ],
    ],
  });
}

const pr = (number, fields) => ({
  number,
  headRefName: '',
  closingIssuesReferences: { nodes: [] },
  ...fields,
});

test('issueFromBranch exige le prefixe litteral issue', () => {
  assert.equal(sync.issueFromBranch('fix/issue-3234-nom-de-fiche'), 3234);
  assert.equal(sync.issueFromBranch('issue_12'), 12);
  assert.equal(sync.issueFromBranch('feat/ISSUE3000'), 3000);
  assert.equal(sync.issueFromBranch('fix/3173-current-content-freshness'), null);
  assert.equal(sync.issueFromBranch('tissue-42'), null);
  assert.equal(sync.issueFromBranch(undefined), null);
});

test('want retient le signal le plus avance, quel que soit l ordre', () => {
  const { wanted, want } = sync.createWantedTracker();
  want('pulse-web-interface', 1, TO_BUILD, 'fusionnee');
  want('pulse-web-interface', 1, EN_COURS, 'branche');
  want('pulse-web-interface', 1, A_FUSIONNER, 'ouverte');
  assert.equal(wanted.get('pulse-web-interface#1').optionId, TO_BUILD);
});

test('planMoves ne ramene jamais en arriere un ticket deja en recette (#560)', () => {
  const { wanted, want } = sync.createWantedTracker();
  for (const number of [1, 2, 3]) want('pulse-web-interface', number, TO_BUILD, 'fusionnee');

  const projectItems = new Map([
    ['pulse-web-interface#1', { id: 'I1', optionId: OPTION.aTester, label: 'A tester' }],
    ['pulse-web-interface#2', { id: 'I2', optionId: OPTION.testOk, label: 'Test OK' }],
    ['pulse-web-interface#3', { id: 'I3', optionId: OPTION.termine, label: 'Termine' }],
  ]);

  assert.deepEqual(sync.planMoves(wanted, projectItems).moves, []);
});

test('planMoves respecte les mises en attente et compte les absents', () => {
  const { wanted, want } = sync.createWantedTracker();
  want('pulse-web-interface', 1, EN_COURS, 'branche');
  want('pulse-web-interface', 2, TO_BUILD, 'fusionnee');
  want('pulse-web-interface', 3, EN_COURS, 'branche');

  const projectItems = new Map([
    ['pulse-web-interface#1', { id: 'I1', optionId: OPTION.suspendu, label: 'Suspendu' }],
    ['pulse-web-interface#2', { id: 'I2', optionId: OPTION.versionUlterieure, label: 'VU' }],
  ]);

  const plan = sync.planMoves(wanted, projectItems);
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.held, 2);
  assert.equal(plan.absent, 1);
});

test('planMoves avance un ticket sans statut ou en amont', () => {
  const { wanted, want } = sync.createWantedTracker();
  want('pulse-web-interface', 1, EN_COURS, 'branche fix/issue-1');
  want('pulse-web-interface', 2, A_FUSIONNER, 'pulse-web-interface#9 ouverte');

  const projectItems = new Map([
    ['pulse-web-interface#1', { id: 'I1', optionId: null, label: null }],
    ['pulse-web-interface#2', { id: 'I2', optionId: OPTION.aFaire, label: 'A faire' }],
  ]);

  const { moves } = sync.planMoves(wanted, projectItems);
  assert.deepEqual(
    moves.map(({ issue, from, to }) => ({ issue, from, to })),
    [
      { issue: 'pulse-web-interface#1', from: 'sans statut', to: 'En cours' },
      { issue: 'pulse-web-interface#2', from: 'A faire', to: 'A fusionner' },
    ],
  );
});

test('les signaux anterieurs a la mise en service et les brouillons sont ignores', () => {
  const { wanted, want } = sync.createWantedTracker();
  sync.collectBranchSignals(
    'pulse-web-interface',
    [
      { name: 'fix/issue-1-recent', target: { committedDate: RECENT } },
      { name: 'fix/issue-2-ancien', target: { committedDate: OLD } },
      { name: 'fix/issue-3-sans-date', target: null },
    ],
    want,
  );
  sync.collectPullRequestSignals(
    'pulse-web-interface',
    {
      open: {
        nodes: [
          pr(10, { isDraft: true, createdAt: RECENT, headRefName: 'fix/issue-4' }),
          pr(11, { isDraft: false, createdAt: OLD, headRefName: 'fix/issue-5' }),
        ],
      },
      merged: { nodes: [pr(12, { mergedAt: OLD, headRefName: 'fix/issue-6' })] },
    },
    want,
  );
  assert.deepEqual([...wanted.keys()], ['pulse-web-interface#1']);
});

test('une PR vise aussi les tickets d autres depots via closingIssuesReferences', () => {
  const { wanted, want } = sync.createWantedTracker();
  sync.collectPullRequestSignals(
    'pulse-mdm-server',
    {
      open: { nodes: [] },
      merged: {
        nodes: [
          pr(77, {
            mergedAt: RECENT,
            headRefName: 'fix/3173-current-content-freshness',
            closingIssuesReferences: {
              nodes: [{ number: 3173, repository: { name: 'pulse-web-interface' } }],
            },
          }),
        ],
      },
    },
    want,
  );
  assert.deepEqual([...wanted.keys()], ['pulse-web-interface#3173']);
  assert.equal(wanted.get('pulse-web-interface#3173').optionId, TO_BUILD);
});

test('run en dry-run planifie sans rien ecrire', async () => {
  const github = fakeGithub({
    refs: [{ name: 'fix/issue-7-x', target: { committedDate: RECENT } }],
    items: [item('I7', 'pulse-web-interface', 7, OPTION.aFaire, 'A faire')],
  });
  const core = createCore();

  const result = await sync({ github, core, env: { SYNC_MODE: 'dry-run' } });

  assert.equal(result.moves.length, 1);
  assert.equal(
    github.calls.graphql.filter(({ query }) => query.includes('mutation')).length,
    0,
  );
  assert.equal(core.calls.failed.length, 0);
  assert.equal(
    github.calls.graphql.filter(({ query }) => query.includes('refs(')).length,
    REPOSITORIES.length,
  );
});

test('run en execute ecrit le statut vise', async () => {
  const mutations = [];
  const github = fakeGithub({
    merged: [pr(20, { mergedAt: RECENT, headRefName: 'fix/issue-8-x' })],
    items: [item('I8', 'pulse-web-interface', 8, OPTION.enCours, 'En cours')],
    onMutation: (variables) => mutations.push(variables),
  });
  const core = createCore();

  await sync({ github, core, env: { SYNC_MODE: 'execute' } });

  assert.deepEqual(
    mutations.map(({ itemId, optionId }) => ({ itemId, optionId })),
    [{ itemId: 'I8', optionId: TO_BUILD }],
  );
  assert.equal(core.calls.failed.length, 0);
});

test('mode invalide : echec explicite, aucun appel', async () => {
  const github = fakeGithub();
  const core = createCore();
  await sync({ github, core, env: { SYNC_MODE: 'yolo' } });
  assert.deepEqual(core.calls.failed, ['Mode invalide: yolo']);
  assert.equal(github.calls.graphql.length, 0);
});

test('incident du 14/09 : limite atteinte au chargement du projet, run non echoue', async () => {
  const github = createGithub({
    graphql: [
      [
        'refs(',
        () => ({
          repository: {
            refs: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      ],
      ['pullRequests(', () => ({ repository: { open: { nodes: [] }, merged: { nodes: [] } } })],
      [
        'items(first: 100',
        () => {
          throw graphqlRateLimitError();
        },
      ],
    ],
  });
  const core = createCore();

  const result = await sync({ github, core, env: { SYNC_MODE: 'execute' } });

  assert.deepEqual(result, { rateLimited: true });
  assert.equal(core.calls.failed.length, 0);
  assert.equal(core.calls.warnings.length, 1);
});

test('une limite pendant le balayage interrompt le passage sans tenter les depots suivants', async () => {
  const github = createGithub({
    graphql: [
      [
        'refs(',
        () => {
          throw graphqlRateLimitError();
        },
      ],
    ],
  });
  const core = createCore();

  const result = await sync({ github, core, env: { SYNC_MODE: 'execute' } });

  assert.deepEqual(result, { rateLimited: true });
  assert.equal(github.calls.graphql.length, 1);
  assert.equal(core.calls.failed.length, 0);
});

test('une limite pendant les ecritures arrete les ecritures suivantes', async () => {
  let attempts = 0;
  const github = fakeGithub({
    refs: [
      { name: 'fix/issue-1-a', target: { committedDate: RECENT } },
      { name: 'fix/issue-2-b', target: { committedDate: RECENT } },
    ],
    items: [
      item('I1', 'pulse-web-interface', 1, OPTION.aFaire),
      item('I2', 'pulse-web-interface', 2, OPTION.aFaire),
    ],
    onMutation: () => {
      attempts += 1;
      throw graphqlRateLimitError();
    },
  });
  const core = createCore();

  const result = await sync({ github, core, env: { SYNC_MODE: 'execute' } });

  assert.deepEqual(result, { rateLimited: true });
  assert.equal(attempts, 1);
  assert.equal(core.calls.failed.length, 0);
});

test('une vraie panne sur un depot reste un echec, les autres depots sont balayes', async () => {
  const github = createGithub({
    graphql: [
      [
        'refs(',
        ({ name }) => {
          if (name === 'pulse-desktop') throw new Error('Depot inaccessible: pulse-desktop');
          return {
            repository: {
              refs: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          };
        },
      ],
      ['pullRequests(', () => ({ repository: { open: { nodes: [] }, merged: { nodes: [] } } })],
      ['items(first: 100', () => projectPage([])],
    ],
  });
  const core = createCore();

  const result = await sync({ github, core, env: { SYNC_MODE: 'execute' } });

  assert.equal(result.errors.length, 1);
  assert.deepEqual(core.calls.failed, ['1 erreur(s) pendant la synchronisation.']);
  assert.equal(
    github.calls.graphql.filter(({ query }) => query.includes('refs(')).length,
    REPOSITORIES.length,
  );
});
