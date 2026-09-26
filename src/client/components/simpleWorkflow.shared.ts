/**
 * The mutation that writes a reviewer's comment onto a task's jnt:simpleWorkflow taskData child.
 *
 * Kept in its own module rather than folded into taskBoard.shared.ts because it is about the
 * taskData child node, not about the board's listing -- the board is simply its only caller now
 * that the server-rendered jnt:simpleWorkflow view is gone (#69).
 */

import {gql} from '@apollo/client';

export const UPDATE_TASK_DATA_TITLE_MUTATION = gql`
    mutation UpdateTaskDataTitle($id: String!, $title: String!) {
        updateTaskDataTitle(id: $id, title: $title) {
            id
        }
    }
`;
