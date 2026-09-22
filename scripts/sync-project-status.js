'use strict';

const { isRateLimitError, runWithRateLimitGuard } = require('./lib/github-errors');

const ORG = 'TKorpXR';
const PROJECT_ID = 'PVT_kwDOCnLJI84AkpBo';
const STATUS_FIELD_ID = 'PVTSSF_lADOCnLJI84AkpBozgc0WBA';

// Echelle complete du tableau, dans l'ordre. Le balayage ne deplace
// un ticket que vers un rang strictement superieur : un statut situe
// en aval de la cible resiste donc de lui-meme.
//
// Les trois statuts qui suivent `To build/To push` etaient absents
// de cette liste et valaient donc 0, comme les statuts amont. Une PR
// fusionnee ramenait ainsi en `To build/To push`, tous les quarts
// d'heure, un ticket passe en `A tester`, `Test OK` ou `Termine` —
// jusqu'a ce que la PR sorte de la fenetre de balayage. Les y
// remettre suffit a rendre l'avancee manuelle definitive.
const LADDER = [
  { optionId: '443ad84f', label: 'Retour Clo / a classifer' },
  { optionId: 'f75ad846', label: 'A faire' },
  { optionId: '47fc9ee4', label: 'En cours' },
  { optionId: '98236657', label: 'A fusionner' },
  { optionId: '8f26b0c8', label: 'To build/To push' },
  { optionId: 'e7841e11', label: 'A tester' },
  { optionId: 'b06935b3', label: 'Test OK' },
  { optionId: 'd6a4195b', label: 'Termine' },
];
const RANK_BY_OPTION = new Map(
  LADDER.map((status, index) => [status.optionId, index + 1]),
);
const STATUS_BY_OPTION = new Map(
  LADDER.map((status) => [status.optionId, status]),
);

// Statuts vises par le balayage, selon le signal observe.
const EN_COURS = '47fc9ee4';
const A_FUSIONNER = '98236657';
const TO_BUILD = '8f26b0c8';

// Label appose lors d'un echec en recette : un ticket portant ce label
// et recule en amont ne doit pas etre ramene vers To build/To push par
// une ancienne PR fusionnee.
const REJECTED_LABEL = '😩 Toujours pas bon';

// Mises en attente : ce sont des decisions humaines explicites, hors
// echelle. Aucun signal de code ne doit les ecraser — un ticket
// suspendu dont une branche bouge encore doit rester suspendu.
const HOLD_OPTION_IDS = new Set([
  'aed015ee', // Suspendu
  '04ee2d3b', // Version ulterieure
]);

// Mise en service : rien d'anterieur n'est repris, pour ne pas
// deplacer en masse des tickets dont la branche dort depuis des mois.
const START_AT = Date.parse('2026-09-04T20:00:00Z');

const REPOSITORIES = [
  'pulse-web-interface',
  'pulse-app-pilotage',
  'pulse-desktop',
  'pulse-mdm-android-service',
  'pulse-mdm-server',
  'pulse-home',
];

// Le prefixe litteral `issue-` est exige. Sans lui,
// `fix/3173-current-content-freshness` (pulse-mdm-server #73, qui
// reference un ticket pulse-web-interface) serait lu comme l'issue
// 3173 du depot ou vit la branche.
function issueFromBranch(branch) {
  const match = /(?:^|\/)issue[-_]?(\d+)/i.exec(branch || '');
  return match ? Number(match[1]) : null;
}

const key = (repository, number) => `${repository}#${number}`;

/** Retient le rang le plus avance vu pour chaque ticket tout en gardant l'ensemble des signaux. */
function createWantedTracker() {
  const wanted = new Map();
  function want(repository, number, optionId, reason) {
    const rank = RANK_BY_OPTION.get(optionId);
    const id = key(repository, number);
    let entry = wanted.get(id);
    if (!entry) {
      entry = {
        repository,
        number,
        optionId,
        rank,
        reason,
        signals: new Map(),
      };
      wanted.set(id, entry);
    }
    if (!entry.signals.has(optionId)) {
      entry.signals.set(optionId, { repository, number, optionId, rank, reason });
    }
    if (rank > entry.rank) {
      entry.optionId = optionId;
      entry.rank = rank;
      entry.reason = reason;
    }
  }
  return { wanted, want };
}

/** Tickets vises par une PR : nom de branche, puis `closingIssuesReferences`. */
function linkedIssues(repository, pullRequest) {
  const targets = new Map();
  const fromBranch = issueFromBranch(pullRequest.headRefName);
  if (fromBranch) {
    targets.set(key(repository, fromBranch), { repository, number: fromBranch });
  }
  for (const issue of pullRequest.closingIssuesReferences.nodes) {
    targets.set(key(issue.repository.name, issue.number), {
      repository: issue.repository.name,
      number: issue.number,
    });
  }
  return [...targets.values()];
}

/** Signal des branches d'une page de `refs`. Aucun appel reseau. */
function collectBranchSignals(repository, refNodes, want) {
  for (const ref of refNodes) {
    const number = issueFromBranch(ref.name);
    if (!number) continue;
    // Faute de date de creation de branche, la date du dernier
    // commit sert de reference : une branche endormie avant la mise
    // en service reste ignoree.
    const touchedAt = Date.parse(ref.target?.committedDate ?? '');
    if (!Number.isFinite(touchedAt) || touchedAt < START_AT) continue;
    want(repository, number, EN_COURS, `branche ${ref.name}`);
  }
}

/** Signaux des PR ouvertes et fusionnees d'un depot. Aucun appel reseau. */
function collectPullRequestSignals(repository, pullRequests, want) {
  for (const pullRequest of pullRequests.open.nodes) {
    // Un brouillon n'est pas pret a fusionner : il ne vaut que par sa
    // branche, deja comptee par ailleurs.
    if (pullRequest.isDraft) continue;
    if (Date.parse(pullRequest.createdAt) < START_AT) continue;
    for (const target of linkedIssues(repository, pullRequest)) {
      want(
        target.repository,
        target.number,
        A_FUSIONNER,
        `${repository}#${pullRequest.number} ouverte`,
      );
    }
  }

  for (const pullRequest of pullRequests.merged.nodes) {
    if (Date.parse(pullRequest.mergedAt) < START_AT) continue;
    for (const target of linkedIssues(repository, pullRequest)) {
      want(
        target.repository,
        target.number,
        TO_BUILD,
        `${repository}#${pullRequest.number} fusionnee`,
      );
    }
  }
}

/**
 * Deplacements a effectuer, a partir des cibles et de l'etat du projet.
 * Aucun appel reseau : c'est ici que vivent les regles de l'echelle.
 */
function planMoves(wanted, projectItems) {
  const moves = [];
  let absent = 0;
  let held = 0;

  for (const entry of wanted.values()) {
    const item = projectItems.get(key(entry.repository, entry.number));
    if (!item) {
      // `route-new-issue` et `reconcile-pulse-issues` sont seuls
      // responsables de l'ajout au projet : le ticket sera pris au
      // prochain passage.
      absent += 1;
      continue;
    }

    if (HOLD_OPTION_IDS.has(item.optionId)) {
      held += 1;
      continue;
    }

    const currentRank = RANK_BY_OPTION.get(item.optionId) ?? 0;
    const isRejected = item.labels?.has(REJECTED_LABEL);

    // Un ticket renvoye en amont avec le label « Toujours pas bon »
    // ne doit pas etre ramene en `To build/To push` par une ancienne PR
    // deja fusionnee. On neutralise le signal `TO_BUILD` pour ce ticket
    // et on retient le meilleur signal amont s'il existe (ex. branche
    // active pour `En cours`, nouvelle PR ouverte pour `A fusionner`).
    let target = entry;
    if (isRejected && currentRank < RANK_BY_OPTION.get(TO_BUILD)) {
      let bestUpstream = null;
      if (entry.signals) {
        for (const signal of entry.signals.values()) {
          if (signal.optionId === TO_BUILD) continue;
          if (!bestUpstream || signal.rank > bestUpstream.rank) {
            bestUpstream = signal;
          }
        }
      } else if (entry.optionId !== TO_BUILD) {
        bestUpstream = entry;
      }
      target = bestUpstream;
    }

    if (!target) {
      // Aucun signal actif permettant de deplacer le ticket rejete
      continue;
    }

    // Un statut hors echelle et hors attente vaut 0 : le ticket est
    // alors pris en charge comme s'il n'avait pas de statut.
    if (currentRank >= target.rank) continue;

    const status = STATUS_BY_OPTION.get(target.optionId);
    moves.push({
      itemId: item.id,
      optionId: status.optionId,
      issue: key(target.repository, target.number),
      from: item.label ?? 'sans statut',
      to: status.label,
      reason: target.reason,
    });
  }

  return { moves, absent, held };
}

async function scanRepository(github, repository, want) {
  // Les branches sont le signal primaire : aucune issue Pulse n'a de
  // `linkedBranches`, le bouton "Create a branch" n'etant pas utilise.
  let after = null;
  do {
    const data = await github.graphql(
      `query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          refs(
            refPrefix: "refs/heads/"
            first: 100
            after: $after
            orderBy: { field: ALPHABETICAL, direction: ASC }
          ) {
            nodes {
              name
              target { ... on Commit { committedDate } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner: ORG, name: repository, after },
    );

    const refs = data.repository?.refs;
    if (!refs) throw new Error(`Depot inaccessible: ${repository}`);
    collectBranchSignals(repository, refs.nodes, want);
    after = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null;
  } while (after);

  // `closingIssuesReferences` complete le nom de branche sans le
  // remplacer : il est incomplet en pratique (pulse-mdm-server #77
  // n'en portait aucune) mais rattrape les branches hors convention.
  const prs = await github.graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        open: pullRequests(
          states: OPEN
          first: 100
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          nodes {
            number
            isDraft
            createdAt
            headRefName
            closingIssuesReferences(first: 10) {
              nodes { number repository { name } }
            }
          }
        }
        merged: pullRequests(
          states: MERGED
          first: 50
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          nodes {
            number
            mergedAt
            headRefName
            closingIssuesReferences(first: 10) {
              nodes { number repository { name } }
            }
          }
        }
      }
    }`,
    { owner: ORG, name: repository },
  );

  collectPullRequestSignals(repository, prs.repository, want);
}

/** Items du projet, indexes par `depot#numero`. */
async function loadProjectItems(github) {
  const byIssue = new Map();
  let after = null;

  do {
    const data = await github.graphql(
      `query($projectId: ID!, $after: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $after) {
              nodes {
                id
                content {
                  ... on Issue {
                    number
                    repository { name }
                    labels(first: 20) {
                      nodes { name }
                    }
                  }
                }
                fieldValues(first: 30) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      optionId
                      name
                      field {
                        ... on ProjectV2SingleSelectField { id }
                      }
                    }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { projectId: PROJECT_ID, after },
    );

    const page = data.node?.items;
    if (!page) throw new Error('Projet Pulse introuvable ou inaccessible.');

    for (const item of page.nodes) {
      const content = item.content;
      if (!content?.number || !content.repository?.name) continue;
      const status = item.fieldValues.nodes.find(
        (value) => value.field?.id === STATUS_FIELD_ID,
      );
      const labels = new Set(
        (content.labels?.nodes || []).map((node) => node.name),
      );
      byIssue.set(key(content.repository.name, content.number), {
        id: item.id,
        optionId: status?.optionId ?? null,
        label: status?.name ?? null,
        labels,
      });
    }

    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return byIssue;
}

async function setStatus(github, itemId, optionId) {
  await github.graphql(
    `mutation(
      $projectId: ID!,
      $itemId: ID!,
      $fieldId: ID!,
      $optionId: String!
    ) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId: PROJECT_ID, itemId, fieldId: STATUS_FIELD_ID, optionId },
  );
}

async function run({ github, core, env = process.env }) {
  const mode = env.SYNC_MODE;
  if (!['dry-run', 'execute'].includes(mode)) {
    core.setFailed(`Mode invalide: ${mode}`);
    return undefined;
  }

  const errors = [];
  async function execute() {
    const { wanted, want } = createWantedTracker();

    for (const repository of REPOSITORIES) {
      try {
        await scanRepository(github, repository, want);
      } catch (error) {
        // Une limite de debit vaut pour tous les depots suivants : inutile
        // de les tenter, le garde interrompt le passage.
        if (isRateLimitError(error)) throw error;
        errors.push(`${repository}: ${error.message}`);
        core.error(`${repository}: ${error.stack || error.message}`);
      }
    }

    const projectItems = await loadProjectItems(github);
    const plan = planMoves(wanted, projectItems);
    const moves = [];

    for (const move of plan.moves) {
      if (mode === 'execute') {
        try {
          await setStatus(github, move.itemId, move.optionId);
        } catch (error) {
          if (isRateLimitError(error)) throw error;
          errors.push(`${move.issue}: ${error.message}`);
          core.error(`${move.issue}: ${error.stack || error.message}`);
          continue;
        }
      }
      moves.push(move);
    }

    core.summary
      .addHeading(
        mode === 'execute'
          ? 'Statuts synchronises avec le code'
          : 'Previsualisation de la synchronisation',
      )
      .addRaw(
        `**${moves.length}** deplacement(s), ` +
          `**${plan.absent}** ticket(s) hors projet ignore(s), ` +
          `**${plan.held}** en attente respectee(s), ` +
          `**${errors.length}** erreur(s).\n\n`,
      );

    if (moves.length) {
      core.summary.addTable([
        [
          { data: 'Ticket', header: true },
          { data: 'De', header: true },
          { data: 'Vers', header: true },
          { data: 'Signal', header: true },
        ],
        ...moves.slice(0, 100).map((move) => [
          move.issue,
          move.from,
          move.to,
          move.reason,
        ]),
      ]);
    }
    await core.summary.write();

    const message = failureMessage();
    if (message) core.setFailed(message);
    return { moves, errors, absent: plan.absent, held: plan.held };
  }

  // Seule source du message d'echec : fin normale du passage, ou passage
  // interrompu par une limite de debit apres de vraies erreurs.
  const failureMessage = () =>
    errors.length ? `${errors.length} erreur(s) pendant la synchronisation.` : null;

  return runWithRateLimitGuard(
    { core, workflow: 'sync-project-status', getFailureMessage: failureMessage },
    execute,
  );
}

module.exports = run;
module.exports.run = run;
module.exports.issueFromBranch = issueFromBranch;
module.exports.createWantedTracker = createWantedTracker;
module.exports.collectBranchSignals = collectBranchSignals;
module.exports.collectPullRequestSignals = collectPullRequestSignals;
module.exports.planMoves = planMoves;
module.exports.loadProjectItems = loadProjectItems;
module.exports.constants = {
  LADDER,
  HOLD_OPTION_IDS,
  START_AT,
  REPOSITORIES,
  EN_COURS,
  A_FUSIONNER,
  TO_BUILD,
  REJECTED_LABEL,
};
