import {useCallback, useState} from 'react';
import {Banner, Button, Input} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {UPDATE_TASK_DATA_TITLE_MUTATION} from './simpleWorkflow.shared';

type SimpleWorkflowTaskDataProps = {
    id: string;
    title: string | null;
    graphqlEndpoint: string;
};

export default function SimpleWorkflowTaskData({id, title: initialTitle, graphqlEndpoint}: SimpleWorkflowTaskDataProps) {
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
            setError(e instanceof Error ? e.message : 'Unable to save this title.');
        } finally {
            setBusy(false);
        }
    }, [graphqlEndpoint, id, title, savedTitle]);

    return (
        <div className="simple-workflow-task-data">
            {error && (
                <Banner title="Something went wrong" variant="danger">
                    {error}
                </Banner>
            )}
            <Input
                value={title}
                isDisabled={isBusy}
                onChange={event => setTitle(event.target.value)}
                onBlur={save}
            />
            <Button label="Save" isDisabled={isBusy || title === savedTitle} onClick={save}/>
        </div>
    );
}
