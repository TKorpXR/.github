'use strict';

/**
 * Reconnait une limite de debit GitHub, quelle que soit la forme sous laquelle
 * octokit la remonte.
 *
 * - GraphQL : la reponse est un HTTP 200 dont le corps porte
 *   `errors: [{ type: 'RATE_LIMIT' }]`. `github-script` la leve en
 *   `GraphqlResponseError`, que le plugin de reprise (`retries`) ne voit pas :
 *   il ne rejoue que sur le statut HTTP.
 * - REST : HTTP 403 ou 429, avec `x-ratelimit-remaining: 0` (limite primaire)
 *   ou un message « secondary rate limit » (limite anti-rafale).
 *
 * Un 403 de permission (« Resource not accessible by integration ») n'est pas
 * une limite de debit et doit continuer d'echouer franchement.
 */
function isRateLimitError(error) {
  if (!error || typeof error !== 'object') return false;

  const graphqlErrors = Array.isArray(error.errors) ? error.errors : [];
  if (graphqlErrors.some((entry) => entry?.type === 'RATE_LIMIT')) return true;

  if (error.status !== 403 && error.status !== 429) return false;
  const headers = error.response?.headers ?? {};
  if (String(headers['x-ratelimit-remaining']) === '0') return true;
  return /rate limit/i.test(String(error.message ?? ''));
}

/**
 * Execute un passage de workflow en traitant la limite de debit comme un
 * incident passager, pas comme un echec.
 *
 * Le jeton du projet est partage avec d'autres usages du meme compte : une
 * operation de masse faite a la main suffit a l'epuiser pendant quelques
 * minutes. Faire echouer le run envoie alors un e-mail pour un probleme qui se
 * resout seul, et ce bruit finit par masquer les vrais echecs.
 *
 * Les deux workflows couverts sont idempotents : un passage interrompu n'a rien
 * a rattraper, le suivant refait le balayage complet. Le run se termine donc en
 * succes, avec un avertissement visible dans l'onglet Actions et le resume.
 *
 * Toute autre erreur est relancee telle quelle.
 */
async function runWithRateLimitGuard({ core, workflow }, run) {
  try {
    return await run();
  } catch (error) {
    if (!isRateLimitError(error)) throw error;

    core.warning(
      `${workflow} : limite de debit GitHub atteinte, passage interrompu. ` +
        `Le prochain declenchement refera le balayage complet. (${error.message})`,
    );
    await core.summary
      .addHeading('Passage interrompu : limite de debit GitHub')
      .addRaw(
        'Le jeton du projet a epuise son quota. Rien a corriger : le workflow ' +
          'est idempotent et le prochain passage refera le balayage complet.\n',
      )
      .write();
    return { rateLimited: true };
  }
}

module.exports = { isRateLimitError, runWithRateLimitGuard };
