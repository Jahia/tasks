/**
 * "Somebody closed a task you raised" -- the notification this module puts on the profile icon in
 * the app shell's first-level menu (see src/javascript/notifications/ClosedTaskNotifications).
 *
 * The board itself needs no such notice: its Closed column already shows the same tasks to
 * anybody looking at it. The point of this one is to reach somebody who is NOT on the board.
 *
 * Everything here is plain TypeScript over `window`, with no React and no import from
 * @jahia/javascript-modules-library: the board island that announces these events is bundled by
 * Vite as well as by webpack, and the notification source that listens is bundled only by
 * webpack, so the two sides may not share a module instance. Events on `window` cross that line;
 * a module-level subscriber list would not.
 */

import {readSeenTaskIds, rememberSeenTaskIds} from './seenTaskIds';

/** How many closed tasks the notification can see at once -- the most recently closed N. */
export const CLOSED_ALERTS_WINDOW = 100;

/**
 * Sorted by the closing itself, newest first, now that a closed task records when it closed
 * (see GqlTaskBoard#getClosedDate). The scope and the state are constants rather than caller
 * input, so they go into the document as literals.
 */
export const CLOSED_TASK_ALERTS_QUERY = /* GraphQL */ `
    query ClosedTasksIRaised($first: Int!) {
        # Who is asking, so the seen-list is keyed the way GqlTaskBoard keys a viewer.
        taskBoardCurrentUserKey
        closedCreatedByMe: taskBoard(
            first: $first
            scope: "createdByMe"
            filterState: ["finished"]
            sortBy: "jcr:lastModified"
            sortOrder: "descending"
        ) {
            edges {
                node {
                    id
                    title
                    closedDate
                }
            }
        }
    }
`;

export type ClosedTaskAlert = {
    id: string;
    title: string | null;
    closedDate: string | null;
};

export type ClosedTaskAlertsResult = {
    taskBoardCurrentUserKey: string;
    closedCreatedByMe: {
        edges: Array<{node: ClosedTaskAlert}>;
    };
};

/**
 * The board telling the notification what the reader has already taken in. Two facts, because
 * they are the only two ways somebody learns about a closure without the profile icon:
 *
 * - VIEWED: they opened the `Tasks I've created` list, where every closed task they raised is on
 *   screen in the Closed column.
 * - CLOSED: they closed a task themselves, from the board.
 */
const VIEWED_EVENT = 'tasks:created-list-viewed';
const CLOSED_EVENT = 'tasks:task-closed';

export const announceCreatedListViewed = (): void => {
    window.dispatchEvent(new CustomEvent(VIEWED_EVENT));
};

export const announceTaskClosed = (id: string): void => {
    window.dispatchEvent(new CustomEvent(CLOSED_EVENT, {detail: {id}}));
};

/** Returns the unsubscribe function, for an effect's cleanup. */
export function onCreatedListViewed(listener: () => void): () => void {
    window.addEventListener(VIEWED_EVENT, listener);
    return () => window.removeEventListener(VIEWED_EVENT, listener);
}

export function onTaskClosed(listener: (id: string) => void): () => void {
    const handler = (event: Event) => {
        const id = (event as CustomEvent<{id: string}>).detail?.id;
        if (id) {
            listener(id);
        }
    };

    window.addEventListener(CLOSED_EVENT, handler);
    return () => window.removeEventListener(CLOSED_EVENT, handler);
}

/*
 * What this browser has already shown the reader -- see seenTaskIds. The list name keeps the
 * storage key this source has always used, so nobody's read state is lost.
 */

const SEEN_LIST = 'closed';

/**
 * How many ids are remembered. Larger than the window so ids marked seen one at a time -- a task
 * the reader closed themselves, which need not be in the window -- are not pushed straight back
 * out by the next full sweep.
 */
const SEEN_MEMORY = 2 * CLOSED_ALERTS_WINDOW;

export function rememberSeenClosedIds(userKey: string, ids: string[]): void {
    rememberSeenTaskIds(SEEN_LIST, userKey, ids, SEEN_MEMORY);
}

/**
 * Which of these closed tasks the reader has not been shown yet, in the order given.
 *
 * On a first ever visit this records the whole window and reports nothing: arriving to be told
 * that forty tasks closed over the past year is not a notification, it is a wall.
 */
export function newlyClosedTasks(userKey: string, closed: ClosedTaskAlert[]): ClosedTaskAlert[] {
    const seen = readSeenTaskIds(SEEN_LIST, userKey);
    if (seen === null) {
        rememberSeenClosedIds(userKey, closed.map(task => task.id));
        return [];
    }

    const seenIds = new Set(seen);
    return closed.filter(task => !seenIds.has(task.id));
}
