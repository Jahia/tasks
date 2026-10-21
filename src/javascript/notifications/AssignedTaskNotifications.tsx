import {useCallback, useEffect, useState} from 'react';
import {callGraphQL} from '../../client/lib/graphqlClient';
import {
    ASSIGNED_ALERTS_WINDOW,
    ASSIGNED_TASK_ALERTS_QUERY,
    onTaskChanged,
    tasksAssignedByOthers
} from '../../client/lib/assignedTaskAlerts';
import type {AssignedTaskAlertsResult} from '../../client/lib/assignedTaskAlerts';
import {openTaskBoard} from './ClosedTaskNotifications';

const GRAPHQL_ENDPOINT = '/modules/graphql';

type NotificationItem = {
    id: string;
    title: string;
    subtitle?: string;
    date?: string;
    onClick?: () => void;
};

type AssignedTaskNotificationsProps = {
    onReport: (items: NotificationItem[]) => void;
};

/** The viewer's user name, to recognise a task they raised for themselves. */
function currentUserName(): string | null {
    return (globalThis as unknown as {contextJsParameters?: {user?: {username?: string}}})
        .contextJsParameters?.user?.username ?? null;
}

/**
 * The tasks module's second contribution to the profile icon's notifications: every task somebody
 * else assigned to the viewer that is still waiting to be started.
 *
 * Renders nothing. Mounted once by jahia-user-entries' ProfileNotificationsProvider, like
 * ClosedTaskNotifications. Asks the server on mount and again whenever the board changes a task.
 */
export function AssignedTaskNotifications({onReport}: Readonly<AssignedTaskNotificationsProps>) {
    // Bumped by every task change the board announces, to ask the server again.
    const [generation, setGeneration] = useState(0);

    useEffect(() => onTaskChanged(() => setGeneration(current => current + 1)), []);

    const report = useCallback((items: NotificationItem[]) => onReport(items), [onReport]);

    useEffect(() => {
        let cancelled = false;
        callGraphQL<AssignedTaskAlertsResult>(GRAPHQL_ENDPOINT, ASSIGNED_TASK_ALERTS_QUERY,
            {first: ASSIGNED_ALERTS_WINDOW})
            .then(data => {
                if (cancelled) {
                    return;
                }

                const assigned = tasksAssignedByOthers(currentUserName(), data.activeAssignedToMe.edges.map(edge => edge.node));
                report(assigned.map(task => ({
                    id: task.id,
                    title: task.title ?? 'Untitled task',
                    subtitle: task.creator ? `Assigned to you by ${task.creator}` : 'Assigned to you',
                    date: task.createdDate ?? undefined,
                    onClick: openTaskBoard
                })));
            })
            .catch(() => {
                // Swallowed, as in ClosedTaskNotifications: the shell has to carry on regardless,
                // and the last count reported stays up until the next one succeeds.
            });
        return () => {
            cancelled = true;
        };
    }, [generation, report]);

    return null;
}

export default AssignedTaskNotifications;
