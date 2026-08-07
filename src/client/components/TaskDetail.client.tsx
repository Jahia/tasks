import {useCallback, useState} from 'react';
import {Banner, Button} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {capitalize, UPDATE_TASK_STATE_MUTATION} from './task.shared';
import type {TaskNode} from './task.shared';

type TaskDetailProps = {
    task: TaskNode;
    canModify: boolean;
    graphqlEndpoint: string;
};

export default function TaskDetail({task: initialTask, canModify, graphqlEndpoint}: Readonly<TaskDetailProps>) {
    const [task, setTask] = useState(initialTask);
    const [isBusy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const setState = useCallback(async (state: string) => {
        setBusy(true);
        setError(null);
        try {
            await callGraphQL(graphqlEndpoint, UPDATE_TASK_STATE_MUTATION, {id: task.id, state});
            setTask(current => ({...current, state}));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to update this task.');
        } finally {
            setBusy(false);
        }
    }, [graphqlEndpoint, task.id]);

    return (
        <div className="task-detail__layout">
            {error && (
                <Banner title="Something went wrong" variant="danger">
                    {error}
                </Banner>
            )}
            <dl className="task-detail__fields">
                <dt>Description</dt>
                <dd>{task.description ?? '—'}</dd>
                <dt>Priority</dt>
                <dd>{capitalize(task.priority)}</dd>
                <dt>Assignee</dt>
                <dd>{task.assigneeDisplayName ?? 'Unassigned'}</dd>
                <dt>State</dt>
                <dd>{capitalize(task.state)}</dd>
            </dl>
            {canModify && task.state === 'active' && (
                <div className="task-detail__actions">
                    <Button label="Suspend" isDisabled={isBusy} onClick={() => setState('suspended')}/>
                    <Button label="Cancel" isDisabled={isBusy} onClick={() => setState('cancelled')}/>
                    <Button label="Complete" isDisabled={isBusy} onClick={() => setState('finished')}/>
                </div>
            )}
            {canModify && task.state === 'suspended' && (
                <div className="task-detail__actions">
                    <Button label="Cancel" isDisabled={isBusy} onClick={() => setState('cancelled')}/>
                    <Button label="Continue" isDisabled={isBusy} onClick={() => setState('active')}/>
                </div>
            )}
        </div>
    );
}
