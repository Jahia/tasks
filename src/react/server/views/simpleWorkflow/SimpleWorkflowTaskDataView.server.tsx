import {jahiaComponent, Island, buildEndpointUrl} from '@jahia/javascript-modules-library';
import SimpleWorkflowTaskData from '../../../../client/components/SimpleWorkflowTaskData.client';

jahiaComponent(
    {
        nodeType: 'jnt:simpleWorkflow',
        // Explicit "simpleWorkflow" view name -- this is requested by name from the taskList
        // per-task view (`<template:module view="simpleWorkflow"/>` today, its React
        // replacement in Phase 2), not resolved as the node type's default view.
        name: 'simpleWorkflow',
        componentType: 'view',
        displayName: 'Workflow task data (React)',
        priority: 10
    },
    (props, {currentNode}) => (
        <Island
            component={SimpleWorkflowTaskData}
            props={{
                id: currentNode.getIdentifier(),
                title: currentNode.getPropertyAsString('jcr:title'),
                graphqlEndpoint: buildEndpointUrl('/modules/graphql')
            }}
        />
    )
);
