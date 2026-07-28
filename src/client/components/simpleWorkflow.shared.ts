/**
 * Mutation shared between SimpleWorkflowTaskDataView.server.tsx and
 * SimpleWorkflowTaskData.client.tsx. See taskBoard.shared.ts for why this has no
 * @jahia/javascript-modules-library import.
 */

export const UPDATE_TASK_DATA_TITLE_MUTATION = /* GraphQL */ `
    mutation UpdateTaskDataTitle($id: String!, $title: String!) {
        updateTaskDataTitle(id: $id, title: $title) {
            id
        }
    }
`;
