/**
 * Query/mutation strings and result types shared between TaskView.server.tsx (SSR fetch of
 * the task's own fields) and TaskDetail.client.tsx (state-transition actions). See
 * taskBoard.shared.ts for why this has no @jahia/javascript-modules-library import.
 */

// Type-only, so nothing from the i18n bridge (a browser-global reader) is pulled into the server
// bundle that also imports this file for TASK_QUERY.
import type {Translate} from '../lib/i18n';

// Last-resort presentation of a raw stored value. Used as the DEFAULT of the two lookups below
// rather than on its own: it exists for a value no locale file has a key for.
export function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

// The two enum-valued properties every task view renders (definitions.cnd declares
// 'low'/'normal'/'high' and 'active'/'started'/'suspended'/'finished'/'cancelled'), as localized
// labels. Shared by TaskBoard.client.tsx and TaskDetail.client.tsx so the same stored value cannot
// read one way on the board and another on the detail view.
//
// Each builds its key from the stored value and hands capitalize() in as the default, so a value
// written by something other than this UI -- both properties are plain strings server-side -- still
// renders as itself rather than as a raw translation key.
export function priorityLabel(t: Translate, priority: string | null): string {
    if (!priority) {
        return t('common.unknown', 'Unknown');
    }

    return t(`common.priority.${priority}`, capitalize(priority));
}

export function stateLabel(t: Translate, state: string | null): string {
    if (!state) {
        return t('common.unknown', 'Unknown');
    }

    return t(`common.state.${state}`, capitalize(state));
}

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
