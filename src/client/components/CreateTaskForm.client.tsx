import {useCallback, useState} from 'react';
import {Banner, Button, Dropdown, Input, Modal, Textarea} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {useTasksTranslation} from '../lib/i18n';
import {priorityLabel} from './task.shared';
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

// Matches the priority choicelist declared on jnt:task in definitions.cnd. The stored VALUES are
// the contract with the server and never change; only the labels are localized -- through the same
// common.priority.* keys the board and the detail view read, so one task's priority cannot read
// three different ways in three places.
const PRIORITY_VALUES = ['low', 'normal', 'high'];

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
    const {t} = useTasksTranslation();
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

    const titleLabel = t('create.fields.title', 'Title');
    const descriptionLabel = t('create.fields.description', 'Description');
    const assigneeLabel = t('create.fields.assignee', 'Assignee');
    const priorityOptions = PRIORITY_VALUES.map(value => ({
        label: priorityLabel(t, value),
        value
    }));

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
            setError(e instanceof Error ? e.message : t('create.error.create', 'Unable to create this task.'));
            setBusy(false);
        }
    }, [t, graphqlEndpoint, parentPath, taskType, taskTitle, description, useDescription, priority, usePriority,
        assigneeUserKey, useAssignee, dueDate, useDueDate]);

    return (
        <>
            <Button label={title} onClick={() => setOpen(true)}/>
            <Modal isOpen={isOpen} onOpenChange={setOpen} size="small">
                <div className="create-task-form">
                    <h3>{title}</h3>
                    {error && (
                        <Banner role="alert" title={t('common.error.title', 'Something went wrong')} variant="danger">
                            {error}
                        </Banner>
                    )}
                    {/* Every field in this modal is placeholder-only by design (it is a four-field
                        quick-create form, not a settings page), so each placeholder is repeated as
                        the accessible name -- a placeholder alone stops being announced the moment
                        the field has a value. */}
                    <Input
                        placeholder={titleLabel}
                        aria-label={titleLabel}
                        value={taskTitle}
                        isDisabled={isBusy}
                        onChange={event => setTaskTitle(event.target.value)}
                    />
                    {useDescription && (
                        <Textarea
                            placeholder={descriptionLabel}
                            aria-label={descriptionLabel}
                            value={description}
                            isDisabled={isBusy}
                            onChange={event => setDescription(event.target.value)}
                        />
                    )}
                    {/* The priority Dropdown gets no accessible name of its own: Moonstone accepts
                        neither aria-label nor any non-deprecated labelling prop on it (its `label`
                        prop is deprecated AND replaces the selected value's own display), so the
                        only name it exposes is the selected priority. Upstream gap, left alone
                        rather than papered over with the deprecated prop. */}
                    {usePriority && (
                        <Dropdown
                            data={priorityOptions}
                            value={priority}
                            isDisabled={isBusy}
                            onChange={(_event, item) => setPriority(item.value ?? 'normal')}
                        />
                    )}
                    {useAssignee && (
                        <div className="create-task-form__assignee">
                            <Input
                                placeholder={assigneeLabel}
                                aria-label={assigneeLabel}
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
                            aria-label={t('create.fields.dueDate', 'Due date')}
                            disabled={isBusy}
                            value={dueDate}
                            onChange={event => setDueDate(event.target.value)}
                        />
                    )}
                    <Button
                        label={t('common.actions.submit', 'Submit')}
                        isDisabled={isBusy || taskTitle.length === 0}
                        onClick={submit}
                    />
                </div>
            </Modal>
        </>
    );
}
