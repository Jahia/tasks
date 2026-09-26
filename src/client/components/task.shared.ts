/**
 * How a single task's two choicelist properties READ, and the mutation that changes its state.
 *
 * Separate from taskBoard.shared.ts (the listing query and its duration helpers) because these are
 * about one task rather than about the board: they were shared with the server-rendered task view
 * until #69 removed it, and the board is now their only caller.
 */

import {gql} from '@apollo/client';
import type {Translate} from '../lib/i18n';

// Last-resort presentation of a raw stored value. Used as the DEFAULT of the two lookups below
// rather than on its own: it exists for a value no locale file has a key for. Not exported --
// the task detail view that used to call it directly went with the server-rendered path (#69).
function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

// The two enum-valued properties a task renders (definitions.cnd declares 'low'/'normal'/'high'
// and 'active'/'started'/'suspended'/'finished'/'cancelled'), as localized labels. Kept here rather
// than inside TaskBoard.client.tsx so they stay importable without dragging Moonstone in, the same
// reason taskBoard.shared.ts holds the duration helpers.
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

export const UPDATE_TASK_STATE_MUTATION = gql`
    mutation UpdateTaskState($id: String!, $state: String!) {
        updateTaskState(id: $id, state: $state) {
            id
            state
        }
    }
`;
