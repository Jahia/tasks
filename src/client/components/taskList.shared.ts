/**
 * Mutation shared between CreateTaskFormView.server.tsx and CreateTaskForm.client.tsx. See
 * taskBoard.shared.ts for why this has no @jahia/javascript-modules-library import.
 */

export const CREATE_TASK_MUTATION = /* GraphQL */ `
    mutation CreateTask(
        $parentPath: String!
        $taskType: String
        $title: String!
        $description: String
        $priority: String
        $assigneeUserKey: String
        $dueDate: String
    ) {
        createTask(
            parentPath: $parentPath
            taskType: $taskType
            title: $title
            description: $description
            priority: $priority
            assigneeUserKey: $assigneeUserKey
            dueDate: $dueDate
        ) {
            id
        }
    }
`;
