'use strict';

const { isRateLimitError, runWithRateLimitGuard } = require('./lib/github-errors');

const ORG = 'TKorpXR';
const PROJECT_ID = 'PVT_kwDOCnLJI84AkpBo';
const STATUS_FIELD_ID = 'PVTSSF_lADOCnLJI84AkpBozgc0WBA';
const QUALIFY_STATUS_ID = '443ad84f';
const ENTITY_FIELD_ID = 'PVTSSF_lADOCnLJI84AkpBozg19_Ts';

const ROUTES = {
  Web: {
    repository: 'pulse-web-interface',
    entity: 'Web',
    entityOptionId: '9417e9a1',
  },
  'Mobile app': {
    repository: 'pulse-app-pilotage',
    entity: 'Mobile app',
    entityOptionId: '8bacd380',
  },
  Desktop: {
    repository: 'pulse-desktop',
    entity: 'Desktop',
    entityOptionId: 'c71e7231',
  },
  'MDM Android': {
    repository: 'pulse-mdm-android-service',
    entity: 'MDM',
    entityOptionId: '06830893',
  },
  'MDM Serveur': {
    repository: 'pulse-mdm-server',
    entity: 'MDM',
    entityOptionId: '06830893',
  },
  'VR app': {
    repository: 'pulse-home',
    entity: 'VR app',
    entityOptionId: 'e53b5660',
  },
  Autre: {
    repository: '.github',
    entity: 'Autre',
    entityOptionId: '4d0938ce',
  },
};

const REPOSITORY_PRODUCTS = {
  'pulse-web-interface': 'Web',
  'pulse-app-pilotage': 'Mobile app',
  'pulse-desktop': 'Desktop',
  'pulse-mdm-android-service': 'MDM Android',
  'pulse-mdm-server': 'MDM Serveur',
  'pulse-home': 'VR app',
};

const REPOSITORIES = ['.github', ...Object.keys(REPOSITORY_PRODUCTS)];

function extractProduct(body) {
  const match = (body || '').match(
    /### Produit concerné\s*\r?\n+\s*([^\r\n]+)/i,
  );
  return match?.[1]?.trim();
}

/** Route d'un ticket : produit declare dans le corps, sinon celui du depot. */
function resolveRoute(repository, body) {
  const product = extractProduct(body) || REPOSITORY_PRODUCTS[repository];
  return ROUTES[product] ?? null;
}

/** Ce qu'il manque a un ticket pour etre en regle. Aucun appel reseau. */
function planIssue({ repository, route, existingItem }) {
  const needsTransfer = repository !== route.repository;
  const needsProject = !existingItem;
  const needsEntity =
    existingItem?.values.get(ENTITY_FIELD_ID) !== route.entityOptionId;
  const needsStatus = needsProject || !existingItem?.values.get(STATUS_FIELD_ID);
  return {
    needsTransfer,
    needsProject,
    needsEntity,
    needsStatus,
    upToDate: !needsTransfer && !needsProject && !needsEntity && !needsStatus,
  };
}

async function loadProjectItems(github) {
  const byContentId = new Map();
  let after = null;

  do {
    const data = await github.graphql(
      `query($projectId: ID!, $after: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $after) {
              nodes {
                id
                content { ... on Issue { id } }
                fieldValues(first: 30) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      optionId
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
      if (!item.content?.id) continue;
      byContentId.set(item.content.id, {
        id: item.id,
        values: new Map(
          item.fieldValues.nodes
            .filter((value) => value.field?.id && value.optionId)
            .map((value) => [value.field.id, value.optionId]),
        ),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return byContentId;
}

async function addProjectItem(github, contentId) {
  const result = await github.graphql(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {
        projectId: $projectId,
        contentId: $contentId
      }) {
        item { id }
      }
    }`,
    { projectId: PROJECT_ID, contentId },
  );
  return result.addProjectV2ItemById.item.id;
}

async function setSingleSelect(github, itemId, fieldId, optionId) {
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
    { projectId: PROJECT_ID, itemId, fieldId, optionId },
  );
}

async function transferIssue(github, issueId, destinationRepository) {
  const destination = await github.graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }`,
    { owner: ORG, name: destinationRepository },
  );
  if (!destination.repository?.id) {
    throw new Error(`Repository cible introuvable: ${destinationRepository}`);
  }

  const result = await github.graphql(
    `mutation($issueId: ID!, $repositoryId: ID!) {
      transferIssue(input: {
        issueId: $issueId,
        repositoryId: $repositoryId,
        createLabelsIfMissing: true
      }) {
        issue { id number url repository { name } }
      }
    }`,
    { issueId, repositoryId: destination.repository.id },
  );
  return result.transferIssue.issue;
}

async function run({ github, core, env = process.env, now = Date.now() }) {
  const mode = env.RECONCILE_MODE;
  const lookbackDays = Number.parseInt(env.LOOKBACK_DAYS, 10);

  if (!['dry-run', 'execute'].includes(mode)) {
    core.setFailed(`Mode invalide: ${mode}`);
    return undefined;
  }
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 3650) {
    core.setFailed(`lookback-days invalide: ${env.LOOKBACK_DAYS}`);
    return undefined;
  }

  const errors = [];
  async function execute() {
    const since = new Date(now - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    let projectItems = await loadProjectItems(github);
    const results = [];

    for (const repository of REPOSITORIES) {
      // Seuls les tickets ouverts sont reconcilies : un ticket ferme, ou
      // archive du projet, n'y est jamais remis.
      const issues = await github.paginate(github.rest.issues.listForRepo, {
        owner: ORG,
        repo: repository,
        state: 'open',
        since,
        per_page: 100,
      });

      for (const sourceIssue of issues.filter((issue) => !issue.pull_request)) {
        const route = resolveRoute(repository, sourceIssue.body);

        if (!route) {
          results.push({
            result: 'Ignoré: produit absent ou inconnu',
            source: sourceIssue.html_url,
            destination: '',
            entity: '',
          });
          continue;
        }

        let issue = {
          nodeId: sourceIssue.node_id,
          url: sourceIssue.html_url,
          repository,
        };
        const plan = planIssue({
          repository,
          route,
          existingItem: projectItems.get(issue.nodeId),
        });
        if (plan.upToDate) continue;

        if (mode === 'execute') {
          try {
            if (plan.needsTransfer) {
              const transferred = await transferIssue(
                github,
                issue.nodeId,
                route.repository,
              );
              issue = {
                nodeId: transferred.id,
                url: transferred.url,
                repository: transferred.repository.name,
              };
              projectItems = await loadProjectItems(github);
            }

            let item = projectItems.get(issue.nodeId);
            let created = false;
            if (!item) {
              const itemId = await addProjectItem(github, issue.nodeId);
              item = { id: itemId, values: new Map() };
              projectItems.set(issue.nodeId, item);
              created = true;
            }

            if (created || !item.values.get(STATUS_FIELD_ID)) {
              await setSingleSelect(github, item.id, STATUS_FIELD_ID, QUALIFY_STATUS_ID);
            }
            if (item.values.get(ENTITY_FIELD_ID) !== route.entityOptionId) {
              await setSingleSelect(
                github,
                item.id,
                ENTITY_FIELD_ID,
                route.entityOptionId,
              );
            }
          } catch (error) {
            if (isRateLimitError(error)) throw error;
            errors.push(`${sourceIssue.html_url}: ${error.message}`);
            core.error(`${sourceIssue.html_url}: ${error.stack || error.message}`);
            continue;
          }
        }

        results.push({
          result: mode === 'execute' ? 'Réconcilié' : 'Prévisualisation',
          source: sourceIssue.html_url,
          destination: `${ORG}/${route.repository}`,
          entity: route.entity,
        });
      }
    }

    core.summary
      .addHeading(
        mode === 'execute'
          ? 'Réconciliation des tickets Pulse'
          : 'Prévisualisation de la réconciliation',
      )
      .addRaw(
        `Fenêtre analysée: **${lookbackDays} jour(s)**. ` +
          `**${results.length}** résultat(s), **${errors.length}** erreur(s).\n\n`,
      );

    if (results.length) {
      core.summary.addTable([
        [
          { data: 'Résultat', header: true },
          { data: 'Source', header: true },
          { data: 'Destination', header: true },
          { data: 'Entity', header: true },
        ],
        ...results.slice(0, 100).map((result) => [
          result.result,
          result.source,
          result.destination,
          result.entity,
        ]),
      ]);
    }
    await core.summary.write();

    const message = failureMessage();
    if (message) core.setFailed(message);
    return { results, errors };
  }

  // Seule source du message d'echec : fin normale du passage, ou passage
  // interrompu par une limite de debit apres de vraies erreurs.
  const failureMessage = () =>
    errors.length ? `${errors.length} ticket(s) en erreur.` : null;

  return runWithRateLimitGuard(
    { core, workflow: 'reconcile-pulse-issues', getFailureMessage: failureMessage },
    execute,
  );
}

module.exports = run;
module.exports.run = run;
module.exports.extractProduct = extractProduct;
module.exports.resolveRoute = resolveRoute;
module.exports.planIssue = planIssue;
module.exports.constants = {
  ROUTES,
  REPOSITORY_PRODUCTS,
  REPOSITORIES,
  STATUS_FIELD_ID,
  ENTITY_FIELD_ID,
  QUALIFY_STATUS_ID,
};
