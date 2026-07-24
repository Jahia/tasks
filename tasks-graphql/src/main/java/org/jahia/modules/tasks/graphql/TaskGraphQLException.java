package org.jahia.modules.tasks.graphql;

/**
 * Unchecked wrapper for a checked JCR {@code RepositoryException} raised while
 * resolving a task-board GraphQL field -- lets field getters stay usable as
 * plain method references (e.g. in stream pipelines) without a throws clause.
 */
public class TaskGraphQLException extends RuntimeException {

    public TaskGraphQLException(String message) {
        super(message);
    }

    public TaskGraphQLException(String message, Throwable cause) {
        super(message, cause);
    }
}
