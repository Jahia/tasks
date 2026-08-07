import type {MutableRefObject} from 'react';
import {useCallback, useRef, useState} from 'react';
import {Add, Banner, Button, Close, Menu, MenuItem} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {
    ASSIGN_TASK_TO_ME_MUTATION,
    COMPLETE_TASK_MUTATION,
    RESUME_TASK_MUTATION,
    SUSPEND_TASK_MUTATION,
    UNASSIGN_TASK_MUTATION
} from './taskBoard.shared';
import {UPDATE_TASK_STATE_MUTATION} from './task.shared';
import type {TaskNode} from './task.shared';

type TaskListItemProps = {
    task: TaskNode;
    currentUserKey: string;
    canReviewAll: boolean;
    graphqlEndpoint: string;
};

type MenuAction = {
    label: string;
    mutation: string;
    variables: {id: string} & Record<string, unknown>;
    patch: Partial<TaskNode>;
};

// Split out of buildActions below so the "started" branch's outcome-vs-fallback decision
// doesn't add its own loop+if nesting to that function's cognitive complexity.
function buildCompletionActions(task: TaskNode): MenuAction[] {
    if (task.possibleOutcomes.length > 0) {
        return task.possibleOutcomes.map(outcome => ({
            label: outcome,
            mutation: COMPLETE_TASK_MUTATION,
            variables: {id: task.id, outcome},
            patch: {state: 'finished'}
        }));
    }

    return [{label: 'Completed', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'finished'}, patch: {state: 'finished'}}];
}

// Mirrors task.taskList.jsp: every action except "Assign to me" requires being the current
// assignee, unless the viewer can review all tasks (same gating as TaskBoard's ActionsCell) --
// a UX nicety, not a guard; every mutation independently re-checks authorization server-side.
function buildActions(task: TaskNode, canAct: boolean, currentUserKey: string): MenuAction[] {
    const actions: MenuAction[] = [];

    if (task.state === 'active' && task.isAssignableToMe) {
        actions.push({label: 'Assign to me', mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}, patch: {owner: currentUserKey}});
    }

    // Matches TaskBoard.client.tsx's TaskActions: a suspended task can only be resumed, not
    // unassigned directly -- Refuse is only offered while active or started.
    if (canAct && (task.state === 'active' || task.state === 'started')) {
        actions.push({label: 'Refuse', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}, patch: {state: 'active', owner: ''}});
    }

    if (canAct && task.state === 'active') {
        actions.push({label: 'Start', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'started'}, patch: {state: 'started'}});
    }

    if (canAct && task.state === 'started') {
        actions.push({label: 'Suspend', mutation: SUSPEND_TASK_MUTATION, variables: {id: task.id}, patch: {state: 'suspended'}});
        actions.push(...buildCompletionActions(task));
    }

    if (canAct && task.state === 'suspended') {
        actions.push({label: 'Continue', mutation: RESUME_TASK_MUTATION, variables: {id: task.id}, patch: {state: 'started'}});
    }

    return actions;
}

export default function TaskListItem({task: initialTask, currentUserKey, canReviewAll, graphqlEndpoint}: Readonly<TaskListItemProps>) {
    const [task, setTask] = useState(initialTask);
    const [isBusy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isMenuOpen, setMenuOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement>(null);

    const runAction = useCallback(async (action: MenuAction) => {
        setBusy(true);
        setError(null);
        setMenuOpen(false);
        try {
            await callGraphQL(graphqlEndpoint, action.mutation, action.variables);
            setTask(current => ({...current, ...action.patch}));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to complete this action.');
        } finally {
            setBusy(false);
        }
    }, [graphqlEndpoint]);

    const canAct = task.owner === currentUserKey || canReviewAll;
    const actions = buildActions(task, canAct, currentUserKey);

    // Menu requires each top-level child to be a single MenuItem element -- its internal
    // auto-search-threshold check (Menu.tsx) does `children[0].props[...]`, which throws if
    // children[0] is itself an array (e.g. the direct result of actions.map(...) placed
    // alongside a sibling JSX expression). Building one flat array up front, instead of a
    // ternary/&& mix of JSX expressions as Menu's children, keeps every child a plain element.
    const menuItems = actions.length === 0
        ? [<MenuItem key="none" label="No actions available" isDisabled/>]
        : actions.map((action, index) => (
            <MenuItem
                key={`${index}-${action.label}`}
                label={action.label}
                onClick={() => runAction(action)}
            />
        ));

    if (task.targetNode?.url) {
        menuItems.push(
            <MenuItem
                key="preview"
                label="Preview"
                onClick={() => {
                    setMenuOpen(false);
                    window.open(task.targetNode!.url, '_blank', 'noopener,noreferrer');
                }}
            />
        );
    }

    return (
        <div className="task-list-item__row">
            {error && (
                <Banner title="Something went wrong" variant="danger">
                    {error}
                </Banner>
            )}
            <p className="task-list-item__title">{task.title ?? 'Untitled task'}</p>
            {task.description && <p className="task-list-item__description">{task.description}</p>}
            {task.state === 'finished' && <p className="task-list-item__completed">Completed</p>}
            <div ref={anchorRef}>
                <Button
                    icon={isMenuOpen ? <Close/> : <Add/>}
                    variant={isMenuOpen ? 'default' : 'ghost'}
                    size="small"
                    isDisabled={isBusy}
                    aria-label={isMenuOpen ? 'Hide task actions' : 'Show task actions'}
                    onClick={() => setMenuOpen(open => !open)}
                />
            </div>
            <Menu
                isDisplayed={isMenuOpen}
                anchorEl={anchorRef as MutableRefObject<HTMLDivElement>}
                onClose={() => setMenuOpen(false)}
            >
                {menuItems}
            </Menu>
        </div>
    );
}
