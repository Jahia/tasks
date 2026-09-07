import {useCallback, useEffect, useRef, useState} from 'react';
import {callGraphQL} from '../../client/lib/graphqlClient';
import {
    CLOSED_ALERTS_WINDOW,
    CLOSED_TASK_ALERTS_QUERY,
    newlyClosedTasks,
    onCreatedListViewed,
    onTaskClosed,
    rememberSeenClosedIds
} from '../../client/lib/closedTaskAlerts';
import type {ClosedTaskAlert, ClosedTaskAlertsResult} from '../../client/lib/closedTaskAlerts';

// Relative to the current origin, like TasksDashboardApp's: there is no SSR-side
// buildEndpointUrl() to be had here, and a plain relative path resolves from the shell.
const GRAPHQL_ENDPOINT = '/modules/graphql';

// Where the profile icon's notifications live -- the dashboard's Tasks tab, which is what these
// notifications are about.
const TASKS_ROUTE = '/dashboard/tasks';

type NotificationItem = {
    id: string;
    title: string;
    subtitle?: string;
    date?: string;
    onClick?: () => void;
};

type ClosedTaskNotificationsProps = {
    onReport: (items: NotificationItem[]) => void;
};

/**
 * jahia-ui-root parks the shell's router history on window.jahia (JahiaUiRoot.app.register.js).
 * Using it rather than useHistory keeps this component out of the router's tree, which is where
 * the notification provider mounts it -- and it degrades to a full page load if that ever moves.
 */
function openTaskBoard(): void {
    const jahia = (globalThis as unknown as {
        jahia?: {routerHistory?: {push: (path: string) => void}};
        contextJsParameters?: {contextPath?: string};
    }).jahia;

    if (jahia?.routerHistory) {
        jahia.routerHistory.push(TASKS_ROUTE);
        return;
    }

    const contextPath = (globalThis as unknown as {contextJsParameters?: {contextPath?: string}})
        .contextJsParameters?.contextPath ?? '';
    window.location.assign(`${contextPath}/jahia${TASKS_ROUTE}`);
}

/**
 * The tasks module's contribution to the profile icon's notifications: tasks the viewer raised
 * that somebody has closed since they last looked at that list.
 *
 * Renders nothing. It is mounted once by jahia-user-entries' ProfileNotificationsProvider, high
 * above the navigation, and reports what it finds -- see that module's Notifications.constants
 * for the contract.
 */
export function ClosedTaskNotifications({onReport}: Readonly<ClosedTaskNotificationsProps>) {
    // Everything the server says is closed, unfiltered. Kept apart from what is reported so the
    // "seen" events can re-filter without re-fetching.
    const [closed, setClosed] = useState<ClosedTaskAlert[]>([]);
    const [seenNow, setSeenNow] = useState<Set<string>>(() => new Set());
    // Who is looking, needed to key the seen-list. Fetched with the tasks rather than assumed
    // from contextJsParameters, so it is the same key GqlTaskBoard would use.
    const userKeyRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        callGraphQL<ClosedTaskAlertsResult>(GRAPHQL_ENDPOINT, CLOSED_TASK_ALERTS_QUERY,
            {first: CLOSED_ALERTS_WINDOW})
            .then(data => {
                userKeyRef.current = data.taskBoardCurrentUserKey;
                if (!cancelled) {
                    setClosed(data.closedCreatedByMe.edges.map(edge => edge.node));
                }
            })
            .catch(() => {
                // Swallowed: a notification that cannot be fetched is one nobody knew to expect,
                // and the shell around it has to carry on regardless.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Opening the `Tasks I've created` list is reading it: every closed task the viewer raised is
    // on screen there, in the Closed column.
    useEffect(() => onCreatedListViewed(() => {
        const userKey = userKeyRef.current;
        if (userKey) {
            rememberSeenClosedIds(userKey, closed.map(task => task.id));
        }

        setSeenNow(current => new Set([...current, ...closed.map(task => task.id)]));
    }), [closed]);

    // A task the viewer closed themselves is never news to them afterwards.
    useEffect(() => onTaskClosed(id => {
        const userKey = userKeyRef.current;
        if (userKey) {
            rememberSeenClosedIds(userKey, [id]);
        }

        setSeenNow(current => new Set([...current, id]));
    }), []);

    const report = useCallback((items: NotificationItem[]) => onReport(items), [onReport]);

    useEffect(() => {
        const userKey = userKeyRef.current;
        if (!userKey) {
            return;
        }

        // newlyClosedTasks is also what seeds a first-ever visit, so it has to run against the
        // full list; seenNow then removes the ones marked during this session.
        const unseen = newlyClosedTasks(userKey, closed).filter(task => !seenNow.has(task.id));
        report(unseen.map(task => ({
            id: task.id,
            title: task.title ?? 'Untitled task',
            subtitle: 'A task you created was closed',
            date: task.closedDate ?? undefined,
            onClick: openTaskBoard
        })));
    }, [closed, seenNow, report]);

    return null;
}

export default ClosedTaskNotifications;
