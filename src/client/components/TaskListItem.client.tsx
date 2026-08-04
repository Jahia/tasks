import type {MutableRefObject} from 'react';
import {useCallback, useRef, useState} from 'react';
import {Banner, Button, Menu, MenuItem, MoreVert} from '@jahia/moonstone';
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

export default function TaskListItem({task: initialTask, currentUserKey, canReviewAll, graphqlEndpoint}: TaskListItemProps) {
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

    // Mirrors task.taskList.jsp: every action except "Assign to me" requires being the current
    // assignee, unless the viewer can review all tasks (same gating as TaskBoard's ActionsCell) --
    // a UX nicety, not a guard; every mutation independently re-checks authorization server-side.
    const canAct = task.owner === currentUserKey || canReviewAll;
    const actions: MenuAction[] = [];

    if (task.state === 'active' && task.isAssignableToMe) {
        actions.push({label: 'Assign to me', mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}, patch: {owner: currentUserKey}});
    }

    if (canAct && (task.state === 'active' || task.state === 'started' || task.state === 'suspended')) {
        actions.push({label: 'Refuse', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}, patch: {state: 'active', owner: ''}});
    }

    if (canAct && task.state === 'active') {
        actions.push({label: 'Start', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'started'}, patch: {state: 'started'}});
    }

    if (canAct && task.state === 'started') {
        actions.push({label: 'Suspend', mutation: SUSPEND_TASK_MUTATION, variables: {id: task.id}, patch: {state: 'suspended'}});
        if (task.possibleOutcomes.length > 0) {
            for (const outcome of task.possibleOutcomes) {
                actions.push({
                    label: outcome,
                    mutation: COMPLETE_TASK_MUTATION,
                    variables: {id: task.id, outcome},
                    patch: {state: 'finished'}
                });
            }
        } else {
            actions.push({label: 'Completed', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'finished'}, patch: {state: 'finished'}});
        }
    }

    if (canAct && task.state === 'suspended') {
        actions.push({label: 'Continue', mutation: RESUME_TASK_MUTATION, variables: {id: task.id}, patch: {state: 'started'}});
    }

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
                    icon={<MoreVert/>}
                    variant="ghost"
                    size="small"
                    isDisabled={isBusy}
                    aria-label="Task actions"
                    onClick={() => setMenuOpen(true)}
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
