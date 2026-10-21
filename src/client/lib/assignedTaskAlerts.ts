/**
 * "Somebody gave you a task" -- the second notification this module puts on the profile icon in
 * the app shell's first-level menu (see src/javascript/notifications/AssignedTaskNotifications),
 * beside closedTaskAlerts' "somebody closed a task you raised".
 *
 * Unlike closures, this is a count of outstanding work rather than of news: every task somebody
 * else assigned to the viewer that is still 'active' counts, whether or not the viewer has looked
 * at it, and it stops counting only once it leaves that state -- started, refused or closed. So
 * there is no read state to keep, only the server's answer to re-ask when a task changes.
 *
 * Plain TypeScript over `window`, for the same reason as closedTaskAlerts: the board that
 * announces a change is bundled by Vite as well as webpack, the listener only by webpack, and
 * only events on `window` cross that line.
 */

/** How many active assignments the notification can see at once. */
export const ASSIGNED_ALERTS_WINDOW = 100;

/** The scope and the state are constants rather than caller input, so they are literals. */
export const ASSIGNED_TASK_ALERTS_QUERY = /* GraphQL */ `
    query ActiveTasksAssignedToMe($first: Int!) {
        activeAssignedToMe: taskBoard(
            first: $first
            scope: "assignedToMe"
            filterState: ["active"]
            sortBy: "jcr:created"
            sortOrder: "descending"
        ) {
            edges {
                node {
                    id
                    title
                    creator
                    createdDate
                }
            }
        }
    }
`;

export type AssignedTaskAlert = {
    id: string;
    title: string | null;
    creator: string | null;
    createdDate: string | null;
};

export type AssignedTaskAlertsResult = {
    activeAssignedToMe: {
        edges: Array<{node: AssignedTaskAlert}>;
    };
};

/**
 * The board telling the notification that a task changed -- started, refused, closed, moved to
 * another column, decided in a workflow -- so the count is asked again instead of waiting for the
 * next page load.
 */
const CHANGED_EVENT = 'tasks:task-changed';

export const announceTaskChanged = (): void => {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
};

/** Returns the unsubscribe function, for an effect's cleanup. */
export function onTaskChanged(listener: () => void): () => void {
    window.addEventListener(CHANGED_EVENT, listener);
    return () => window.removeEventListener(CHANGED_EVENT, listener);
}

/**
 * The tasks to count: a task the viewer raised for themselves is not one somebody gave them, so
 * it never counts.
 */
export function tasksAssignedByOthers(userName: string | null, assigned: AssignedTaskAlert[]): AssignedTaskAlert[] {
    return assigned.filter(task => !userName || task.creator !== userName);
}
