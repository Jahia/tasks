import {useCallback, useState} from 'react';
import {Banner, Button} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {useTasksTranslation} from '../lib/i18n';
import {priorityLabel, stateLabel, UPDATE_TASK_STATE_MUTATION} from './task.shared';
import type {TaskNode} from './task.shared';

type TaskDetailProps = {
    task: TaskNode;
    canModify: boolean;
    graphqlEndpoint: string;
};

export default function TaskDetail({task: initialTask, canModify, graphqlEndpoint}: Readonly<TaskDetailProps>) {
    const {t} = useTasksTranslation();
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
            setError(e instanceof Error ? e.message : t('detail.error.update', 'Unable to update this task.'));
        } finally {
            setBusy(false);
        }
    }, [graphqlEndpoint, task.id, t]);

    return (
        <div className="task-detail__layout">
            {error && (
                // Assertive live region: this only ever appears in response to a button the user
                // just pressed, and now carries the server's real reason for refusing it (#62).
                <Banner role="alert" title={t('common.error.title', 'Something went wrong')} variant="danger">
                    {error}
                </Banner>
            )}
            <dl className="task-detail__fields">
                <dt>{t('detail.fields.description', 'Description')}</dt>
                <dd>{task.description ?? '—'}</dd>
                <dt>{t('detail.fields.priority', 'Priority')}</dt>
                <dd>{priorityLabel(t, task.priority)}</dd>
                <dt>{t('detail.fields.assignee', 'Assignee')}</dt>
                <dd>{task.assigneeDisplayName ?? t('common.unassigned', 'Unassigned')}</dd>
                <dt>{t('detail.fields.state', 'State')}</dt>
                <dd>{stateLabel(t, task.state)}</dd>
            </dl>
            {canModify && task.state === 'active' && (
                <div className="task-detail__actions">
                    <Button label={t('common.actions.suspend', 'Suspend')} isDisabled={isBusy} onClick={() => setState('suspended')}/>
                    <Button label={t('common.actions.cancel', 'Cancel')} isDisabled={isBusy} onClick={() => setState('cancelled')}/>
                    <Button label={t('common.actions.complete', 'Complete')} isDisabled={isBusy} onClick={() => setState('finished')}/>
                </div>
            )}
            {canModify && task.state === 'suspended' && (
                <div className="task-detail__actions">
                    <Button label={t('common.actions.cancel', 'Cancel')} isDisabled={isBusy} onClick={() => setState('cancelled')}/>
                    <Button label={t('common.actions.continue', 'Continue')} isDisabled={isBusy} onClick={() => setState('active')}/>
                </div>
            )}
        </div>
    );
}
