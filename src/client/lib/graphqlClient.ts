/**
 * Plain-fetch GraphQL POST helper shared by every client island in this module.
 * Deliberately has no import from @jahia/javascript-modules-library -- that library is
 * forbidden in the client bundle, and this needs to be importable from every client
 * component regardless of which SSR view renders it.
 */

export type GraphQLResponse<T> = {
    data?: T;
    errors?: Array<{message: string}>;
};

export async function callGraphQL<T = unknown>(
    endpoint: string,
    query: string,
    variables: Record<string, unknown>
): Promise<T> {
    const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query, variables})
    });
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    const body = await response.json() as GraphQLResponse<T>;
    if (body.errors && body.errors.length > 0) {
        throw new Error(body.errors.map(error => error.message).join('; '));
    }

    if (!body.data) {
        throw new Error('GraphQL response contained no data');
    }

    return body.data;
}
