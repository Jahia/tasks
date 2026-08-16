import {useCallback, useState} from 'react';
import {Banner, Button, Input} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {useTasksTranslation} from '../lib/i18n';
import {UPDATE_TASK_DATA_TITLE_MUTATION} from './simpleWorkflow.shared';

type SimpleWorkflowTaskDataProps = {
    id: string;
    title: string | null;
    graphqlEndpoint: string;
};

export default function SimpleWorkflowTaskData({id, title: initialTitle, graphqlEndpoint}: Readonly<SimpleWorkflowTaskDataProps>) {
    const {t} = useTasksTranslation();
    const [title, setTitle] = useState(initialTitle ?? '');
    const [savedTitle, setSavedTitle] = useState(initialTitle ?? '');
    const [isBusy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = useCallback(async () => {
        if (title === savedTitle) {
            return;
        }

        setBusy(true);
        setError(null);
        try {
            await callGraphQL(graphqlEndpoint, UPDATE_TASK_DATA_TITLE_MUTATION, {id, title});
            setSavedTitle(title);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('taskData.error.save', 'Unable to save this title.'));
        } finally {
            setBusy(false);
        }
    }, [graphqlEndpoint, id, title, savedTitle, t]);

    return (
        <div className="simple-workflow-task-data">
            {error && (
                <Banner role="alert" title={t('common.error.title', 'Something went wrong')} variant="danger">
                    {error}
                </Banner>
            )}
            <Input
                value={title}
                isDisabled={isBusy}
                // This box is rendered bare by the SSR view, with no <label> of its own anywhere on
                // the page, so without this it reaches assistive technology as an unnamed text
                // field. Named rather than labelled visibly: the surrounding view already titles
                // the section, and adding a second visible caption would duplicate it.
                aria-label={t('taskData.commentLabel', 'Workflow task comment')}
                onChange={event => setTitle(event.target.value)}
                onBlur={save}
            />
            <Button label={t('common.actions.save', 'Save')} isDisabled={isBusy || title === savedTitle} onClick={save}/>
        </div>
    );
}
