/**
 * Turning a failed Apollo operation into the sentence the board puts in its error Banner.
 *
 * <h3>Why the server's message is shown verbatim</h3>
 * The messages this surfaces are deliberately viewer-facing. The module's own GraphQL errors are
 * raised as TaskGraphQLException, which extends graphql-dxm-provider's DataFetchingException
 * precisely so JahiaDataFetchingExceptionHandler maps them to a DXGraphQLError carrying that text
 * -- rather than the generic "Internal Server Error(s) while executing query" every unhandled
 * exception collapses into. Swallowing them here and showing a house string instead would throw
 * away the only specific thing the reviewer is told about why an action was refused.
 *
 * <h3>Why not just ApolloError#message</h3>
 * Apollo concatenates nothing: `error.message` is the FIRST GraphQL error, so a response carrying
 * several would silently lose all but one. This joins them, which is what the hand-rolled
 * callGraphQL this replaced did (`body.errors.map(e => e.message).join('; ')`) -- keeping the
 * displayed text identical across the #69 migration to Apollo.
 */

import {ApolloError} from '@apollo/client';

/**
 * @param fallback shown when the failure carries no message worth reading -- a network-level
 * failure whose text is a browser-specific string ("Failed to fetch"), or a non-Error thrown from
 * somewhere that should not have thrown at all. Always a translated sentence from the caller.
 */
export function graphqlErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApolloError) {
        if (error.graphQLErrors.length > 0) {
            return error.graphQLErrors.map(one => one.message).join('; ');
        }

        // A network error, a 4xx/5xx, or a response that never parsed. Its message names the
        // transport, not the task, so the caller's own sentence reads better.
        return fallback;
    }

    return error instanceof Error && error.message !== '' ? error.message : fallback;
}
