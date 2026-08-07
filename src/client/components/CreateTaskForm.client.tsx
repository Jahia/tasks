import {useCallback, useState} from 'react';
import {Banner, Button, Dropdown, Input, Modal, Textarea} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {CREATE_TASK_MUTATION} from './taskList.shared';

type CreateTaskFormProps = {
    parentPath: string;
    title: string;
    taskType: string | null;
    useDescription: boolean;
    usePriority: boolean;
    useAssignee: boolean;
    useDueDate: boolean;
    findUserRoles: string[];
    mainResourcePath: string;
    graphqlEndpoint: string;
};

// Matches the priority choicelist declared on jnt:task in definitions.cnd.
const PRIORITY_OPTIONS = [
    {label: 'Low', value: 'low'},
    {label: 'Normal', value: 'normal'},
    {label: 'High', value: 'high'}
];

type FoundUser = {
    username: string;
    userKey: string;
    'j:firstName'?: string;
    'j:lastName'?: string;
};

function userDisplayName(user: FoundUser): string {
    const name = [user['j:firstName'], user['j:lastName']].filter(Boolean).join(' ');
    return name.length > 0 ? `${name} (${user.username})` : user.username;
}

export default function CreateTaskForm({
    parentPath,
    title,
    taskType,
    useDescription,
    usePriority,
    useAssignee,
    useDueDate,
    findUserRoles,
    mainResourcePath,
    graphqlEndpoint
}: Readonly<CreateTaskFormProps>) {
    const [isOpen, setOpen] = useState(false);
    const [isBusy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [taskTitle, setTaskTitle] = useState('');
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState('normal');
    const [dueDate, setDueDate] = useState('');
    const [assigneeQuery, setAssigneeQuery] = useState('');
    const [assigneeUserKey, setAssigneeUserKey] = useState('');
    const [suggestions, setSuggestions] = useState<FoundUser[]>([]);

    const searchAssignee = useCallback(async (q: string) => {
        setAssigneeQuery(q);
        setAssigneeUserKey('');
        if (q.length === 0) {
            setSuggestions([]);
            return;
        }

        const params = new URLSearchParams({q: `${q}*`, limit: '10'});
        if (findUserRoles.length > 0) {
            params.set('node', mainResourcePath);
            params.set('roles', findUserRoles.join(' '));
        }

        try {
            const response = await fetch(`/cms/findUser?${params.toString()}`);
            if (response.ok) {
                setSuggestions(await response.json() as FoundUser[]);
            }
        } catch {
            // legacy-find-users isn't accessible -- degrade to no suggestions, still lets the
            // form be submitted without an assignee.
            setSuggestions([]);
        }
    }, [findUserRoles, mainResourcePath]);

    const submit = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            await callGraphQL(graphqlEndpoint, CREATE_TASK_MUTATION, {
                parentPath,
                taskType,
                title: taskTitle,
                description: useDescription ? description : undefined,
                priority: usePriority ? priority : undefined,
                assigneeUserKey: useAssignee ? assigneeUserKey : undefined,
                dueDate: useDueDate ? dueDate : undefined
            });
            // Matches the legacy form's jcrRedirectTo full-page reload -- the simplest way for any
            // task list elsewhere on this page to pick up the newly created task.
            globalThis.location.reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to create this task.');
            setBusy(false);
        }
    }, [graphqlEndpoint, parentPath, taskType, taskTitle, description, useDescription, priority, usePriority,
        assigneeUserKey, useAssignee, dueDate, useDueDate]);

    return (
        <>
            <Button label={title} onClick={() => setOpen(true)}/>
            <Modal isOpen={isOpen} onOpenChange={setOpen} size="small">
                <div className="create-task-form">
                    <h3>{title}</h3>
                    {error && (
                        <Banner title="Something went wrong" variant="danger">
                            {error}
                        </Banner>
                    )}
                    <Input
                        placeholder="Title"
                        value={taskTitle}
                        isDisabled={isBusy}
                        onChange={event => setTaskTitle(event.target.value)}
                    />
                    {useDescription && (
                        <Textarea
                            placeholder="Description"
                            value={description}
                            isDisabled={isBusy}
                            onChange={event => setDescription(event.target.value)}
                        />
                    )}
                    {usePriority && (
                        <Dropdown
                            data={PRIORITY_OPTIONS}
                            value={priority}
                            isDisabled={isBusy}
                            onChange={(_event, item) => setPriority(item.value ?? 'normal')}
                        />
                    )}
                    {useAssignee && (
                        <div className="create-task-form__assignee">
                            <Input
                                placeholder="Assignee"
                                value={assigneeQuery}
                                isDisabled={isBusy}
                                onChange={event => searchAssignee(event.target.value)}
                            />
                            {suggestions.length > 0 && (
                                <ul className="create-task-form__assignee-suggestions">
                                    {suggestions.map(user => (
                                        <li key={user.userKey}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setAssigneeUserKey(user.userKey);
                                                    setAssigneeQuery(userDisplayName(user));
                                                    setSuggestions([]);
                                                }}
                                            >
                                                {userDisplayName(user)}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                    {useDueDate && (
                        <input
                            type="datetime-local"
                            disabled={isBusy}
                            value={dueDate}
                            onChange={event => setDueDate(event.target.value)}
                        />
                    )}
                    <Button
                        label="Submit"
                        isDisabled={isBusy || taskTitle.length === 0}
                        onClick={submit}
                    />
                </div>
            </Modal>
        </>
    );
}
