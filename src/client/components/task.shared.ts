/**
 * Query/mutation strings and result types shared between TaskView.server.tsx (SSR fetch of
 * the task's own fields) and TaskDetail.client.tsx (state-transition actions). See
 * taskBoard.shared.ts for why this has no @jahia/javascript-modules-library import.
 */

export const TASK_QUERY = /* GraphQL */ `
    query Task($id: String!) {
        task(id: $id) {
            id
            title
            description
            priority
            state
            owner
            assigneeDisplayName
            isAssignableToMe
            possibleOutcomes
            targetNode {
                url
            }
        }
        taskBoardCurrentUserKey
        taskBoardCanReviewAll
    }
`;

export const UPDATE_TASK_STATE_MUTATION = /* GraphQL */ `
    mutation UpdateTaskState($id: String!, $state: String!) {
        updateTaskState(id: $id, state: $state) {
            id
            state
        }
    }
`;

export type TaskNode = {
    id: string;
    title: string | null;
    description: string | null;
    priority: string | null;
    state: string | null;
    owner: string | null;
    assigneeDisplayName: string | null;
    isAssignableToMe: boolean;
    possibleOutcomes: string[];
    targetNode: {url: string} | null;
};

export type TaskQueryResult = {
    task: TaskNode;
    taskBoardCurrentUserKey: string;
    taskBoardCanReviewAll: boolean;
};
