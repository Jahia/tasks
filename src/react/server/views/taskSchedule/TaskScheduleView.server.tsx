import {jahiaComponent, useGQLQuery, getNodesByJCRQuery} from '@jahia/javascript-modules-library';
import type {JCRNodeWrapper} from 'org.jahia.services.content';

// Escapes a value for safe interpolation into a JCR-SQL2 string literal (doubles single quotes) --
// mirrors functions:sqlencode from the legacy JSP / JCRContentUtils.sqlEncode server-side.
function sqlEncode(value: string): string {
    return value.replace(/'/g, "''");
}

type ScheduleTaskFields = {
    id: string;
    title: string | null;
    dueDate: string | null;
    state: string | null;
    owner: string | null;
    isAssignableToMe: boolean;
    targetNode: {url: string} | null;
};

type WorkflowActivityEntry = {
    label: string | null;
    dueDate: string | null;
    endTime: string | null;
    targetNode: {url: string} | null;
};

type ScheduleQueryResult = {
    workflowActivity: {
        activeTasks: WorkflowActivityEntry[];
        history: WorkflowActivityEntry[];
    };
    taskBoardCurrentUserKey: string;
    [aliasedTaskField: string]: unknown;
};

type ScheduleEntry = {
    date: number;
    label: string;
    url: string | null;
    kind: 'task' | 'active' | 'history';
};

jahiaComponent(
    {
        nodeType: 'jnt:taskSchedule',
        name: 'default',
        componentType: 'view',
        displayName: 'Task schedule (React)',
        // Higher than the module's legacy .jsp default view, so this one wins.
        priority: 10
    },
    (props, {currentNode, mainNode, jcrSession}) => {
        // Mirrors uiComponents:getBindedComponent(currentNode, renderContext, 'j:bindedComponent') --
        // an explicitly bound component if configured, otherwise the current page's main resource.
        let boundNode: JCRNodeWrapper = mainNode;
        if (currentNode.hasProperty('j:bindedComponent')) {
            try {
                boundNode = currentNode.getProperty('j:bindedComponent').getNode() as JCRNodeWrapper;
            } catch {
                // Weak reference target no longer exists -- fall back to the main resource.
            }
        }

        const now = new Date();
        const startDate = new Date(now.getTime() - (14 * 24 * 60 * 60 * 1000));
        const endDate = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
        const nowISO = now.toISOString();
        const startISO = startDate.toISOString();
        const endISO = endDate.toISOString();

        // Overdue-or-due-today tasks (excluding already-finished ones) plus upcoming tasks --
        // same window and exclusion as taskSchedule.jsp. Ownership/candidate scoping (only tasks
        // assigned to, or eligible-candidate for, the current viewer) happens below via the
        // existing isAssignableToMe/owner GraphQL fields rather than as JCR-SQL2, since that
        // reuses TaskAuthorizationService's own (already candidate/group-aware) logic instead of
        // re-deriving group membership here.
        const statement = `select * from [jnt:task] as t where isdescendantnode(t, ['${sqlEncode(boundNode.getPath())}'])
            and ((
                [dueDate] is not null and [dueDate] > '${startISO}' and [dueDate] <= '${nowISO}' and t.state <> 'finished'
            ) or (
                [dueDate] is not null and [dueDate] > '${nowISO}' and [dueDate] <= '${endISO}'
            ))`;
        const candidateTasks = getNodesByJCRQuery(jcrSession, statement, -1);
        const taskIds = candidateTasks.map(task => task.getIdentifier());

        const taskFieldsQuery = candidateTasks
            .map((task, index) => `t${index}: task(id: "${task.getIdentifier()}") {
                id title dueDate state owner isAssignableToMe targetNode { url }
            }`)
            .join('\n');

        const {data} = useGQLQuery({
            query: `
                query TaskSchedule($workflowPath: String!) {
                    ${taskFieldsQuery}
                    workflowActivity(path: $workflowPath) {
                        activeTasks { label dueDate targetNode { url } }
                        history { label endTime targetNode { url } }
                    }
                    taskBoardCurrentUserKey
                }
            `,
            variables: {workflowPath: mainNode.getPath()}
        });
        const result = data as ScheduleQueryResult;

        const entries: ScheduleEntry[] = [];

        taskIds.forEach((id, index) => {
            const task = result[`t${index}`] as ScheduleTaskFields | undefined;
            if (!task || !task.dueDate) {
                return;
            }

            if (task.owner === result.taskBoardCurrentUserKey || task.isAssignableToMe) {
                entries.push({
                    date: new Date(task.dueDate).getTime(),
                    label: task.title ?? 'Untitled task',
                    url: task.targetNode?.url ?? null,
                    kind: 'task'
                });
            }
        });

        for (const active of result.workflowActivity.activeTasks) {
            if (active.dueDate) {
                const time = new Date(active.dueDate).getTime();
                if (time > startDate.getTime() && time <= endDate.getTime()) {
                    entries.push({date: time, label: active.label ?? 'Task', url: active.targetNode?.url ?? null, kind: 'active'});
                }
            }
        }

        for (const historyEntry of result.workflowActivity.history) {
            if (historyEntry.endTime) {
                const time = new Date(historyEntry.endTime).getTime();
                if (time >= now.getTime() && time <= endDate.getTime()) {
                    entries.push({date: time, label: historyEntry.label ?? 'Completed', url: historyEntry.targetNode?.url ?? null, kind: 'history'});
                }
            }
        }

        entries.sort((a, b) => a.date - b.date);

        if (entries.length === 0) {
            return <div className="task-schedule task-schedule--empty">No upcoming tasks.</div>;
        }

        return (
            <ul className="task-schedule">
                {entries.map((entry, index) => (
                    <li key={index} className={`task-schedule__entry task-schedule__entry--${entry.kind}`}>
                        <span className="task-schedule__date">{new Date(entry.date).toLocaleDateString()}</span>
                        {entry.url ? <a href={entry.url}>{entry.label}</a> : <span>{entry.label}</span>}
                    </li>
                ))}
            </ul>
        );
    }
);
