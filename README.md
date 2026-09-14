# TKorpXR/.github

Configuration commune de l'organisation : modèles de tickets, labels et workflows
d'automatisation du **Project Pulse**.

## Workflows d'automatisation

| Workflow | Déclenchement | Rôle |
|---|---|---|
| `route-new-issue` | ouverture d'un ticket | range le ticket dans le bon dépôt et le projet |
| `reconcile-pulse-issues` | toutes les 15 min | remet en règle les tickets ouverts : dépôt, présence au projet, Status initial, Entity |
| `sync-project-status` | toutes les 15 min | fait avancer le Status au rythme des branches et des PR |
| `sync-one-repo`, `sync-org-labels` | à la demande | synchronisation des labels |
| `update-repo-dropdown` | à la demande | liste des dépôts du formulaire de ticket |
| `migrate-legacy-issues` | à la demande | reprise des anciens tickets |

Ces workflows écrivent sur des tickets réels. Chacun expose un mode `dry-run` via
`workflow_dispatch` : **toujours prévisualiser avant de lancer en `execute`**.

## Scripts et tests

La logique de `reconcile-pulse-issues` et de `sync-project-status` vit dans
`scripts/`, et non dans le YAML : le workflow récupère le dossier puis appelle
le script via `actions/github-script`.

```
scripts/
  lib/github-errors.js          reconnaissance et traitement des limites de débit
  reconcile-pulse-issues.js
  sync-project-status.js
tests/
  helpers/fakes.js              doublures de github, core et des réponses GraphQL
  *.test.js
```

```bash
npm test
```

Aucune dépendance à installer : les tests tournent avec `node --test` (Node 22 ou
plus). Ils ne font aucun appel réseau — tout appel GraphQL non prévu par une
doublure fait échouer le test. Le dépôt est public : les fixtures ne contiennent
que des données fictives.

Le workflow `test-automation-scripts` rejoue les tests et `actionlint` sur chaque
PR et à chaque fusion sur `main`.

## Limites de débit

Le jeton du projet est rattaché à un compte utilisateur, dont le quota GraphQL
est partagé avec tous ses autres usages. Une opération de masse faite à la main
suffit à l'épuiser quelques minutes.

Quand GitHub renvoie une limite de débit, `reconcile-pulse-issues` et
`sync-project-status` **interrompent le passage avec un avertissement, sans
faire échouer le run**. Les deux sont idempotents : le passage suivant refait le
balayage complet, il n'y a rien à rattraper. Toute autre erreur continue de
faire échouer le run.

Un avertissement « limite de débit » qui revient à chaque passage n'est plus un
incident passager : il faut alors regarder qui consomme le quota du compte.
